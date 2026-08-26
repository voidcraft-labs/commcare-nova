// lib/case-store/submission.ts
//
// The atomic submission envelope's public contract — the argument and
// result shapes `CaseStore.applySubmission` speaks. One envelope is one
// whole form submission: the ordinary form action (registration primary
// plus children, followup update plus children, close including final
// writes) and the advanced case-operation program execute inside ONE
// Postgres transaction from one pre-submission snapshot, mirroring how
// formplayer commits a submission's case blocks with the HQ POST as a
// single transaction. There is no partial success: any failure rolls the
// entire submission back with a typed error
// (`SubmissionRejectedError` for operation-contract rejections, the
// existing typed error classes for ordinary-write failures).
//
// The operation program carries AUTHORED expressions, not evaluated
// values. The executor evaluates every target, condition, and value
// in-transaction through the AST→Kysely compiler — the case store's one
// evaluator — anchored on the loaded session case, before any DML.
// The caller supplies the doc-level analysis this package cannot
// derive (the blueprint never crosses this boundary): inherited
// conditional guards and immutable expression snapshot types from
// `lib/doc/caseOperationOrder.ts`, plus the physical multiplicity
// scopes with their per-iteration form-answer bindings.

import type {
	CaptureFieldKind,
	CaseOperation,
	CaseType,
	OrganizationLevel,
	Uuid,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { LookupTableSchemas } from "./sql/compileLookup";
import type { JsonObject } from "./sql/database";
import type { DeviceCaseDatabase } from "./store";

/**
 * One case row the ordinary form action creates. `caseName` stays
 * optional in the shape because the walker plucks it from the form's
 * `case_name` leaf — the executor throws the canonical compiler-bug
 * invariant when it is absent, since `cases.case_name` is NOT NULL and
 * a valid blueprint always carries the name leaf.
 */
export interface SubmissionCaseSeed {
	readonly caseType: string;
	readonly caseName?: string;
	readonly externalId?: string;
	readonly properties: JsonObject;
	/** Server-derived from the committed child case type. Present only when
	 * this seed is linked to an ordinary form's parent case. */
	readonly parentRelationship?: NonNullable<CaseType["relationship"]>;
}

/**
 * The ordinary (non-operation) half of a submission — the existing
 * four form types' case effects, executed AFTER the operation program
 * (advanced effects precede the ordinary FormActions block in wire
 * document order, and the executor mirrors that).
 *
 *   - `registration` — insert the primary plus every child. Children take the
 *     primary's generated id as `parent_case_id` and never carry their own.
 *   - `followup` / `close` — update the bound case, insert each child
 *     with its pre-bound `parentCaseId`; `close` stamps the lifecycle
 *     transition LAST, after every property write.
 *   - `none` — a submission with no ordinary case effect (a survey
 *     form, or a future operations-only submission).
 */
export type OrdinarySubmissionAction =
	| {
			readonly kind: "registration";
			readonly primary: SubmissionCaseSeed;
			readonly children: ReadonlyArray<SubmissionCaseSeed>;
	  }
	| {
			readonly kind: "followup" | "close";
			readonly caseId: string;
			/**
			 * The module case type the form was authored against. When present
			 * and the action is type-sensitive (a property patch, a name
			 * write, or a child's parent link), the rolling type proof folds
			 * the ordinary action as its final implicit step, so an advanced
			 * retype away from the authored type rejects the envelope — the
			 * runtime twin of the static analysis's `ordinary` slot. A
			 * write-free, child-free close stays type-blind either way.
			 */
			readonly caseType?: string;
			readonly patch: {
				readonly caseName?: string;
				readonly externalId?: string;
				readonly properties: JsonObject;
			};
			readonly children: ReadonlyArray<
				SubmissionCaseSeed & { readonly parentCaseId: string }
			>;
	  }
	| { readonly kind: "none" };

export interface SubmissionReceiptIdentity {
	readonly entryKey: string;
	readonly formUuid: Uuid;
	readonly requestDigest: string;
}

/**
 * The durable claim for one new form entry.
 *
 * `expectedAppMutationSeq` is a fresh-claim fence, not part of replay
 * identity: an exact retry still replays after unrelated topology changes,
 * while a first acceptance cannot execute a program derived from a stale
 * committed blueprint.
 */
export interface SubmissionReceiptClaim extends SubmissionReceiptIdentity {
	readonly expectedAppMutationSeq: number;
	/** Digest of the exact committed Blueprint whose after-submit topology the
	 * client may evaluate when this receipt is returned or replayed. */
	readonly blueprintDigest: string;
}

/**
 * Per-iteration runtime bindings for one physical execution of a
 * multiplicity scope. `formFields` is COMPLETE for the iteration: it
 * carries every field value visible to expressions evaluated there —
 * root answers, enclosing-repeat answers resolved for this concrete
 * instance, and the scope's own iteration answers — keyed by stable
 * field uuid. Multi-select answers are the real array shape; the term
 * compiler serializes them to JSONB explicitly.
 */
export interface OperationIterationBindings {
	readonly formFields: ReadonlyMap<Uuid, string | readonly string[]>;
}

/**
 * One physical multiplicity scope in wire document order: the root
 * scope first (`repeat` absent, exactly one iteration), then each
 * repeat scope in post-order field traversal. A repeat scope carries
 * one entry per live iteration in instance order; the executor runs a
 * scope's operations iteration-major (all of iteration 1's operations,
 * then iteration 2's), matching how JavaRosa walks the submitted
 * instance's repeated operation groups.
 */
export interface OperationScopeIterations {
	/** Absent = the root scope. */
	readonly repeat?: Uuid;
	readonly iterations: ReadonlyArray<OperationIterationBindings>;
}

/**
 * One authored operation plus the doc-level analysis the executor
 * cannot derive without the blueprint.
 */
export interface EnvelopeCaseOperation {
	readonly operation: CaseOperation;
	/**
	 * Inherited producer conditions from
	 * `caseOperationConditionalGuardUuids`, resolved to their predicate
	 * ASTs by the caller. They AND with the operation's own condition;
	 * a skipped conditional create thereby suppresses every consumer of
	 * its identity, exactly as the emitted wrapper relevance does.
	 */
	readonly guardConditions: ReadonlyArray<Predicate>;
	/**
	 * Immutable pre-submission lookup types for runtime EXPRESSION
	 * targets, from `caseOperationExpressionSnapshotTypes` — kept
	 * separate from the operation's rolling semantic type after an
	 * earlier retype. `links` is keyed by the link's array index.
	 */
	readonly expressionSnapshotTypes: {
		readonly target?: string;
		readonly links: ReadonlyMap<number, string>;
	};
}

/**
 * The advanced-operation half of a submission. `operations` arrives in
 * canonical `(order, uuid)` sequence (the caller sorts via
 * `orderedCaseOperations`); the executor expands it over `scopes` into
 * physical execution order and re-proves the whole resolved sequence
 * with `validateResolvedCaseOperationTypeSequence` before any write.
 */
export interface CaseOperationProgram {
	/** The authored-key identity scope half the operations share. */
	readonly formUuid: Uuid;
	readonly operations: ReadonlyArray<EnvelopeCaseOperation>;
	readonly scopes: ReadonlyArray<OperationScopeIterations>;
	/** The loaded case a `session` target addresses; absent when the
	 * form loads none. */
	readonly sessionCaseId?: string;
	/** Schema map for expression compilation (`buildCaseTypeMap` at the
	 * caller's boundary). */
	readonly caseTypeSchemas: ReadonlyMap<string, CaseType>;
	/** Organization hierarchy used only by owner-location-at-level terms. */
	readonly organizationLevels?: Readonly<Record<string, OrganizationLevel>>;
	/**
	 * Rows-free Project-scoped lookup definitions for every carrier in this
	 * exact operation program. The server derives the target ids from the
	 * same committed blueprint that built `operations`, loads one definitions
	 * snapshot after membership authorization, and keeps this map immutable
	 * across the whole envelope (including a schema-heal retry).
	 */
	readonly lookupTableSchemas?: LookupTableSchemas;
	/** Open-namespace worker data for `sessionUser` terms; absent keys
	 * resolve blank, the device's missing-worker-data semantic. */
	readonly sessionUser?: ReadonlyMap<string, string>;
	/** Stable custom worker-information UUID → current wire slug. */
	readonly userPropertySlugs?: ReadonlyMap<string, string>;
	/** Closed-namespace context fields for `sessionContext` terms. */
	readonly sessionContext?: ReadonlyMap<string, string>;
	/** Viewer IANA timezone for `format-date` rendering parity. */
	readonly viewerTimeZone?: string;
}

export interface ApplySubmissionArgs {
	readonly appId: string;
	readonly ordinary: OrdinarySubmissionAction;
	readonly operations?: CaseOperationProgram;
	/**
	 * The worker's own record, written in the same transaction.
	 *
	 * A SIBLING of `ordinary` rather than part of it, matching the wire: HQ's
	 * `usercase_update` is a form action independent of `open_case` /
	 * `update_case` / `close_case`, so a survey form with no ordinary effect at
	 * all can still carry one — and often that is the whole point of the form.
	 *
	 * The row belongs to the submitting worker, so it is addressed by the
	 * store's own bound owner rather than by an id the caller supplies: a
	 * submission cannot write another worker's record, and there is no
	 * parameter through which it could try.
	 */
	readonly usercase?: { readonly properties: JsonObject };
	/**
	 * Every submission claims this durable entry receipt before an ordinary or
	 * advanced case effect runs, whether or not the form has attachment
	 * questions. It remains present when the current blueprint no longer has a
	 * capture question, allowing an exact retry to replay instead of bypassing
	 * idempotency.
	 */
	readonly submissionReceipt: SubmissionReceiptClaim;
	/**
	 * Server-derived form-entry identity and capture authority. When present,
	 * the case effects, exact staged-row reservation, and replay record commit
	 * in the same transaction.
	 */
	readonly captureIntent?: {
		readonly entryKey: string;
		readonly formUuid: Uuid;
		readonly expectedAppMutationSeq: number;
		readonly requestDigest: string;
		/**
		 * Exact live answer slots serialized by the engine. Names alone are
		 * insufficient authority: one entry can stage captures for several
		 * questions and repeat instances.
		 */
		readonly attachments: ReadonlyArray<{
			readonly attachmentName: string;
			readonly fieldUuid: Uuid;
			readonly instancePath: string;
		}>;
		readonly allowedAttachments: ReadonlyArray<{
			readonly fieldUuid: Uuid;
			/** Engine path with `[0]` at every authored repeat segment. */
			readonly instancePathTemplate: string;
			/** The committed question kind at the submission snapshot. */
			readonly captureKind: CaptureFieldKind;
			/**
			 * Exact immutable row metadata accepted by that committed kind.
			 * Carried across the case-store boundary so the terminal transaction
			 * need not trust the earlier confirm or re-read the blueprint.
			 */
			readonly acceptedFormats: ReadonlyArray<{
				readonly extension: string;
				readonly contentType: string;
			}>;
		}>;
	};
}

/** What one physical operation instance did — the executed plan in
 * physical order, for callers and acceptance tests. */
export interface OperationEffectRecord {
	readonly operationUuid: Uuid;
	/** Zero-based iteration within the operation's scope (0 for root). */
	readonly iteration: number;
	readonly action: CaseOperation["action"];
	readonly caseId: string;
	/** False when the instance's conditions evaluated false — no effect
	 * applied, recorded so tests can pin skip semantics. */
	readonly executed: boolean;
}

export interface SubmissionEnvelopeResult {
	/** The registration primary's generated id, or the followup/close
	 * bound case id. Absent for `kind: "none"`. */
	readonly primaryCaseId?: string;
	/** Ordinary children's generated ids in input order. */
	readonly childCaseIds: ReadonlyArray<string>;
	readonly operations: ReadonlyArray<OperationEffectRecord>;
	/** Submission-time topology identity. Optional only for historical receipts
	 * written before routing revision replay was fenced. */
	readonly blueprintDigest?: string;
	/** Exact affected rows and direct index edges read after every envelope
	 * effect but before the transaction commits. It is persisted in the durable
	 * receipt so an exact replay observes the submission's own post-write device
	 * state rather than whatever a later writer changed the rows to. Historical
	 * receipts predate this slot, so the parser keeps it optional. */
	readonly caseDatabasePatch?: DeviceCaseDatabase;
}

/** Parse the JSONB representation stored on an accepted receipt. Keeping this
 * at the submission-contract boundary makes the server preflight and the
 * terminal Postgres transaction apply the same corruption check. */
export function parseSubmissionEnvelopeResult(
	value: unknown,
): SubmissionEnvelopeResult {
	const parsed =
		typeof value === "string" ? (JSON.parse(value) as unknown) : value;
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray((parsed as { childCaseIds?: unknown }).childCaseIds) ||
		!Array.isArray((parsed as { operations?: unknown }).operations) ||
		("caseDatabasePatch" in parsed &&
			((parsed as { caseDatabasePatch?: unknown }).caseDatabasePatch === null ||
				typeof (parsed as { caseDatabasePatch?: unknown }).caseDatabasePatch !==
					"object" ||
				!Array.isArray(
					(
						parsed as {
							caseDatabasePatch?: { rows?: unknown };
						}
					).caseDatabasePatch?.rows,
				) ||
				!Array.isArray(
					(
						parsed as {
							caseDatabasePatch?: { indices?: unknown };
						}
					).caseDatabasePatch?.indices,
				) ||
				hasInvalidCaseDatabasePropertyTypes(
					(parsed as { caseDatabasePatch?: unknown }).caseDatabasePatch,
				))) ||
		("primaryCaseId" in parsed &&
			(parsed as { primaryCaseId?: unknown }).primaryCaseId !== undefined &&
			typeof (parsed as { primaryCaseId?: unknown }).primaryCaseId !==
				"string") ||
		("blueprintDigest" in parsed &&
			(typeof (parsed as { blueprintDigest?: unknown }).blueprintDigest !==
				"string" ||
				!/^[a-f0-9]{64}$/.test(
					(parsed as { blueprintDigest: string }).blueprintDigest,
				)))
	) {
		throw new Error(
			"A committed form submission replay row contains an invalid result.",
		);
	}
	const result = parsed as SubmissionEnvelopeResult;
	if (result.caseDatabasePatch === undefined) {
		return result;
	}
	return {
		...result,
		caseDatabasePatch: {
			...result.caseDatabasePatch,
			rows: result.caseDatabasePatch.rows.map((row) => ({
				...row,
				opened_on: receiptTimestamp(row.opened_on),
				modified_on: receiptTimestamp(row.modified_on),
				closed_on: receiptTimestamp(row.closed_on),
			})),
		},
	};
}

