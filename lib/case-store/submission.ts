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

import type { CaseOperation, CaseType, Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { JsonObject } from "./sql/database";

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
	readonly properties: JsonObject;
}

/**
 * The ordinary (non-operation) half of a submission — the existing
 * four form types' case effects, executed AFTER the operation program
 * (advanced effects precede the ordinary FormActions block in wire
 * document order, and the executor mirrors that).
 *
 *   - `registration` — insert the primary plus every child (children
 *     take the primary's generated id as `parent_case_id`; they never
 *     carry their own).
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
				readonly properties: JsonObject;
			};
			readonly children: ReadonlyArray<
				SubmissionCaseSeed & { readonly parentCaseId: string }
			>;
	  }
	| { readonly kind: "none" };

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
	/** Open-namespace worker data for `sessionUser` terms; absent keys
	 * resolve blank, the device's missing-worker-data semantic. */
	readonly sessionUser?: ReadonlyMap<string, string>;
	/** Closed-namespace context fields for `sessionContext` terms. */
	readonly sessionContext?: ReadonlyMap<string, string>;
	/** Viewer IANA timezone for `format-date` rendering parity. */
	readonly viewerTimeZone?: string;
}

export interface ApplySubmissionArgs {
	readonly appId: string;
	readonly ordinary: OrdinarySubmissionAction;
	readonly operations?: CaseOperationProgram;
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
}
