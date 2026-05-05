// lib/preview/engine/caseDataBindingHelpers.ts
//
// Pure I/O helpers the running-app view's data binding wraps in
// Server Actions. Each helper accepts a `CaseStore` instance and
// the operation arguments; tests inject a per-test store from
// `setupPerTestDatabase`, production wraps with
// `withOwnerContext(session.user.id)` at the request boundary
// (see `./caseDataBinding.ts`).
//
// ## Why split from the Server Action surface
//
// Next.js's `"use server"` boundary forbids non-action exports in
// the same module — typed helpers must live elsewhere. Splitting
// also means the helpers are testable with the case-store harness
// directly, mirroring how `lib/case-store/form-bridge/writeThrough.ts`
// accepts a `CaseStore` parameter rather than constructing one.
//
// ## Read shape
//
// The helpers return `CaseRow` directly — the same type the
// case-store interface exposes. Consumers (the running-app
// screens) read property values through `row.properties` (a
// `JsonObject`, i.e. `Record<string, JsonValue>`) plus the four
// reserved scalar columns (`case_id` / `case_type` / `owner_id` /
// `status`) via direct row access. The JSONB read shape is what
// every case-store consumer (form-bridge, applySchemaChange's
// migration loop, the predicate compiler) binds against;
// preserving it here keeps a single shape across every surface
// that touches case data.
//
// One coercion runs at the form-engine boundary only:
// `caseRowToFormPreload` flattens the JSONB into the
// `Map<string, string>` shape `useFormEngine` accepts. The
// flattening is a presentation concern (the form engine reasons
// about input strings), not a domain concern.

import type { CaseRow, CaseStore, JsonValue } from "@/lib/case-store";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
} from "./caseDataBindingTypes";

// ---------------------------------------------------------------
// Sample-data defaults
// ---------------------------------------------------------------

/**
 * Default row count for `populateSampleCasesAction`. The spec
 * pins 30 as the per-case-type default at
 * `docs/superpowers/specs/2026-04-30-case-list-search-design.md`'s
 * sample-data section. Exported so tests calling
 * `seedSampleCases` directly use the same number production does.
 */
export const SAMPLE_CASE_DEFAULT_COUNT = 30;

// ---------------------------------------------------------------
// `pickBlueprintDoc`
// ---------------------------------------------------------------

/**
 * Project any superset of `BlueprintDoc` (including the doc
 * store's `BlueprintDocState`, which carries action methods
 * alongside the data fields) down to the bare `BlueprintDoc`
 * shape: every field defined on the blueprint schema, nothing
 * else.
 *
 * Server Actions serialize their arguments via React's RSC
 * serializer, which rejects function values. The doc store's
 * state object carries action methods (`applyMany`, `load`, etc.)
 * alongside the data fields; passing the raw state into an action
 * would throw at the serialization boundary. This helper picks
 * just the data fields so the action sees a pure object.
 *
 * The generic `T extends BlueprintDoc` makes the input-type claim
 * structural rather than purely doc-level — call sites that pass
 * `BlueprintDocState` (a superset) are accepted by the type
 * checker, and call sites that pass plain `BlueprintDoc` work the
 * same way. The return type stays narrowed to `BlueprintDoc` so
 * the caller cannot accidentally re-introduce a superset's extras
 * into the wire payload.
 *
 * Lives beside the action helpers so adding a new BlueprintDoc
 * field surfaces an exhaustivity error here in the same module
 * that consumes the type — no parallel edit at every consumer
 * site.
 */
export function pickBlueprintDoc<T extends BlueprintDoc>(
	state: T,
): BlueprintDoc {
	return {
		appId: state.appId,
		appName: state.appName,
		connectType: state.connectType,
		caseTypes: state.caseTypes,
		modules: state.modules,
		forms: state.forms,
		fields: state.fields,
		moduleOrder: state.moduleOrder,
		formOrder: state.formOrder,
		fieldOrder: state.fieldOrder,
		fieldParent: state.fieldParent,
	};
}

// ---------------------------------------------------------------
// `readCases`
// ---------------------------------------------------------------

/**
 * Read every row of a case-type for the bound tenant. Returns the
 * `empty` arm when no rows exist — the consumer's render-tree
 * branches on `kind` and surfaces the "Generate sample data"
 * affordance in that arm.
 *
 * The case-store's `query` enforces the `(app_id, owner_id)`
 * tenant filter at the SQL layer; a mismatched id produces an
 * empty result set, not a leaked row. No predicate / sort /
 * limit is supplied — the helper consumes the entire case-type
 * for the running-app view's table render.
 */
