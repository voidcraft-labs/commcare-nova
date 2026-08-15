/**
 * Strict structured output — the wire projection that makes every
 * `runStructured` schema acceptable to OpenAI's strict `json_schema` mode,
 * so the provider GRAMMAR-ENFORCES the structure during generation instead
 * of trusting a model to freehand tens of thousands of JSON characters
 * (observed live: a complete 57k-char author response that failed the Zod
 * parse — a failure class strict decoding makes structurally impossible).
 *
 * Same idiom as the SA tool surface's `wireSchemas.ts`: the WIRE shape is a
 * projection; the Zod schema stays untouched as the real gate (including
 * the refinements no decoder can enforce — the design graph proof runs
 * inside the parse). The projection:
 *
 *  - `oneOf` → `anyOf` (zod emits discriminated unions as `oneOf`, which
 *    strict mode rejects; the arms are discriminator-exclusive, so `anyOf`
 *    is semantically identical);
 *  - every object property becomes REQUIRED, with formerly-optional slots
 *    made null-unioned (strict mode's documented spelling of optionality —
 *    the model emits a clean `null` for "nothing here");
 *  - `default` annotations are stripped (strict rejects them; Zod applies
 *    the default when the null is stripped back to absence).
 *
 * The validation bridge undoes the null spelling before the real parse:
 * `null` property values are deleted so the Zod schema sees the absence it
 * was written around. That is sound because no model-facing schema in this
 * seam uses `.nullable()` — `null` can only mean "the wire made me say
 * something" — and `assertNoNullableSlots` (called by the projection's
 * tests) keeps that assumption from rotting silently.
 */

import { jsonSchema, type Schema, zodSchema } from "ai";
import type { z } from "zod";

type JsonNode = Record<string, unknown>;

function isObjectNode(value: unknown): value is JsonNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wrap one property schema so `null` is admissible — the strict-mode
 *  spelling of "optional". */
function nullUnion(node: unknown): unknown {
	if (isObjectNode(node)) {
		// A bare type keyword takes the type-array spelling.
		if (typeof node.type === "string" && node.anyOf === undefined) {
			return { ...node, type: [node.type, "null"] };
		}
		// A union (incl. one this transform just rewrote) gains a null arm.
		if (Array.isArray(node.anyOf)) {
			const arms = node.anyOf as unknown[];
			const hasNull = arms.some(
				(arm) => isObjectNode(arm) && arm.type === "null",
			);
			return hasNull ? node : { ...node, anyOf: [...arms, { type: "null" }] };
		}
	}
	// $ref or anything else: an explicit two-arm union.
	return { anyOf: [node, { type: "null" }] };
}

/**
 * Recursively project one JSON-schema node into OpenAI's strict subset.
 * Throws on a construct with no strict spelling (a `z.record`-style typed
 * `additionalProperties`), so an incompatible schema fails at call
 * construction — loudly, offline-testable — never as a provider 400.
 */
function projectNode(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(projectNode);
	if (!isObjectNode(node)) return node;

	const out: JsonNode = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "default") continue;
		if (key === "propertyNames") {
			// zod v4's z.record marker: open keys with a name schema.
			throw new Error(
				"This schema is a record/dictionary (open keys), which OpenAI's strict json_schema mode cannot express. Name the keys as explicit properties, or restructure the record as an array of {key, value} entries.",
			);
		}
		if (key === "oneOf") {
			out.anyOf = projectNode(value);
			continue;
		}
		if (key === "additionalProperties") {
			if (value !== false && value !== true) {
				throw new Error(
					"This schema types its additionalProperties (a record/dictionary shape), which OpenAI's strict json_schema mode cannot express. Name the keys as explicit properties, or restructure the record as an array of {key, value} entries.",
				);
			}
			out.additionalProperties = false;
			continue;
		}
		if (key === "properties" && isObjectNode(value)) {
			const projected: JsonNode = {};
			for (const [prop, propSchema] of Object.entries(value)) {
				projected[prop] = projectNode(propSchema);
			}
			out.properties = projected;
			continue;
		}
		// Structural carriers whose values are themselves schemas.
		if (
			key === "items" ||
			key === "anyOf" ||
			key === "allOf" ||
			key === "$defs" ||
			key === "definitions"
		) {
			out[key] =
				key === "$defs" || key === "definitions"
					? Object.fromEntries(
							Object.entries(value as JsonNode).map(([name, def]) => [
								name,
								projectNode(def),
							]),
						)
					: projectNode(value);
			continue;
		}
		out[key] = value;
	}

	// Strict mode: every property required; optionality is the null union.
	if (out.type === "object" && isObjectNode(out.properties)) {
		const keys = Object.keys(out.properties);
		const required = new Set(
			Array.isArray(out.required) ? (out.required as string[]) : [],
		);
		for (const key of keys) {
			if (!required.has(key)) {
				(out.properties as JsonNode)[key] = nullUnion(
					(out.properties as JsonNode)[key],
				);
			}
		}
		out.required = keys;
		out.additionalProperties = false;
	}

	return out;
}

