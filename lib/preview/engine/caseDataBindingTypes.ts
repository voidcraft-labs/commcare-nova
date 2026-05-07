// lib/preview/engine/caseDataBindingTypes.ts
//
// Discriminated-union result shapes for the running-app view's
// data binding. Split from the Server Action module so client
// consumers can import the types without pulling in the
// `"use server"` boundary (Next.js's compiler rejects type-only
// imports across that boundary in some build modes).
//
// Empty / missing arms are NOT errors — they're normal render
// branches per the always-in-valid-state principle. Errors are
// reserved for genuine failures.
//
// `unauthenticated` exists for the narrow "session expired
// mid-render" case. The page redirects anonymous sessions to `/`
// before client code runs; the action returns this arm as a typed
// result rather than throwing so the consumer can surface a
// re-auth nudge.

import type {
	CasePropertyFailure,
	CaseRow,
	CaseRowWithCalculated,
	JsonObject,
} from "@/lib/case-store";

// `CaseRow` re-exported as a barrel surface so consumers have one
// import path for the binding's types. `CaseRowWithCalculated`
// rides the same surface for the case-list live-preview path
// (`loadCaseListPreviewAction`).
export type { CaseRow, CaseRowWithCalculated };

/** Result of loading every case row for a case type. */
export type LoadCasesResult =
	| { kind: "rows"; rows: ReadonlyArray<CaseRow> }
	| { kind: "empty" }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of loading the case-list authoring-surface live preview.
 * Mirrors `LoadCasesResult` but the `rows` arm carries
 * `CaseRowWithCalculated` so per-row evaluated calculated columns
 * surface in the preview's table cells.
 *
 * `empty` and `error` arms keep the same shape as `LoadCasesResult`
 * so the client renderer dispatches uniformly across both paths.
 * The authoring surface treats `empty` as "no cases yet, hint to
 * generate sample data via the running-app view" — the live preview
 * does NOT expose the sample-data populate action itself per the
 * task spec (the action belongs to the running-app authoring
 * surface; duplicating it here would fork UX).
 */
