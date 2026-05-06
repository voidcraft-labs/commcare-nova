// lib/preview/engine/caseDataBinding.ts
//
// The data binding the running-app view uses to read and mutate
// case data. The binding has two layers:
//
//   1. **Pure helpers** — `readCases`, `readCaseData`,
//      `seedSampleCases`. Each takes a `CaseStore` instance plus
//      its operation arguments and returns a discriminated-union
//      result. No `withOwnerContext`, no `getSession`, no Next.js
//      framework dependencies. Tests bind against these directly,
//      passing a per-test `CaseStore` from the contract harness's
//      `setupPerTestDatabase` shape.
//
//   2. **Server Actions** — `loadCasesAction`,
//      `loadCaseDataAction`, `populateSampleCasesAction`. Resolve
//      the request's session via `getSession()`, construct a
//      tenant-scoped `CaseStore` via `withOwnerContext(session.user.id)`,
//      and delegate to the pure helpers. Live in this file because
//      keeping the contract beside the helpers means consumers
//      (the running-app screens) import one module for both shapes
//      and the wire-format invariants stay co-located.
//
// ## Why this split
//
// Same shape `lib/case-store/form-bridge/writeThrough.ts` uses:
// the I/O wrapper accepts the `CaseStore` as a parameter, the
// pure helper does the work. Tests inject the store directly;
// production wraps with `withOwnerContext` at the request boundary.
// Centralising session resolution in this file means a change to
// the auth strategy lands in one place rather than rippling across
// every screen consumer, AND the pure helpers stay testable
// against the case-store harness without spinning up a session.
//
// ## Why discriminated-union returns
//
// The running-app view is "always in a valid state" — an empty
// case-type is not an error, it's a button. The result types
// reflect that contract structurally:
//
//   - `LoadCasesResult` — `{ kind: "rows", rows }` for populated
//     case-types, `{ kind: "empty" }` for unpopulated ones, plus
//     `{ kind: "unauthenticated" }` and `{ kind: "error" }` for
//     the framework-level failure paths. Consumers render the
//     "Generate sample data" affordance in the `empty` arm.
//   - `LoadCaseDataResult` — `{ kind: "row", row }` /
//     `{ kind: "missing" }` plus the same framework arms.
//   - `PopulateSampleCasesResult` — `{ kind: "ok", inserted }` plus
//     the framework arms; surfaces the inserted count to the UI for
//     a "<N> sample cases generated" confirmation.

"use server";

import { getSession } from "@/lib/auth-utils";
import { withOwnerContext } from "@/lib/case-store";
import type { BlueprintDoc } from "@/lib/domain";
import {
	mapPopulateSampleCasesError,
	readCaseData,
	readCases,
	seedSampleCases,
} from "./caseDataBindingHelpers";
import type {
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
} from "./caseDataBindingTypes";

// ---------------------------------------------------------------
// Server Actions — request-boundary wrappers
// ---------------------------------------------------------------
//
// Each action: resolves the session, constructs the bound store
// via `withOwnerContext`, delegates to the matching pure helper.
// Errors thrown by the case-store layer (validation, tenant
// scoping, schema mismatch) are caught and mapped to the
// `{ kind: "error" }` arm so an unhandled throw never tears down
// Next's RSC tree.

/**
 * Fetch the case-type's rows for the running-app view's case
 * list. Returns the shape the consumer's discriminated-union
 * render-tree branches on.
 *
 * @param appId The owning app — sourced from the session store's
 *   `useAppId()`. Must match the app the case type belongs to;
 *   the case-store enforces the `(app_id, owner_id)` filter at
 *   the SQL layer so a mismatched id surfaces as an empty result
 *   set, not a leaked row.
 * @param caseType The case-type name to read. The case-store
 *   filters `cases` rows by this column; the predicate compiler
 *   resolves property reads against this type's blueprint
 *   declaration.
 */
export async function loadCasesAction(
	appId: string,
	caseType: string,
): Promise<LoadCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await readCases(store, { appId, caseType });
	} catch (err) {
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load cases.",
		};
	}
}

/**
 * Fetch a single case row by id for the running-app view's
 * case-loading form path. Returns `{ kind: "missing" }` when the
 * id is absent OR sits outside the bound owner's tenant — the
 * three states are equivalent under the case-store contract so
 * the tenant boundary stays structural rather than message-leaked.
 */
export async function loadCaseDataAction(
	appId: string,
	caseType: string,
	caseId: string,
): Promise<LoadCaseDataResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await readCaseData(store, { appId, caseType, caseId });
	} catch (err) {
		return {
			kind: "error",
			message: err instanceof Error ? err.message : "Failed to load case.",
		};
	}
}

/**
 * Populate an empty case-type with deterministic sample rows.
 * Generates `SAMPLE_CASE_DEFAULT_COUNT` rows (defined in
 * `caseDataBindingHelpers`); the binding ships that default
 * rather than threading a count parameter through the consumer
 * surface.
 *
 * The seed composes from the current wall-clock instant so two
 * back-to-back populates produce different rows. The determinism
 * contract on the underlying generator is per
 * `(blueprint, caseType, seed)`, so tests that need reproducibility
 * call `CaseStore.generateSampleData` directly with a fixed seed.
 *
 * Two stale-state preconditions surface as typed result arms
 * rather than the generic `error` arm:
 *
 *   - `CaseTypeNotInBlueprintError` → `missing-case-type`. The
 *     blueprint snapshot the action received carries no entry for
 *     `caseType`; the consumer re-resolves against fresh state and
 *     retries.
 *   - `SchemaNotSyncedError` → `schema-not-synced`. The
 *     `case_type_schemas` row hasn't been written yet; the consumer
 *     either retries after the blueprint mutator's
 *     `applySchemaChange` lands or surfaces the structural fix to
 *     the user.
 *
 * Both arms point at user-driven flows: clicking "Generate sample
 * data" on a freshly-declared case type whose schema sync hasn't
 * landed, or clicking against a case type that was deleted between
 * mount and click. The typed arms keep the running-app view's
 * render branch on a structured surface instead of the
 * `compilerBugMessage` body the previous wrapper emitted.
 */
export async function populateSampleCasesAction(
	appId: string,
	caseType: string,
	blueprint: BlueprintDoc,
): Promise<PopulateSampleCasesResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const store = await withOwnerContext(session.user.id);
		return await seedSampleCases(store, { appId, caseType, blueprint });
	} catch (err) {
		return mapPopulateSampleCasesError(err);
	}
}
