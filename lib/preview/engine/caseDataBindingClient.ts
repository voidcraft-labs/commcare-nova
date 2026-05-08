// lib/preview/engine/caseDataBindingClient.ts
//
// Client-bundle-safe helpers for the running-app view's data
// binding — the client-side surface consumed by React components
// in the case-list-config + preview screens. Mirror of
// `./caseDataBindingHelpers.ts`, which carries
// `import "server-only"` and reaches into the case-store's Cloud
// SQL connector graph. Every export here transforms in-memory
// shapes (`CaseRow` / `CaseRowWithCalculated` / `JsonValue` /
// `CalculatedValue` / `BlueprintDoc`) without touching `CaseStore`
// or any Postgres surface, so `"use client"` components that render
// a row's display value or project a doc-store snapshot down to the
// wire-serializable `BlueprintDoc` shape can value-import from here
// without dragging `lib/case-store/index.ts` (which transitively
// pulls in the Cloud SQL connector + `google-auth-library`) into
// their bundle.
//
// The running-app Server Actions (`./caseDataBinding.ts`) compose
// this module with `./caseDataBindingHelpers.ts`. Tests that
// exercise the I/O helpers against a real `PostgresCaseStore` reach
// into `caseDataBindingHelpers.ts` directly; tests of the
// projections + mappers reach here.
//
// Typed-error mappers live here too: `mapPopulateSampleCasesError`,
// `mapCaseListPreviewError`, `mapFilterPreviewError`, and
// `mapSubmitFormError` only inspect typed-error classes via
// `instanceof` — no runtime dependency on the case-store's I/O
// surface — so they're safe to ship to the client. The error
// classes are pulled directly from `@/lib/case-store/errors` (the
// leaf module) rather than the package barrel because the barrel
// also value-exports `withOwnerContext`, which pulls the Postgres
// connection layer in.

import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	SchemaNotSyncedError,
} from "@/lib/case-store/errors";
import type { BlueprintDoc, Column } from "@/lib/domain";
import { pickByKeys } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import type {
	CalculatedValue,
	CaseRow,
	CaseRowWithCalculated,
	JsonValue,
	LoadCaseListPreviewResult,
	LoadFilterPreviewResult,
	PopulateSampleCasesResult,
	SubmissionResult,
} from "./caseDataBindingTypes";

/**
 * The keys `blueprintDocSchema` declares — the persisted shape Server
 * Actions accept. Computed once at module load by reading
 * `blueprintDocSchema.shape` so `pickBlueprintDoc` (called from React
 * render paths on every state change) doesn't re-walk the schema each
 * call.
 *
 * Single source of truth: the Zod schema. Add a property to
 * `blueprintDocSchema` and it surfaces in this set automatically.
 */
const BLUEPRINT_DOC_KEYS: ReadonlySet<string> = new Set(
	Object.keys(blueprintDocSchema.shape),
);

/**
 * Project a `BlueprintDoc` (or superset like the doc store's
 * `BlueprintDocState`) down to the wire-serializable shape Server
 * Actions accept — every schema field plus `fieldParent`, nothing
 * else. The doc store carries action methods (`applyMany`,
 * `beginAgentWrite`, `endAgentWrite`, `load`) alongside data fields;
 * passing raw state into a Server Action would throw at React's RSC
 * serializer.
 *
 * Filters the source by the keys the schema declares, then re-attaches
 * `fieldParent` from the input — `fieldParent` is the in-memory reverse
 * index, rebuilt from `fieldOrder` on load and never persisted, so the
 * schema doesn't declare it. The explicit per-key filter is what makes
 * this projection (rather than a tolerant strip-via-parse): every
 * unknown key is dropped at the boundary, every known key is preserved
 * verbatim, and the doc-store invariants guarantee the remaining values
 * are already valid for the schema.
 */