export type LoadCaseListPreviewResult =
	| { kind: "rows"; rows: ReadonlyArray<CaseRowWithCalculated> }
	| { kind: "empty" }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	/**
	 * The Server Action's input failed `caseListConfigSchema`
	 * validation at the trust boundary. The action is the wire
	 * boundary; an unparseable config arriving over the wire
	 * indicates either a stale client or a malicious caller, and
	 * the action surfaces a typed arm rather than letting the
	 * downstream `compileExpression` invariant message leak through
	 * the catchall `error` arm.
	 */
	| { kind: "invalid-config"; message: string }
	/**
	 * The Server Action's input failed `blueprintDocSchema`
	 * validation. Same trust-boundary argument as `invalid-config`
	 * — the action is the wire boundary and the blueprint AST
	 * flows directly into the case-store's compiler stack via
	 * `caseStore.queryWithCalculated`. A separate arm (rather than
	 * reusing `invalid-config`) keeps the structural cause
	 * discriminable for the client surface.
	 */
	| { kind: "invalid-blueprint"; message: string }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of loading the Filters-section live-preview rows + count.
 * The Filters-section preview pairs a limited row sample (top ~10
 * rows passing the filter) with the full matching count so the
 * author sees both "what passes" and "how many pass" without
 * paying for a full row fetch.
 *
 * Shape mirrors `LoadCaseListPreviewResult` plus a `totalCount`
 * field on the `rows` arm — `totalCount` is the row population
 * matching the predicate (NOT the row sample's `rows.length`).
 * The renderer uses both numbers to surface "Showing N of M cases
 * that pass this filter".
 *
 * The success path collapses to a single `rows` arm (with possibly
 * empty `rows` array). A separate `empty` arm would tightly couple
 * `rows.length === 0` with `totalCount === 0`, which fails under
 * the rare race where a row matching the filter is deleted between
 * the row sample read and the count read — the row query returns
 * empty but the count returns the pre-delete value. The collapsed
 * shape keeps the count value honest and lets the renderer decide
 * how to format the rows-empty case from the same arm.
 *
 * Missing / schema / trust-boundary arms have the same shape as
 * `LoadCaseListPreviewResult`. The `paused` arm is NOT part of
 * this shape because the Server Action never returns it — the
 * client component renders the paused state locally when its
 * `filterValid` prop is `false` and never fires the action.
 */
export type LoadFilterPreviewResult =
	| {
			kind: "rows";
			rows: ReadonlyArray<CaseRowWithCalculated>;
			totalCount: number;
	  }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	/**
	 * The Server Action's input failed `caseListConfigSchema`
	 * validation at the trust boundary. Same shape as
	 * `LoadCaseListPreviewResult`'s `invalid-config` arm — the
	 * action is the wire boundary; an unparseable config arriving
	 * over the wire surfaces as a typed arm rather than letting
	 * the downstream `compilePredicate` invariant message leak
	 * through the catchall `error` arm.
	 */
	| { kind: "invalid-config"; message: string }
	/**
	 * The Server Action's input failed `blueprintDocSchema`
	 * validation. Same trust-boundary argument as `invalid-config`.
	 */
	| { kind: "invalid-blueprint"; message: string }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of loading a single case by id (the case-loading form
 * path for followup / close). `missing` covers absent-id AND
 * cross-tenant — equivalent under the case-store contract.
 */
export type LoadCaseDataResult =
	| { kind: "row"; row: CaseRow }
	| { kind: "missing" }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of seeding sample cases. `inserted` surfaces the actual
 * count for the user-facing confirmation. Three failure arms
 * covering preconditions / validation, all carrying `caseType` so
 * the UI can name the affected type without re-deriving from URL
 * state:
 *
 * - `missing-case-type` — blueprint snapshot omits the case type.
 *   Consumer re-resolves against fresh state and retries.
 * - `schema-not-synced` — the blueprint mutator skipped
 *   `applySchemaChange` for the case type. Consumer retries after
 *   the sync lands.
 * - `validation-failure` — AJV rejected a generated row's
 *   properties payload during bulk-insert. The consumer renders
 *   the per-field `failures` list.
 */
export type PopulateSampleCasesResult =
	| { kind: "ok"; inserted: number }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	| {
			kind: "validation-failure";
			caseType: string;
			failures: ReadonlyArray<CasePropertyFailure>;
	  }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * One submission's worth of case-store mutations, derived from a
 * completed form. The form engine emits this directly — the
 * authoring layer has no `XForm`-style serialization step between
 * the engine's tree and the case-store. `kind` mirrors `FormType`
 * so the type checker forces consumers to reason about every arm.
 *
 * Per-arm shape:
 * - `registration` — `primary` is the new case the form creates;
 *   `children` are additional cases bucketed by `case_property_on`.
 *   Children carry NO `parentCaseId`; the case-store threads the
 *   primary's generated id at write time via `insertWithChildren`.
 * - `followup` — `caseId` is the bound case the form updates;
 *   `patch.properties` is the JSONB delta. Children carry
 *   `parentCaseId` set to the bound caseId at derivation time.
 * - `close` — same shape as `followup`, plus a closure stamp on
 *   the bound case after the updates land.
 * - `survey` — structural no-op; the form owns no case rows.
 *
 * `caseName` is a separate slot from `properties` because the
 * case-store routes the case display name to the top-level
 * `cases.case_name` column; the JSONB document carries only the
 * user-defined property bag (see `lib/case-store/store.ts` —
 * `CaseInsert.case_name` and `CaseUpdate.case_name` are top-level
 * fields, not extracted from `properties`). The walker plucks the
 * field whose `id === "case_name"` into the slot and never
 * includes it in `properties`.
 */
export type SubmissionMutation =
	| {
			kind: "registration";
			primary: {
				caseType: string;
				caseName?: string;
				properties: JsonObject;
			};
			children: ReadonlyArray<{
				caseType: string;
				caseName?: string;
				properties: JsonObject;
			}>;
	  }
	| {
			kind: "followup";
			caseId: string;
			patch: { caseName?: string; properties: JsonObject };
			children: ReadonlyArray<{
				caseType: string;
				caseName?: string;
				properties: JsonObject;
				parentCaseId: string;
			}>;
	  }
	| {
			kind: "close";
			caseId: string;
			patch: { caseName?: string; properties: JsonObject };
			children: ReadonlyArray<{
				caseType: string;
				caseName?: string;
				properties: JsonObject;
				parentCaseId: string;
			}>;
	  }
	| { kind: "survey" };

/**
 * Result of submitting a `SubmissionMutation` through the
 * case-store. The success arms mirror `SubmissionMutation` so a
 * caller can branch on the same discriminator across pre- and
 * post-write code. Failure arms follow the `populateSampleCasesAction`
 * typed-error shape — the case-store's domain errors map 1:1.
 */
export type SubmissionResult =
	| {
			kind: "registration";
			caseId: string;
			childCaseIds: ReadonlyArray<string>;
	  }
	| { kind: "followup"; caseId: string; childCaseIds: ReadonlyArray<string> }
	| { kind: "close"; caseId: string; childCaseIds: ReadonlyArray<string> }
	| { kind: "survey" }
	| { kind: "unauthenticated" }
	| { kind: "case-not-found"; caseId: string }
	| {
			kind: "case-properties-validation";
			caseType: string;
			failures: ReadonlyArray<CasePropertyFailure>;
	  }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	| { kind: "error"; message: string };
