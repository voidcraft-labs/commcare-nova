// lib/domain/predicate/jsonSchema.ts
//
// Generate a JSON Schema document from a CaseType definition.
//
// The blueprint's `CaseType.properties[].data_type` (see
// `lib/domain/blueprint.ts`) is the source of truth for property types;
// this module transforms it into the JSON Schema the case database uses
// for write-side validation. Bad writes are rejected at the database
// boundary, so reads can rely on values matching their declared types
// without any runtime coercion downstream.
//
// The output is a draft-2020-12-compatible JSON Schema. The shape is
// precise enough for `ajv` (the validator the case-store uses at every
// API-route write); it deliberately omits `$schema` and `$id` since
// those are added at the persistence boundary (one schema per case
// type per app, keyed there).
//
// Why this lives in the predicate package: the predicate type checker
// consumes the same `data_type` enum to decide which comparison
// operators are legal on a property, and the runtime SQL compiler
// reads it to pick column types. Keeping the data-type-to-shape
// mapping here keeps every consumer of `data_type` reasoning about
// the same bridge between blueprint and runtime.

import {
	type CaseProperty,
	type CaseType,
	casePropertyDataTypes,
} from "@/lib/domain";
import { unhandledKindMessage } from "./errors";

// CommCare's geopoint wire format from XForm GPS submissions: four
// space-separated decimal numbers — `latitude longitude altitude
// accuracy`.
//
// Pattern verified against CCHQ's own parser test suite at
// `corehq/ex-submodules/couchforms/tests/test_geopoint.py::test_valid_geopoint_properties`,
// which exercises the strict (4-element) and flexible (2-element)
// acceptance paths. Concrete accepted examples from that test:
//   '42.3739063 -71.1109113 0.0 886.0'
//   '-7.130 -41.563 7.53E-4 8.0'
//   '-7.130 -41.563 -2.2709742188453674E-4 8.0'
// Splitting + element-count semantics come from the parser at
// `corehq/ex-submodules/couchforms/geopoint.py::_extract_elements` —
// `split(' ')` on a literal single ASCII space, then a strict-mode
// count of exactly 4.
//
// We accept:
//   - 4 space-separated decimals (single ASCII space, not \s — tabs and
//     newlines are not accepted because CCHQ splits on `' '`).
//   - Optional sign (`-?`); CCHQ's accepted set does not include leading
//     `+`, so we don't accept it either.
//   - Optional fractional part.
//   - Optional scientific notation `[eE][+-]?<digits>`.
//
// We do NOT accept (and CCHQ's accepted set does not include):
//   - 2-element flexible-mode strings — those come from search inputs
//     and the case-list search XPath functions, not from stored case
//     data, so they don't belong on the case-database write path.
//   - Out-of-range lat/lon — CCHQ's `_validate_range` catches those at
//     parse time (`geopoint.py::_validate_range`); here the schema is
//     structural, so range enforcement belongs in a downstream layer
//     (the type checker or a runtime check).
//   - Bare `NaN` literals — CCHQ rejects these on lat/lon (see
//     `test_geopoint.py::test_invalid_geopoint_properties`).
//     Altitude/accuracy on the wire are decimal numbers; NaN appears
//     only as the in-memory default after a flexible 2-element parse
//     extends to 4.
//
// Build the pattern from a `DECIMAL` fragment so the four-element
// repetition is obvious at a glance and so future tweaks (e.g.
// permitting Geocoder's 2-element form on a different code path) stay
// structural rather than copy-pasted.
const DECIMAL = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const GEOPOINT_PATTERN = `^${DECIMAL}(?: ${DECIMAL}){3}$`;

// The `int` data type compiles to Postgres `integer` (int4) at the
// case-store boundary (`POSTGRES_CAST_FOR_DATA_TYPE.int` in
// `lib/case-store/sql/dataTypeTokens.ts`). A bare `{ type:
// "integer" }` accepts any integer, but the `(properties->>'k')::integer`
// cast the write path's expression index evaluates rejects anything
// outside int4's signed-32-bit range with a raw
// `integer out of range` Postgres error at INSERT — the same class of
// "AJV accepts, the Postgres cast rejects" failure as a fractional
// value under an int index. Bounding the schema to int4 makes AJV's
// acceptance set match the cast's, so an out-of-range value fails as
// a typed `CasePropertiesValidationError` at the write boundary
// rather than a 500 from the database. The case-store boundary owns
// the cast token; this bound must track it (the cross-layer round
// trip is pinned by `lib/case-store/postgres/__tests__/store.test.ts`).
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

/**
 * The top-level shape: a closed object whose keys are the case type's
 * property names. `additionalProperties: false` is load-bearing — the
 * write-side validator's whole job is rejecting payloads that try to
 * land properties the blueprint never declared.
 *
 * Note on requiredness: the schema is a closed object (rejects unknown
 * keys) but emits no `required` array — every declared property is
 * implicitly optional. Schema changes don't migrate existing case
 * rows, so a property added to the blueprint can be absent from older
 * rows without invalidating them. The closed shape rejects *unknown*
 * keys, not missing known keys.
 */
export type CaseTypeJsonSchema = {
	type: "object";
	properties: Record<string, CaseTypePropertyJsonSchema>;
	additionalProperties: false;
};

