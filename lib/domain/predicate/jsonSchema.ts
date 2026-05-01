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

// CommCare's geopoint wire format: "lat lon" (space-separated decimals,
// each optionally negative, with optional fractional parts). Mirrors
// XForm's geopoint binding so the same string round-trips through HQ
// and the local case database without reformatting. Pulled out as a
// constant because the predicate type checker and the SQL compiler
// will eventually reach for the same regex.
const GEOPOINT_PATTERN = "^-?\\d+\\.?\\d*\\s-?\\d+\\.?\\d*$";

/**
 * The top-level shape: a closed object whose keys are the case type's
 * property names. `additionalProperties: false` is load-bearing — the
 * write-side validator's whole job is rejecting payloads that try to
 * land properties the blueprint never declared.
 */
export type JsonSchema = {
	type: "object";
	properties: Record<string, PropertySchema>;
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
export type PropertySchema =
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
export function caseTypeToJsonSchema(caseType: CaseType): JsonSchema {
	const properties: Record<string, PropertySchema> = {};
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
 * undefined or empty, the emitted schema carries `enum: []`, which
 * matches no string at all. That's intentional — a select property is
 * only valid to write to once it has options, so reflecting the
 * blueprint's "no options yet" state as an unsatisfiable schema lets
 * the write-side validator reject placeholder rows the same way it
 * rejects any other invalid value. Silently dropping the `enum`
 * constraint would defeat that.
 *
 * Default for missing data_type: `casePropertySchema.data_type` is
 * `.optional()` in `lib/domain/blueprint.ts`. We treat the absent
 * variant as `text` here — same treatment the rest of the system
 * gives to legacy properties that predate the data_type field.
 */
function propertyToSchema(prop: CaseProperty): PropertySchema {
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
			return {
				type: "string",
				enum: (prop.options ?? []).map((o) => o.value),
			};
		case "multi_select":
			return {
				type: "array",
				items: {
					type: "string",
					enum: (prop.options ?? []).map((o) => o.value),
				},
			};
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
