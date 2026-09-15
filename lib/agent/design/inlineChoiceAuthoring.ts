import { z } from "zod";
import {
	strictWireJsonSchema,
	stripNullProperties,
} from "@/lib/agent/strictStructuredOutput";
import {
	selectOptionValueSchema,
	suggestSelectOptionValue,
} from "@/lib/domain/selectOptionValue";
import { mapDesignSchemaSlots } from "./identityProjection";
import { designChoiceSchema, INLINE_CHOICES_MARKER } from "./inlineChoices";

const authoredChoicesSchema = z
	.array(
		z.union([
			designChoiceSchema.shape.label,
			designChoiceSchema.extend({
				value: selectOptionValueSchema
					.describe("Saved code. No whitespace or quotes.")
					.optional(),
			}),
		]),
	)
	.describe(
		"Choice wording, in display order. Use a label, or supply a label and value when a specific saved code matters.",
	);

const authoredChoicesWire = (
	strictWireJsonSchema(z.object({ choices: authoredChoicesSchema })) as {
		properties: { choices: Record<string, unknown> };
	}
).properties.choices;

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function inlineChoicesAuthoringWireSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(inlineChoicesAuthoringWireSchema);
	if (!object(node)) return node;
	if (node[INLINE_CHOICES_MARKER] === true)
		return {
			...authoredChoicesWire,
			...(Array.isArray(node.type) && node.type.includes("null")
				? { type: ["array", "null"] }
				: {}),
		};
	return Object.fromEntries(
		Object.entries(node).map(([key, value]) => [
			key,
			inlineChoicesAuthoringWireSchema(value),
		]),
	);
}

/** Bind only marked choice arrays. Explicit codes reserve their values before
 * defaults are minted, so a preceding label cannot take a later supplied code. */
export function bindDesignInlineChoices(
	schema: z.ZodType,
	input: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
	let error: string | undefined;
	const value = mapDesignSchemaSlots(
		schema,
		input,
		INLINE_CHOICES_MARKER,
		(entry, path) => {
			if (entry === null || entry === undefined) return entry;
			const parsed = authoredChoicesSchema.safeParse(
				stripNullProperties(entry),
			);
			if (!parsed.success) {
				error ??= `${path.join(".")}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
				return entry;
			}
			const choices = parsed.data.map((choice) =>
				typeof choice === "string" ? { label: choice } : choice,
			);
			const taken = new Set(
				choices.flatMap((choice) =>
					choice.value === undefined ? [] : [choice.value],
				),
			);
			return choices.map((choice, index) => {
				const value =
					choice.value ??
					suggestSelectOptionValue(choice.label, `option_${index + 1}`, taken);
				taken.add(value);
				return { value, label: choice.label };
			});
		},
	);
	return error === undefined ? { ok: true, value } : { ok: false, error };
}
