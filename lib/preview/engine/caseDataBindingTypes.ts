// lib/preview/engine/caseDataBindingTypes.ts
//
// The discriminated-union result shapes the running-app view's
// data binding returns. Lives in its own module so consumers
// (`use client` screens, the colocated client hooks, the pure
// helpers) can import the types without pulling in the
// `"use server"` Server Action surface — Next.js's compiler
// rejects type-only imports across that boundary in some build
// modes and the dedicated module sidesteps the rule entirely.
//
// ## Always-valid-state contract
//
// Every shape includes an `empty` / `missing` arm that is NOT an
// error — running-app screens treat it as a normal render branch.
// The `Generate sample data` affordance shipping in the case-list
// view's `empty` arm is the structural answer to "what does an
// empty case-type look like to the user". Errors are reserved for
// genuine failures (auth, network, schema mismatch).
//
// ## Why `unauthenticated` is its own arm
//
// The running-app view mounts inside `(app)/build/[id]/[[...path]]/page.tsx`,
// which redirects to `/` for anonymous sessions before any client
// code runs. The `unauthenticated` arm exists for the narrow case
// of a session that expires mid-render — the action returns it as
// a typed result rather than throwing, and the consumer surfaces
// a re-auth nudge instead of the generic error UI.

import type { CaseRow } from "@/lib/case-store";

// ---------------------------------------------------------------
// Row shapes — re-exported as the binding's public surface
// ---------------------------------------------------------------
//
// `CaseRow` is the read-side shape from the case-store's Database
// type. Re-exporting it from this module gives consumers a single
// import path (`@/lib/preview/engine/caseDataBindingTypes`)
// instead of reaching across the `lib/preview` ↔ `lib/case-store`
// boundary directly. The case-store layer remains the source of
// truth; this is a barrel re-export.

export type { CaseRow };

// ---------------------------------------------------------------
// `loadCasesAction` result
// ---------------------------------------------------------------

/**
 * Result of loading every case row for a given case-type. The
 * running-app view's `CaseListScreen` matches on `kind` and
 * renders one of:
 *
 *   - `rows` — the standard table view with one row per `CaseRow`.
 *   - `empty` — the "Generate sample data" affordance. Triggering
 *     it calls `populateSampleCasesAction` and re-runs the load.
 *   - `unauthenticated` — re-auth prompt.
 *   - `error` — generic failure card with `message`.
 */
export type LoadCasesResult =
	| { kind: "rows"; rows: ReadonlyArray<CaseRow> }
	| { kind: "empty" }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

// ---------------------------------------------------------------
// `loadCaseDataAction` result
// ---------------------------------------------------------------

/**
 * Result of loading a single case row by id. Used by the
 * case-loading form path (followup / close form types).
 *
 *   - `row` — the requested row; the form engine consumes the
 *     properties as case-data preload.
 *   - `missing` — the case-id is absent OR sits outside the bound
 *     owner's tenant. Equivalent under the case-store contract;
 *     the consumer renders the "no cases available" empty state.
 *   - `unauthenticated` / `error` — same shape as the cases load.
 */
export type LoadCaseDataResult =
	| { kind: "row"; row: CaseRow }
	| { kind: "missing" }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };

// ---------------------------------------------------------------
// `populateSampleCasesAction` result
// ---------------------------------------------------------------

/**
 * Result of seeding sample cases for an empty case-type. The
 * `inserted` count surfaces back to the UI so the user sees a
 * confirmation tied to the actual number of rows generated; the
 * action passes `SAMPLE_CASE_DEFAULT_COUNT` from
 * `caseDataBindingHelpers`, so the surfaced count matches that
 * constant on every successful call.
 *
 * Two extra arms cover stale-state preconditions reachable from
 * the running-app view. `missing-case-type` surfaces when the
 * blueprint snapshot the action received carries no entry for the
 * requested case type — three causes are equivalent (the case type
 * was deleted in the editor between mount and click, the snapshot
 * is stale, or it was never declared); the consumer re-resolves
 * against fresh blueprint state and retries. `schema-not-synced`
 * surfaces when no row exists in `case_type_schemas` yet — the
 * blueprint mutator skipped the `applySchemaChange` ordering
 * contract; the consumer either retries after the sync lands or
 * surfaces the structural fix. Both arms carry `caseType` so the
 * UI can name the affected case type without re-deriving it from
 * URL state.
 */
export type PopulateSampleCasesResult =
	| { kind: "ok"; inserted: number }
	| { kind: "missing-case-type"; caseType: string }
	| { kind: "schema-not-synced"; caseType: string }
	| { kind: "unauthenticated" }
	| { kind: "error"; message: string };
