// lib/case-store/submission.ts
//
// The atomic submission envelope's public contract — the argument and
// result shapes `CaseStore.applySubmission` speaks. One envelope is one
// whole form submission: every case change the form makes is an operation
// of its program, the form's own case first, as the form's array holds it.
// The program executes inside ONE Postgres transaction from one
// pre-submission snapshot, mirroring how formplayer commits a submission's
// case blocks with the HQ POST as a single transaction. There is no partial
// success: any failure rolls the entire submission back with a typed error
// (`SubmissionRejectedError` for operation-contract rejections, the
// existing typed error classes for storage failures).
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
	CasePropertyDataType,
	CaseType,
	OrganizationLevel,
	Uuid,
} from "@/lib/domain";
import type { Expression as DomainExpression } from "@/lib/domain/expression/types";
import type { LookupTableSchemas } from "./sql/compileLookup";
import type { DeviceCaseDatabase } from "./store";

/**
 * What the submission's session holds for its form type: the selected cases a
 * follow-up or close form acts on, checked against the module's selection
 * contract before any effect. Every case change, the form's own case
 * included, is an operation of the program; this arm carries no write.
 *
 *   - `registration`: the form creates its own case through the program's own
 *     arm, and selects none.
 *   - `followup` / `close`: the ordered selected cases, the selection contract
 *     they were chosen under, and the module's case type each must hold.
 *   - `none`: a survey, which selects no case.
 */
export type OrdinarySubmissionAction =
	| { readonly kind: "registration" }
	| {
			readonly kind: "followup" | "close";
			/** Ordered selected cases. A singular form supplies one id. */
			readonly caseIds: ReadonlyArray<string>;
			/** Server-derived from the committed module selection contract. */
			readonly selection:
				| { readonly kind: "single"; readonly maximum: 1 }
				| { readonly kind: "multiple"; readonly maximum: number };
			/** The module case type every selected case must hold. */
			readonly caseType: string;
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
	readonly guardConditions: ReadonlyArray<DomainExpression>;
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
	/**
	 * For each write with a `via`, keyed by the write's array index, the case
	 * type the catalog says its index chain reaches. The executor takes that
	 * type's schema lock before any effect and converts the value to that
	 * type's declared property.
	 */
	readonly viaCaseTypes?: ReadonlyMap<number, string>;
}

/**
 * The form's own case, as the program runs it: the module's case type, the
 * form's type, and the form's own open and close conditions. Present exactly
 * when `operations` holds the `own` arm.
 *
 * On a registration the own arm creates the case when `openCondition` holds
 * (absent: on every submission), and closes it after its writes when
 * `closeCondition` is present and holds. On a follow-up it updates the case
 * the form loaded. On a close form it updates that case and then closes it
 * when `closeCondition` holds (absent: on every submission).
 */
export interface OwnCaseProgram {
	readonly caseType: string;
	readonly formType: "registration" | "followup" | "close";
	readonly openCondition?: DomainExpression;
	readonly closeCondition?: DomainExpression;
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
	/**
	 * The form's operations in array order, the own arm first. The array is
	 * the wire's meaning: the validator keeps every other operation from
	 * writing, retyping or closing what the own arm writes, so running them in
	 * this order matches every placement HQ holds them in.
	 */
	readonly operations: ReadonlyArray<EnvelopeCaseOperation>;
	/** The own arm's case type, form type and conditions. */
	readonly ownCase?: OwnCaseProgram;
	/**
	 * Creates the entry's session names, by operation uuid, each with the key
	 * of the `uuid()` datum that holds its id (`new-case`,
	 * `new-child-case:<type>`): the form read that id while it ran
	 * (`lib/domain/entryCaseIdentity.ts`), so the case is created with it.
	 * Server-derived from the committed entry's datums.
	 */
	readonly entryCaseKeys?: ReadonlyMap<Uuid, string>;
	readonly scopes: ReadonlyArray<OperationScopeIterations>;
	/** The loaded case a `session` target addresses; absent when the
	 * form loads none. */
	readonly sessionCaseIds?: ReadonlyArray<string>;
	/** Schema map for expression compilation (`buildCaseTypeMap` at the
	 * caller's boundary). */
	readonly caseTypeSchemas: ReadonlyMap<string, CaseType>;
	readonly formFieldTypes?: ReadonlyMap<Uuid, CasePropertyDataType | undefined>;
	/** Organization hierarchy used only by owner-location-at-level terms. */
	readonly organizationLevels?: Readonly<Record<string, OrganizationLevel>>;
	/** The places of the worker's `locations` fixture, by id, among which an
	 * owner moved to a place resolves (`TermCompileContext.workerPlaceIds`).
	 * Present whenever an operation moves its owner to a place. */
	readonly workerPlaceIds?: readonly string[];
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
	/** Zero-based selected-case position (0 for an anchor-free program). */
	readonly selection: number;
	readonly action: CaseOperation["action"];
	readonly caseId: string;
	/** False when the instance's conditions evaluated false — no effect
	 * applied, recorded so tests can pin skip semantics. */
	readonly executed: boolean;
}

