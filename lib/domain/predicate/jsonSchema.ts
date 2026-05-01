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
// precise enough for tools like ajv / pg_jsonschema; it deliberately
// omits `$schema` and `$id` since those are added at the persistence
// boundary (one schema per case type per app, keyed there).
//
// Why this lives in the predicate package: the predicate type checker
// (Tasks 4-6) consumes the same `data_type` enum to decide which
// comparison operators are legal on a property, and the runtime SQL
// compiler (Tasks 10-11) reads it to pick column types. Keeping the
// data-type-to-shape mapping here keeps every consumer of `data_type`
// reasoning about the same bridge between blueprint and runtime.

import type { CaseProperty, CaseType } from "@/lib/domain";

// CommCare's geopoint wire format: four space-separated decimals —
// `latitude longitude altitude accuracy`. Verified against
// `corehq/ex-submodules/couchforms/geopoint.py`:
//   - line 44: `input_string.split(' ')` — splits on a literal single
//     ASCII space (NOT `\s`), so tabs and newlines are not accepted.
//   - line 48: the strict path requires exactly 4 elements; the
//     2-element flexible path is reserved for case-search Geocoder
//     input boxes, NOT stored case data, so we reject 2-element
//     payloads here.
//   - lines 55-65: `_to_decimal` calls Decimal(n) on each element,
//     which accepts scientific notation (e.g. `1.23e5`, `-1.23E-5`).
// Range checks (`-90 <= lat <= 90`, `-180 <= lon <= 180`) live at
// `_validate_range` (lines 68-71); regex can't express ranges cheaply
// and that's an application-layer concern. Altitude/accuracy may
// degenerate to NaN-as-decimal at the application layer but on the
// wire they arrive as decimal strings, so the regex doesn't need a
// `NaN` literal alternation.
//
// Build the pattern from a `DECIMAL` fragment so the four-element
// repetition is obvious at a glance and so future tweaks (e.g.
// permitting Geocoder's 2-element form on a different code path)
// stay structural rather than copy-pasted.
const DECIMAL = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const GEOPOINT_PATTERN = `^${DECIMAL}(?: ${DECIMAL}){3}$`;

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
 * could technically carry both `format` and `enum` simultaneously) —
 * tightening to a per-flavor discriminated union pulls in plumbing the
 * downstream tooling doesn't need and obscures the simple
 * data_type-to-shape mapping the file is built around. The schema
 * emitter never produces an inconsistent combination because each arm
 * of the switch sets at most one of those fields.
 */
export type CaseTypePropertyJsonSchema =
	| { type: "string"; format?: string; enum?: string[]; pattern?: string }
	| { type: "integer" }
	| { type: "number" }
	| { type: "array"; items: { type: "string"; enum?: string[] } };

/**
 * Convert a `CaseType` to a JSON Schema document. Pure — no
 * side effects, no I/O, output is structurally derived from the input.
 * Stable property iteration order matches the blueprint's declaration
 * order (object insertion order), which downstream snapshot tests can
 * rely on.
 */
export function caseTypeToJsonSchema(caseType: CaseType): CaseTypeJsonSchema {
	const properties: Record<string, CaseTypePropertyJsonSchema> = {};
	for (const prop of caseType.properties) {
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
 * Empty-options behavior for select kinds: when `prop.options` is
 * undefined or empty, the emitted schema falls back to a permissive
 * shape — `{ type: "string" }` for `single_select`, `{ type: "array",
 * items: { type: "string" } }` for `multi_select`. Two reasons it
 * doesn't emit `enum: []`:
 *   1. Ajv 8 (and other strict validators) reject empty-enum schemas
 *      at compile time; emitting `enum: []` would block ALL writes
 *      against the case type rather than just writes to this property.
 *   2. The "fail closed until configured" intent is reasonable but
 *      placed at the wrong layer — mid-edit blueprints don't carry
 *      real authored data, so locking the validator against them
 *      creates spurious breakage. Once the author configures options,
 *      the emitted schema tightens automatically.
 *
 * Default for missing data_type: `casePropertySchema.data_type` is
 * `.optional()` in `lib/domain/blueprint.ts`. We treat the absent
 * variant as `text` here — same treatment the rest of the system
 * gives to legacy properties that predate the data_type field.
 */
function propertyToSchema(prop: CaseProperty): CaseTypePropertyJsonSchema {
	switch (prop.data_type) {
		case undefined:
		case "text":
			return { type: "string" };
		case "int":
			return { type: "integer" };
		case "decimal":
			return { type: "number" };
		case "date":
			return { type: "string", format: "date" };
		case "time":
			return { type: "string", format: "time" };
		case "datetime":
			return { type: "string", format: "date-time" };
		case "single_select":
			return prop.options && prop.options.length > 0
				? { type: "string", enum: prop.options.map((o) => o.value) }
				: { type: "string" };
		case "multi_select":
			return prop.options && prop.options.length > 0
				? {
						type: "array",
						items: {
							type: "string",
							enum: prop.options.map((o) => o.value),
						},
					}
				: { type: "array", items: { type: "string" } };
		case "geopoint":
			return { type: "string", pattern: GEOPOINT_PATTERN };
		default: {
			// Exhaustiveness check. If a new variant is added to the
			// `data_type` enum in `lib/domain/blueprint.ts`, the assignment
			// to `never` becomes a compile-time error here, forcing the new
			// case to be wired through this generator before the project
			// compiles. The runtime throw guards the same invariant for any
			// payload that reaches us via untyped boundaries.
			const _exhaustive: never = prop.data_type;
			throw new Error(
				`caseTypeToJsonSchema: unhandled data_type ${String(_exhaustive)}`,
			);
		}
	}
}