export async function readCases(
	store: CaseStore,
	args: { appId: string; caseType: string },
): Promise<LoadCasesResult> {
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
	});
	if (rows.length === 0) return { kind: "empty" };
	return { kind: "rows", rows };
}

// ---------------------------------------------------------------
// `readCaseData`
// ---------------------------------------------------------------

/**
 * Read a single case row by id. Returns `missing` when no row
 * matches — covers both the absent-id case and the cross-tenant
 * case (the case-store contract treats those as equivalent at the
 * tenant boundary). The case-store has no targeted "fetch by id"
 * method; `query` with no predicate returns the whole case-type
 * and we filter in memory. At running-app population sizes this
 * is a non-issue; if profiling shows it's a hot path, the
 * case-store interface can grow a `getById` arm and this helper
 * delegates to it without changing the binding's shape.
 */
export async function readCaseData(
	store: CaseStore,
	args: { appId: string; caseType: string; caseId: string },
): Promise<LoadCaseDataResult> {
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
	});
	const found = rows.find((r) => r.case_id === args.caseId);
	if (found === undefined) return { kind: "missing" };
	return { kind: "row", row: found };
}

// ---------------------------------------------------------------
// `seedSampleCases`
// ---------------------------------------------------------------

/**
 * Populate an empty case-type with deterministic sample rows via
 * `CaseStore.generateSampleData`. The seed composes from the
 * current wall-clock instant so two back-to-back populates
 * produce different rows; tests that need reproducibility call
 * `CaseStore.generateSampleData` directly with their own fixed
 * seed instead of going through this helper.
 *
 * The count is fixed at `SAMPLE_CASE_DEFAULT_COUNT`. The button
 * surface this helper backs is a fixed-count action — generating
 * an arbitrary count is a separate authoring path that calls the
 * underlying `CaseStore.generateSampleData` directly.
 */
export async function seedSampleCases(
	store: CaseStore,
	args: { appId: string; caseType: string; blueprint: BlueprintDoc },
): Promise<PopulateSampleCasesResult> {
	const result = await store.generateSampleData({
		appId: args.appId,
		caseType: args.caseType,
		count: SAMPLE_CASE_DEFAULT_COUNT,
		seed: `${Date.now()}`,
		blueprint: args.blueprint,
	});
	return { kind: "ok", inserted: result.inserted };
}

// ---------------------------------------------------------------
// `caseRowToFormPreload`
// ---------------------------------------------------------------

/**
 * Flatten a `CaseRow`'s JSONB `properties` document into the
 * `Map<string, string>` shape `useFormEngine` accepts as
 * case-data preload.
 *
 * Each property value is coerced to its string form via
 * `jsonValueToString`:
 *
 *   - Strings pass through verbatim.
 *   - Numbers / booleans stringify via `String()`.
 *   - `null` becomes the empty string — the form engine treats
 *     missing case-data the same as the empty string, and `null`
 *     in JSONB is the same domain state as "no value preloaded".
 *   - Arrays / objects JSON-stringify; the form engine has no
 *     native handling for nested values, but stringifying keeps
 *     the data round-trippable in case a downstream consumer
 *     (custom calculate field, agent inspector) parses it back.
 *
 * The `case_name` column lives at the top-level of `CaseRow`
 * (denormalised from `properties.case_name` for sort / display);
 * keeping the helper focused on `properties` means the form
 * engine sees one source for case-data and the column-display
 * code path uses `row.case_name` directly.
 */
export function caseRowToFormPreload(row: CaseRow): Map<string, string> {
	const preload = new Map<string, string>();
	for (const [key, value] of Object.entries(row.properties)) {
		preload.set(key, jsonValueToString(value));
	}
	return preload;
}

/**
 * Coerce a JSONB-typed value into its string form for the form
 * engine. See `caseRowToFormPreload` for the per-shape contract.
 */
function jsonValueToString(value: JsonValue): string {
	if (value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	// Arrays + objects fall through to JSON.stringify — the form
	// engine has no native handling, but the round-trippable form
	// keeps the data inspectable in agent / debug paths.
	return JSON.stringify(value);
}

// ---------------------------------------------------------------
// `caseRowDisplayValue`
// ---------------------------------------------------------------

/**
 * Read one column's display value off a `CaseRow` for the
 * case-list table render. Resolves the column's `field` against
 * `row.properties`; falls back to the empty string when the
 * property is absent.
 *
 * Lives in this module (not inline at each row consumer) so the
 * same coercion governs every render surface that displays case
 * properties as strings. A column-formatter that needs different
 * per-data-type rendering extends this one helper.
 */
export function caseRowDisplayValue(row: CaseRow, field: string): string {
	const value = row.properties[field];
	if (value === undefined) return "";
	return jsonValueToString(value);
}
