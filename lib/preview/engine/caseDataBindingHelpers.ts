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
// `JsonObject`, i.e. `Record<string, JsonValue>`) plus the
// reserved scalar columns (see `RESERVED_SCALAR_COLUMNS` at
// `lib/case-store/sql/dataTypeTokens.ts`) via direct row access.
// The JSONB read shape is what every case-store consumer
// (form-bridge, applySchemaChange's migration loop, the predicate
// compiler) binds against; preserving it here keeps a single shape
// across every surface that touches case data.
//
// One coercion runs at the form-engine boundary only:
// `caseRowToFormPreload` flattens the JSONB into the
// `Map<string, string>` shape `useFormEngine` accepts. The
// flattening is a presentation concern (the form engine reasons
// about input strings), not a domain concern.

import type { CaseRow, CaseStore, JsonValue } from "@/lib/case-store";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate/builders";
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
 * UUID-shape regex (lowercase hex, 8-4-4-4-12). Matches every
 * UUID format Postgres accepts, including v4 / v7 / nil. Authored
 * here rather than imported because the only consumer is
 * `readCaseData`'s caller-id validation; sharing one constant with
 * a wider package would invite accidental coupling.
 */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a single case row by id. Returns `missing` when no row
 * matches — covers both the absent-id case and the cross-tenant
 * case (the case-store contract treats those as equivalent at the
 * tenant boundary). Also returns `missing` for syntactically
 * invalid UUIDs (the running-app view occasionally inherits a
 * stale link from a deleted case or a typo in a manual nav entry;
 * surfacing those as "missing" keeps the upstream flow
 * structural).
 *
 * The predicate `case_id = <id>` compiles through the term
 * compiler's `RESERVED_SCALAR_COLUMNS` arm directly to the
 * `c.case_id` scalar reference, which hits the primary-key index;
 * `limit: 1` caps the result to one row even though the PK
 * already guarantees at-most-one match. The `blueprint` slot is
 * not threaded — the predicate touches only a reserved scalar
 * column, so the term compiler never resolves a property
 * `data_type` against the case-type schemas.
 */
export async function readCaseData(
	store: CaseStore,
	args: { appId: string; caseType: string; caseId: string },
): Promise<LoadCaseDataResult> {
	// Postgres rejects malformed UUIDs at the parameter cast (the
	// `case_id` column is `uuid`-typed). The query path would surface
	// the rejection as a thrown error; the caller's contract treats
	// a malformed id the same as an absent id, so the early-return
	// covers the syntactic-invalid arm before the SQL runs.
	if (!UUID_PATTERN.test(args.caseId)) return { kind: "missing" };
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		predicate: eq(prop(args.caseType, "case_id"), literal(args.caseId)),
		limit: 1,
	});
	const found = rows[0];
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
 * `case_name` is a top-level column on `cases` (a CCHQ-platform-
 * required scalar present on every case regardless of case-type);
 * the helper folds it into the preload map under the `case_name`
 * key so the form engine sees one source for case-data, mirroring
 * the runtime path where `case_name` reads as a column from the
 * term compiler's `RESERVED_SCALAR_COLUMNS` arm.
 */
export function caseRowToFormPreload(row: CaseRow): Map<string, string> {
	const preload = new Map<string, string>();
	preload.set("case_name", row.case_name);
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
 * `cases`'s reserved-scalar columns first (`case_name` is the
 * only one a typical column list references; the others are
 * handled the same way for consistency) and falls through to
 * `row.properties` for user-defined property reads. Falls back
 * to the empty string when the property is absent.
 *
 * Lives in this module (not inline at each row consumer) so the
 * same coercion governs every render surface that displays case
 * properties as strings. A column-formatter that needs different
 * per-data-type rendering extends this one helper.
 */
export function caseRowDisplayValue(row: CaseRow, field: string): string {
	if (field === "case_name") return row.case_name;
	if (field === "case_id") return row.case_id;
	if (field === "case_type") return row.case_type;
	if (field === "owner_id") return row.owner_id ?? "";
	if (field === "status") return row.status ?? "";
	const value = row.properties[field];
	if (value === undefined) return "";
	return jsonValueToString(value);
}