/** Delete `null`-valued properties everywhere, restoring the absence the
 *  Zod schemas were written around. Array ITEMS are never touched — the
 *  projection admits null only as a property value. */
export function stripNullProperties(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripNullProperties);
	if (!isObjectNode(value)) return value;
	const out: JsonNode = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry === null) continue;
		out[key] = stripNullProperties(entry);
	}
	return out;
}

/**
 * Every position the wire treats as A SCHEMA must say what it admits:
 * OpenAI's strict validator rejects a bare `{}` ("schema must have a
 * 'type' key" — its live answer to `z.unknown()`, which the documented
 * rules don't mention; learned from a rejected request). Walking the
 * schema positions here turns that live 400 into an offline throw naming
 * the untyped slot.
 */
function assertSchemaPositionsTyped(node: unknown, path: string): void {
	if (!isObjectNode(node)) return;
	const carriesShape =
		"type" in node ||
		"enum" in node ||
		"const" in node ||
		"$ref" in node ||
		"anyOf" in node ||
		"allOf" in node;
	if (!carriesShape) {
		throw new Error(
			`The schema slot at ${path} admits anything (a z.unknown()/z.any() emission), which OpenAI's strict json_schema mode rejects — every slot must name a type. Give the slot a concrete shape.`,
		);
	}
	if (isObjectNode(node.properties)) {
		for (const [key, value] of Object.entries(node.properties)) {
			assertSchemaPositionsTyped(value, `${path}.${key}`);
		}
	}
	if (node.items !== undefined) {
		assertSchemaPositionsTyped(node.items, `${path}.items`);
	}
	for (const carrier of ["anyOf", "allOf"] as const) {
		const arms = node[carrier];
		if (Array.isArray(arms)) {
			arms.forEach((arm, index) => {
				assertSchemaPositionsTyped(arm, `${path}.${carrier}[${index}]`);
			});
		}
	}
	for (const defs of ["$defs", "definitions"] as const) {
		const entries = node[defs];
		if (isObjectNode(entries)) {
			for (const [name, def] of Object.entries(entries)) {
				assertSchemaPositionsTyped(def, `${path}.${defs}.${name}`);
			}
		}
	}
}

/** Project one Zod schema's wire emission into the strict subset. Exported
 *  for the tests that prove each production schema projects cleanly. */
export function strictWireJsonSchema(schema: z.ZodType): JsonNode {
	const emitted = zodSchema(schema).jsonSchema as JsonNode;
	const projected = projectNode(emitted) as JsonNode;
	if (projected.type !== "object") {
		throw new Error(
			"OpenAI's strict json_schema mode requires an object at the schema root. Wrap this schema's payload in an object with named properties.",
		);
	}
	assertSchemaPositionsTyped(projected, "$");
	return projected;
}

/**
 * The `runStructured` seam's schema: strict wire projection out, null-strip
 * + the ORIGINAL Zod parse (refinements included) back in. The returned
 * validation failure is the ZodError itself, so the unparseable-output
 * logging can name the failing paths.
 */
export function strictStructuredSchema<T>(schema: z.ZodType<T>): Schema<T> {
	return jsonSchema<T>(strictWireJsonSchema(schema) as never, {
		validate: (value) => {
			const parsed = schema.safeParse(stripNullProperties(value));
			return parsed.success
				? { success: true, value: parsed.data }
				: { success: false, error: parsed.error };
		},
	});
}