/**
 * Per-property schema. Intentionally a loose union (a `string` flavor
 * could technically carry both `format` and `pattern` simultaneously) —
 * tightening to a per-flavor discriminated union pulls in plumbing the
 * downstream tooling doesn't need and obscures the simple
 * data_type-to-shape mapping the file is built around. The schema
 * emitter never produces an inconsistent combination because each arm
 * of the switch sets at most one of those fields.
 *
 * There is deliberately no `enum` flavor: select values validate as
 * plain strings (see the `single_select` arm below for why an
 * option-value enum poisons rows under merged-document validation).
 */
export type CaseTypePropertyJsonSchema =
	| { type: "string"; format?: string; pattern?: string }
	| { type: "integer"; minimum: number; maximum: number }
	| { type: "number" }
	| { type: "array"; items: { type: "string" } };

/**
 * Convert a `CaseType` to a JSON Schema document. Pure — no
 * side effects, no I/O, output is structurally derived from the input.
 * Stable property iteration order matches the blueprint's declaration
 * order (object insertion order), which downstream snapshot tests can
 * rely on.
 *
 * `case_name` is filtered out of the property output. The blueprint
 * surface admits `case_name` on a case type's `properties[]` (the SA
 * + author UI treat it as a regular declaration so the field-editor
 * can carry its label, default value, etc.), but the case-store
 * stores `case_name` as a top-level scalar column on `cases` —
 * `properties` JSONB never carries it. The JSON Schema validator
 * runs against the JSONB document only, so emitting `case_name` here
 * would force every write to land an unwanted JSONB key.
 * `additionalProperties: false` would then reject any write that
 * routes `case_name` to its column rather than the document. The
 * column's non-empty CHECK constraint is the structural guarantee
 * for the field; the AJV schema covers user-defined properties only.
 */
export const RESERVED_NON_PROPERTY_NAMES: ReadonlySet<string> = new Set([
	"case_name",
]);

export function caseTypeToJsonSchema(caseType: CaseType): CaseTypeJsonSchema {
	const properties: Record<string, CaseTypePropertyJsonSchema> = {};
	for (const prop of caseType.properties) {
		if (RESERVED_NON_PROPERTY_NAMES.has(prop.name)) continue;
		properties[prop.name] = propertyToSchema(prop);
	}
	return {
		type: "object",
		properties,
		additionalProperties: false,
	};
}

/**
 * Map a single `CaseProperty` to its JSON Schema shape.
 *
 * The constraints emitted here are exactly the ones the SQL compiler's
 * Postgres casts depend on — the int4 bounds and the date/time formats
 * keep AJV's acceptance set aligned with the casts so a bad value fails
 * as a typed validation error at the write boundary instead of a raw
 * Postgres error at query/index time. Select kinds carry NO value
 * constraint beyond their string/array shape (rationale on the
 * `single_select` arm) — no cast reads them typed, so there is nothing
 * to protect.
 *
 * Default for missing data_type: `casePropertySchema.data_type` is
 * `.optional()` in `lib/domain/blueprint.ts`. We treat the absent
 * variant as `text` here — CommCare's wire default for properties
 * without an explicit type is text.
 */
function propertyToSchema(prop: CaseProperty): CaseTypePropertyJsonSchema {
	switch (prop.data_type) {
		case undefined:
		case "text":
			return { type: "string" };
		case "int":
			// Bounded to int4 so AJV rejects values the `::integer`
			// cast would (see `INT4_MIN` / `INT4_MAX`).
			return { type: "integer", minimum: INT4_MIN, maximum: INT4_MAX };
		case "decimal":
			return { type: "number" };
		case "date":
			return { type: "string", format: "date" };
		case "time":
			return { type: "string", format: "time" };
		case "datetime":
			return { type: "string", format: "date-time" };
		case "single_select":
			// No `enum` over the option values — deliberately. Select values
			// are plain strings at every layer that matters (the XForms wire,
			// the SQL compiler's text reads, `tryCastValue`'s retype arm), and
			// option lists are FORM UI, not a data constraint: CommCare never
			// re-validates stored case data against an app's current choices.
			// Because the write path validates the MERGED row document, an
			// option-value enum here turns every option edit or text→select
			// conversion into a row poisoner — a case holding yesterday's
			// legal value fails validation on its next write of ANY property.
			// Values outside the current options are legitimate history; the
			// explicit `narrow-options` migration (quarantine) is the opt-in
			// path for callers that want them flushed.
			return { type: "string" };
		case "multi_select":
			// Array-shaped (one element per selected value) but item values
			// are unconstrained — same no-enum rationale as `single_select`.
			return { type: "array", items: { type: "string" } };
		case "geopoint":
			return { type: "string", pattern: GEOPOINT_PATTERN };
		default: {
			// Exhaustiveness check. If a new variant is added to the
			// `data_type` enum in `lib/domain/blueprint.ts`, the assignment
			// to `never` becomes a compile-time error here, forcing the new
			// case to be wired through this generator before the project
			// compiles. The runtime throw guards the same invariant for any
			// payload that reaches via untyped boundaries.
			const _exhaustive: never = prop.data_type;
			throw new Error(
				unhandledKindMessage({
					where: "caseTypeToJsonSchema",
					family: "CasePropertyDataType",
					received: _exhaustive,
					knownKinds: casePropertyDataTypes,
				}),
			);
		}
	}
}
