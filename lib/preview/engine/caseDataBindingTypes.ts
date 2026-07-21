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
	CalculatedValue,
	CasePropertyFailure,
	CaseRow,
	CaseRowWithCalculated,
	JsonObject,
	JsonValue,
	ParkedValueEntry,
	ParkedValueStanding,
} from "@/lib/case-store";
import type { CasePropertyDataType } from "@/lib/domain";

// `CaseRow` re-exported as a barrel surface so consumers have one
// import path for the binding's types. `CaseRowWithCalculated`
// rides the same surface for the running case list and filter-count
// preview paths. `CalculatedValue`, `JsonValue`, and `JsonObject`
// ride the same surface so client-bundle-bound
// consumers + the server-only helpers can type-import them from
// this leaf without touching the case-store barrel — the barrel
// value-exports `withOwnerContext`, which pulls the Postgres
// connection module + every transitive dep into any graph that
// imports from it.
export type {
	CalculatedValue,
	CasePropertyFailure,
	CaseRow,
	CaseRowWithCalculated,
	JsonObject,
	JsonValue,
};

/** Why the effective query can return zero rows. Derived at the server query
 * composition boundary after blank inputs and empty owner-id expressions have
 * been removed, so the running app never guesses from client-side syntax. */
export type CaseQueryConstraintSource =
	| "unconstrained"
	| "worker-search"
	| "authored-rules";

/** What the client can truthfully say about a settled query result. `unknown`
 * exists only for the short rolling-deploy window where a new client receives
 * the older Server Action response shape without constraint metadata. */
export type CaseQueryConstraintContext = CaseQueryConstraintSource | "unknown";

/**
 * Result of loading case rows for a case type, optionally as a bounded window.
 * The success arms carry the effective query's constraint source alongside
 * their data so empty-state copy describes the query that actually reached the
 * case store, not merely the presence of an authored expression or a raw
 * submitted string. The `rows` arm carries `CaseRowWithCalculated` so calc-arm
 * columns surface their
 * SQL-projected values on `row.calculated[uuid]` — `evaluateColumnValue`
 * reads the slot directly. Callers without a `caseListConfig` (raw-
 * row consumers) get an empty `calculated: {}` map per row.
 */
export type LoadCasesResult =
	| {
			kind: "rows";
			rows: ReadonlyArray<CaseRowWithCalculated>;
			/** Full population matching the authored + worker query. Present for
			 * bounded running-list reads; optional during rolling deploys and for
			 * legacy unpaged callers. */
			totalCount?: number;
			/** Effective bounded window returned by the server. The server may
			 * clamp an offset past the final page after concurrent deletion. */
			pageOffset?: number;
			pageSize?: number;
			/** Optional only for rolling-deploy compatibility with an older action. */
			constraintSource?: CaseQueryConstraintSource;
	  }
	| {
			kind: "empty";
			/** When a worker Search and authored availability are both active,
			 * this count isolates the authored-only population. Zero proves that
			 * clearing Search cannot reveal a case; a positive value proves that
			 * Search itself narrowed the authored population to zero. */
			authoredMatchingCount?: number;
			/** Optional only for rolling-deploy compatibility with an older action. */
			constraintSource?: CaseQueryConstraintSource;
	  }
	/** A safe, deterministic Search-value rejection. Unlike `error`, retrying
	 * unchanged input cannot help, so consumers show the cause beside Search
	 * and never offer a transport-style retry button. */
	| {
			kind: "invalid-search";
			message: string;
			/** Whether the worker can repair a submitted prompt or the authored
			 * Search/session expression itself needs an editor. */
			repair: "inputs" | "settings";
	  }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Unfiltered case count for the builder-owned case-data manager. This is
 * deliberately a separate action from `LoadCasesResult`: the manager needs
 * the full population size, while list surfaces may be filtered, paginated,
 * or carrying calculated projections.
 */
export type LoadCaseCountResult =
	| { kind: "count"; count: number }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * One kept value as it crosses the Server Action wire —
 * `ParkedValueEntry` (see `lib/case-store`) with its timestamps as
 * ISO strings so the payload stays plain JSON. The `standing`
 * verdict is computed server-side against the property's CURRENT
 * declaration; the client renders it, never re-derives it.
 */
export interface ParkedValueEntryWire
	extends Omit<ParkedValueEntry, "createdAt" | "dismissedAt"> {
	createdAt: string;
	dismissedAt: string | null;
}

// The wire's transition tokens and the entry's standing union
// re-exported beside the entry so the review screen types its
// grouping and per-row story off this leaf module.
export type { CasePropertyDataType, ParkedValueStanding };

/**
 * Result of listing a case type's kept values. One arm serves
 * every reader — the review screen renders the full entries; the
 * discovery surfaces (the Case data badge + popover section) derive
 * their active count and property names from the same list, so one
 * invalidation channel refreshes both.
 */
export type LoadParkedValuesResult =
	| { kind: "entries"; entries: ParkedValueEntryWire[] }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/** Result of the review surface's explicit restore. `kept` counts entries that stayed parked (blocked, vanished, or foreign) — the client re-lists to show why. */
export type RestoreParkedValuesResult =
	| { kind: "restored"; restored: number; kept: number }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/** Result of toggling the soft archive on kept entries. */
export type SetParkedValuesDismissedResult =
	| { kind: "toggled"; count: number }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of the Replace path (write a replacement value to the case,
 * archive the entry). `invalid-value` carries the schema's per-field
 * failures for inline rendering; `not-found` means the entry vanished
 * (a teammate restored/dismissed it, or its case row was replaced) —
 * the client re-lists.
 */
export type ReplaceParkedValueResult =
	| { kind: "replaced" }
	| { kind: "invalid-value"; failures: readonly CasePropertyFailure[] }
	| { kind: "not-found" }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

/**
 * Result of loading the Filters-section live-preview rows + count.
 * The Filters-section preview pairs a limited row sample (top ~10
 * rows passing the filter) with the full matching count so the
 * author sees both "what passes" and "how many pass" without
 * paying for a full row fetch.
 *
 * `totalCount` is the row population
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
 * The `paused` arm is NOT part of this shape because the Server Action
 * never returns it — the
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
	 * The action is the wire boundary; an unparseable config arriving
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
 * path for followup / close, and the URL-backed Details path).
 * `missing` covers absent-id AND cross-tenant — equivalent under
 * the case-store contract.
 *
 * The row always uses the case-store's projected shape. Raw form
 * loads receive `calculated: {}`; Details can supply the live case-list
 * configuration and catalog so calculated display values are projected
 * for an off-page/deep-linked row without applying the Results filter,
 * sort, or page window.
 *
 * `ancestors` is the bound case's parent chain, nearest-first
 * (parent, grandparent, …), walked server-side through the case
 * store's `parent` index edges. The form engine resolves
 * `#<ancestor_type>/<prop>` references against it — the preview
 * counterpart of the wire's `…/index/parent × depth …` casedb
 * walk. Empty for a root case.
 */
export type LoadCaseDataResult =
	| {
			kind: "row";
			row: CaseRowWithCalculated;
			ancestors: ReadonlyArray<CaseRow>;
	  }
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
 * - `close` — same shape as `followup`, plus the bound case's atomic
 *   lifecycle transition (`closed_on` + built-in `status = "closed"`)
 *   after the updates land.
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