export function pickBlueprintDoc<T extends BlueprintDoc>(
	state: T,
): BlueprintDoc {
	const picked = pickByKeys(
		state as unknown as Record<string, unknown>,
		BLUEPRINT_DOC_KEYS,
	);
	return {
		...(picked as Omit<BlueprintDoc, "fieldParent">),
		fieldParent: state.fieldParent,
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

/**
 * Coerce a JSONB value to its row-cell display string. Strings pass
 * through verbatim; numbers / booleans round-trip via `String(...)`;
 * arrays + objects emit `JSON.stringify(...)` so the agent / debug
 * inspector sees the round-trippable shape. JSONB `null` collapses
 * to `""` — the form engine treats missing case data the same as
 * empty, and the running-app preview surfaces an empty cell rather
 * than the literal string "null".
 */
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

/**
 * String coercion for a calculated cell value. The case-store's
 * `query` (with `calculated`) returns each value typed per the SQL
 * expression's resolved Postgres type — text / integer / numeric /
 * boolean / Date (date or timestamptz) / JSONB. The running-app
 * preview surfaces all six shapes as a single text cell.
 *
 * `Date` instances pass through `toISOString()` so the table
 * doesn't render the Date object's default string form.
 * `null` / `undefined` collapse to `""` so the cell is empty
 * rather than showing the literal "null". Other JSON shapes
 * (string / number / boolean / array / object) route through
 * `jsonValueToString`, which already handles the same coercion
 * the form-engine preload uses.
 */
function calculatedValueToString(value: CalculatedValue | undefined): string {
	if (value === undefined) return "";
	if (value instanceof Date) return value.toISOString();
	return jsonValueToString(value);
}

/**
 * Read a column's display value off a `CaseRowWithCalculated`,
 * dispatching on the column's discriminator. Calc-arm columns
 * resolve through `row.calculated[column.uuid]` — the case-store's
 * `query` projects each `calculated` expression into the SELECT
 * keyed by uuid, and the running-app preview reads the slot
 * directly. Non-calc kinds read the case property named by
 * `column.field` through the shared `caseRowDisplayValue` helper
 * so reserved-scalar resolution + JSONB coercion stay consistent
 * across every consumer.
 *
 * Returns the empty string for any kind whose slot is absent
 * (empty calc map, missing JSONB key, missing reserved scalar).
 * Callers render the empty string as an empty cell, the same
 * shape a row with a never-set property produces.
 */
export function evaluateColumnValue(
	column: Column,
	row: CaseRowWithCalculated,
): string {
	if (column.kind === "calculated") {
		return calculatedValueToString(row.calculated[column.uuid]);
	}
	return caseRowDisplayValue(row, column.field);
}

// ---------------------------------------------------------------
// Typed-error mappers
// ---------------------------------------------------------------
//
// Each mapper inspects an arbitrary thrown value and routes the
// case-store's typed user-domain errors to dedicated arms on the
// matching result union. Generic `Error`s and non-Error throws
// collapse to the `error` arm with a default message. The mappers
// only `instanceof`-check error classes — no I/O, no `CaseStore`
// dependency — so they're client-bundle safe.

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
 * Map errors from `readCaseListPreview` to typed result arms. The
 * three typed errors get dedicated arms so the live-preview client
 * surface can re-resolve / await the sync rather than render an
 * undifferentiated error message. Generic Errors fall through to
 * the `error` arm.
 */
export function mapCaseListPreviewError(
	err: unknown,
): LoadCaseListPreviewResult {
	if (err instanceof CaseTypeNotInBlueprintError) {
		return { kind: "missing-case-type", caseType: err.caseType };
	}
	if (err instanceof SchemaNotSyncedError) {
		return { kind: "schema-not-synced", caseType: err.caseType };
	}
	return {
		kind: "error",
		message: err instanceof Error ? err.message : "Failed to load preview.",
	};
}

/**
 * Map errors from `readFilterPreview` to typed `LoadFilterPreviewResult`
 * arms. `LoadFilterPreviewResult`'s error arms are a strict subset
 * of `LoadCaseListPreviewResult`'s (the only difference is the
 * paired `totalCount` on the success arms), so the mapping shape
 * is identical to `mapCaseListPreviewError` modulo the result
 * type. A separate function keeps the typed-result inference
 * tight at the call site — narrowing the union via a single
 * function with a polymorphic return would force the caller to
 * re-narrow.
 */
export function mapFilterPreviewError(err: unknown): LoadFilterPreviewResult {
	if (err instanceof CaseTypeNotInBlueprintError) {
		return { kind: "missing-case-type", caseType: err.caseType };
	}
	if (err instanceof SchemaNotSyncedError) {
		return { kind: "schema-not-synced", caseType: err.caseType };
	}
	return {
		kind: "error",
		message: err instanceof Error ? err.message : "Failed to load preview.",
	};
}

/**
 * Map the case-store's typed errors to typed `SubmissionResult`
 * arms. Mirrors `mapPopulateSampleCasesError` — the four user-
 * domain error classes each get a dedicated discriminator so the
 * running-app view's error toast surfaces structured detail rather
 * than the wrapped invariant body. A generic `Error` falls through
 * to the `error` arm; non-Error throws (rare but possible from RSC
 * framework code) collapse to a default message.
 */
export function mapSubmitFormError(err: unknown): SubmissionResult {
	if (err instanceof CaseNotFoundError) {
		return { kind: "case-not-found", caseId: err.caseId };
	}
	if (err instanceof CasePropertiesValidationError) {
		return {
			kind: "case-properties-validation",
			caseType: err.caseType,
			failures: err.failures,
		};
	}
	if (err instanceof CaseTypeNotInBlueprintError) {
		return { kind: "missing-case-type", caseType: err.caseType };
	}
	if (err instanceof SchemaNotSyncedError) {
		return { kind: "schema-not-synced", caseType: err.caseType };
	}
	return {
		kind: "error",
		message: err instanceof Error ? err.message : "Failed to submit form.",
	};
}
