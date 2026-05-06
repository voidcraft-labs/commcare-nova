// lib/preview/engine/caseDataBindingHelpers.ts
//
// Pure I/O helpers the running-app view's data binding wraps in
// Server Actions. Each helper accepts a `CaseStore` parameter
// (mirroring `lib/case-store/form-bridge/writeThrough.ts`) so
// tests inject a per-test store directly, while production wraps
// with `withOwnerContext` at the request boundary in
// `./caseDataBinding.ts`. Splitting from the Server Action module
// is required — Next.js's `"use server"` boundary forbids
// non-action exports in the same module.
//
// Helpers return `CaseRow` directly so consumers read the JSONB
// `properties` document the same way the form-bridge,
// `applySchemaChange`, and the predicate compiler do. The only
// coercion is `caseRowToFormPreload` at the form-engine boundary,
// which flattens to `Map<string, string>` because the engine
// reasons about input strings.

import {
	CasePropertiesValidationError,
	type CaseRow,
	type CaseStore,
	CaseTypeNotInBlueprintError,
	type JsonValue,
	SchemaNotSyncedError,
} from "@/lib/case-store";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { eq, literal, prop } from "@/lib/domain/predicate/builders";
import type {
	LoadCaseDataResult,
	LoadCasesResult,
	PopulateSampleCasesResult,
} from "./caseDataBindingTypes";

/**
 * Default row count for `populateSampleCasesAction`. Spec § sample
 * data pins 30. Exported so tests using `seedSampleCases`
 * directly match production.
 */
export const SAMPLE_CASE_DEFAULT_COUNT = 30;

/**
 * Project a `BlueprintDoc` (or superset like the doc store's
 * `BlueprintDocState`) down to the wire-serializable shape Server
 * Actions accept — every schema field plus `fieldParent`, nothing
 * else. The doc store carries action methods alongside data
 * fields; passing raw state into an action would throw at React's
 * RSC serializer.
 *
 * `blueprintDocSchema.parse(state)` runs Zod's default
 * `.strip()` mode, dropping unknown keys (action methods, any
 * other extras). `fieldParent` re-attaches from the input because
 * it's an in-memory `BlueprintDoc` extension the schema doesn't
 * declare (rebuilt from `fieldOrder` on load, never persisted).
 * Single source of truth: the Zod schema. New `blueprintDocSchema`
 * fields surface in the projection automatically.
 */
export function pickBlueprintDoc<T extends BlueprintDoc>(
	state: T,
): BlueprintDoc {
	return {
		...blueprintDocSchema.parse(state),
		fieldParent: state.fieldParent,
	};
}

/**
 * Read every row of a case type for the bound tenant. `empty`
 * surfaces the "Generate sample data" affordance.
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

/**
 * UUID 8-4-4-4-12. Matches every Postgres-accepted form (v4 / v7
 * / nil). Authored here rather than imported because the only
 * consumer is `readCaseData`'s caller-id validation.
 */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a single case row by id. `missing` covers absent-id,
 * cross-tenant (equivalent under the case-store contract), AND
 * syntactically invalid UUIDs — the running-app view occasionally
 * inherits a stale link from a deleted case, and surfacing
 * malformed ids as missing keeps the upstream flow structural.
 *
 * No `blueprint` is threaded — `case_id` is a reserved scalar
 * column, so the term compiler never resolves a property
 * `data_type`. `limit: 1` is belt-and-suspenders; the PK
 * guarantees at-most-one match.
 */
export async function readCaseData(
	store: CaseStore,
	args: { appId: string; caseType: string; caseId: string },
): Promise<LoadCaseDataResult> {
	// Postgres rejects malformed UUIDs at the parameter cast (the
	// column is `uuid`-typed). The early-return covers the
	// syntactic-invalid arm before the SQL runs.
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

/**
 * Populate an empty case type with `SAMPLE_CASE_DEFAULT_COUNT`
 * rows. The seed composes from `Date.now()` so back-to-back
 * populates produce different rows; tests needing reproducibility
 * call `CaseStore.generateSampleData` directly with a fixed seed.
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

/**
 * Map errors from `seedSampleCases` to typed result arms. The
 * three typed errors get dedicated arms so internal vocabulary
 * (e.g. AJV's "Properties payload failed validation for case type
 * ...") doesn't leak through the generic `error` arm into the
 * user-facing path.
 *
 * Lives here (not inline at the Server Action) so the mapping is
 * testable against the case-store contract harness without
 * driving `getSession` / `withOwnerContext`.
 */
export function mapPopulateSampleCasesError(
	err: unknown,
): PopulateSampleCasesResult {
	if (err instanceof CaseTypeNotInBlueprintError) {
		return { kind: "missing-case-type", caseType: err.caseType };
	}
	if (err instanceof SchemaNotSyncedError) {
		return { kind: "schema-not-synced", caseType: err.caseType };
	}
	if (err instanceof CasePropertiesValidationError) {
		return {
			kind: "validation-failure",
			caseType: err.caseType,
			failures: err.failures,
		};
	}
	return {
		kind: "error",
		message: err instanceof Error ? err.message : "Failed to seed cases.",
	};
}

/**
 * Flatten a `CaseRow`'s JSONB document + `case_name` into the
 * `Map<string, string>` shape `useFormEngine` consumes as preload.
 * `case_name` folds into the map under its own key so the form
 * engine sees one source — mirrors the runtime path where the
 * term compiler reads it via `RESERVED_SCALAR_COLUMNS`.
 *
 * `null` values become `""` — the form engine treats missing
 * case-data the same as empty, and JSONB `null` is the same
 * domain state as "no value preloaded".
 */
export function caseRowToFormPreload(row: CaseRow): Map<string, string> {
	const preload = new Map<string, string>();
	preload.set("case_name", row.case_name);
	for (const [key, value] of Object.entries(row.properties)) {
		preload.set(key, jsonValueToString(value));
	}
	return preload;
}

function jsonValueToString(value: JsonValue): string {
	if (value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	// Arrays + objects: round-trippable shape for agent / debug
	// inspection. The form engine has no native handling.
	return JSON.stringify(value);
}

/**
 * Read a column's display value off a `CaseRow`. Resolves
 * reserved scalar columns first, falls through to `row.properties`,
 * `""` for absent. Lives here so every render surface uses the
 * same coercion.
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