/** One concrete child a receipt written before child cases were operations
 * records.
 *
 * `authoredChildIndex` addresses the child seed of that historical ordinary
 * submission action, and `parentCaseId` the selected or generated primary
 * case the child was created under. A new submission records each child it
 * creates as an operation instance (`operations`) and writes none of these;
 * they stay readable so a historical receipt still replays. */
export interface CreatedChildCaseReceipt {
	readonly authoredChildIndex: number;
	readonly parentCaseId: string;
	readonly caseId: string;
}

export interface SubmissionEnvelopeResult {
	/** The case the registration's own arm created with the id its entry
	 * minted, the ordered followup/close selection, or an empty collection for
	 * `kind: "none"` and for a registration whose open condition did not
	 * hold. */
	readonly primaryCaseIds: ReadonlyArray<string>;
	/** A historical receipt's ordinary children; empty for a new submission,
	 * whose children are operation instances. */
	readonly createdChildren: ReadonlyArray<CreatedChildCaseReceipt>;
	/**
	 * Flat ids from a durable receipt written before `createdChildren` existed.
	 * New submissions never populate this slot. It is retained only for
	 * history/repair consumers that need concrete ids without claiming to know
	 * which authored child or parent produced them.
	 */
	readonly legacyChildCaseIds?: ReadonlyArray<string>;
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

function hasInvalidCreatedChildren(value: unknown): boolean {
	if (!Array.isArray(value)) return true;
	const pairs = new Set<string>();
	const caseIds = new Set<string>();
	for (const child of value) {
		if (
			typeof child !== "object" ||
			child === null ||
			!Number.isInteger(
				(child as { authoredChildIndex?: unknown }).authoredChildIndex,
			) ||
			(child as { authoredChildIndex: number }).authoredChildIndex < 0 ||
			typeof (child as { parentCaseId?: unknown }).parentCaseId !== "string" ||
			(child as { parentCaseId: string }).parentCaseId.length === 0 ||
			typeof (child as { caseId?: unknown }).caseId !== "string" ||
			(child as { caseId: string }).caseId.length === 0
		) {
			return true;
		}
		const receipt = child as CreatedChildCaseReceipt;
		const pair = `${receipt.authoredChildIndex}\u0000${receipt.parentCaseId}`;
		if (pairs.has(pair) || caseIds.has(receipt.caseId)) return true;
		pairs.add(pair);
		caseIds.add(receipt.caseId);
	}
	return false;
}

/** Parse the JSONB representation stored on an accepted receipt. Keeping this
 * at the submission-contract boundary makes the server preflight and the
 * terminal Postgres transaction apply the same corruption check. */
export function parseSubmissionEnvelopeResult(
	value: unknown,
): SubmissionEnvelopeResult {
	const parsed =
		typeof value === "string" ? (JSON.parse(value) as unknown) : value;
	const createdChildren =
		typeof parsed === "object" && parsed !== null
			? (parsed as { createdChildren?: unknown }).createdChildren
			: undefined;
	const historicalChildCaseIds =
		typeof parsed === "object" && parsed !== null
			? (parsed as { childCaseIds?: unknown }).childCaseIds
			: undefined;
	const hasCreatedChildren = Array.isArray(createdChildren);
	const hasHistoricalChildCaseIds = Array.isArray(historicalChildCaseIds);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		hasCreatedChildren === hasHistoricalChildCaseIds ||
		(hasCreatedChildren && hasInvalidCreatedChildren(createdChildren)) ||
		(hasHistoricalChildCaseIds &&
			(historicalChildCaseIds as unknown[]).some(
				(caseId) => typeof caseId !== "string" || caseId.length === 0,
			)) ||
		!Array.isArray((parsed as { operations?: unknown }).operations) ||
		("primaryCaseIds" in parsed &&
			!Array.isArray(
				(parsed as { primaryCaseIds?: unknown }).primaryCaseIds,
			)) ||
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
		("primaryCaseIds" in parsed &&
			(parsed as { primaryCaseIds: unknown[] }).primaryCaseIds.some(
				(caseId) => typeof caseId !== "string",
			)) ||
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
	const result = parsed as Omit<
		SubmissionEnvelopeResult,
		"createdChildren" | "legacyChildCaseIds"
	> & {
		readonly primaryCaseId?: string;
		readonly createdChildren?: ReadonlyArray<CreatedChildCaseReceipt>;
		readonly childCaseIds?: ReadonlyArray<string>;
	};
	/* Historical receipts predate the ordered selected-case result. Keep that
	 * immutable accepted work replayable while exposing only the canonical
	 * collection to live callers and writing only the new shape. */
	const {
		primaryCaseId: historicalPrimaryCaseId,
		childCaseIds: legacyChildCaseIds,
		...withoutHistoricalSlots
	} = result;
	const canonical: SubmissionEnvelopeResult = {
		...withoutHistoricalSlots,
		primaryCaseIds:
			result.primaryCaseIds ??
			(typeof historicalPrimaryCaseId === "string"
				? [historicalPrimaryCaseId]
				: []),
		createdChildren: result.createdChildren ?? [],
		...(legacyChildCaseIds === undefined ? {} : { legacyChildCaseIds }),
	};
	if (result.caseDatabasePatch === undefined) {
		return canonical;
	}
	return {
		...canonical,
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