function hasInvalidCaseDatabasePropertyTypes(patch: unknown): boolean {
	if (typeof patch !== "object" || patch === null) return false;
	if (!("propertyTypes" in patch)) return false;
	const propertyTypes = (patch as { propertyTypes?: unknown }).propertyTypes;
	return (
		typeof propertyTypes !== "object" ||
		propertyTypes === null ||
		Array.isArray(propertyTypes)
	);
}

/** JSONB returns timestamps as strings, while every live CaseStore path uses
 * `Date`. Rehydrate the persisted transaction snapshot so a durable replay is
 * observably identical to the first accepted submission. */
function receiptTimestamp(value: unknown): Date | null {
	if (value === null) {
		return null;
	}
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed;
		}
	}
	throw new Error(
		"A committed form submission replay row contains an invalid timestamp.",
	);
}

export type SubmissionReceiptVerdict =
	| { readonly kind: "new" }
	| { readonly kind: "mismatch" }
	| { readonly kind: "replay"; readonly result: SubmissionEnvelopeResult };

/** Pure receipt adjudication shared by the pre-blueprint action read and the
 * entry-locked terminal transaction. */
export function adjudicateSubmissionReceipt(
	identity: SubmissionReceiptIdentity,
	prior:
		| {
				readonly formUuid: Uuid;
				readonly requestDigest: string;
				readonly result: unknown;
		  }
		| undefined,
): SubmissionReceiptVerdict {
	if (prior === undefined) return { kind: "new" };
	if (
		prior.formUuid !== identity.formUuid ||
		prior.requestDigest !== identity.requestDigest
	) {
		return { kind: "mismatch" };
	}
	return {
		kind: "replay",
		result: parseSubmissionEnvelopeResult(prior.result),
	};
}
