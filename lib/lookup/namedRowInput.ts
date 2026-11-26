import { z } from "zod";
import {
	lookupCellInputSchema,
	lookupTextSchema,
	lookupWireNameSchema,
} from "./schema";

const namedTextSchema = z.strictObject({
	name: lookupWireNameSchema,
	text: lookupTextSchema,
});
function namesAreUnique(values: readonly { name: string }[]) {
	return new Set(values.map((value) => value.name)).size === values.length;
}
const namedTexts = z
	.array(namedTextSchema)
	.max(250)
	.refine(namesAreUnique, "Give one text per detail.");
export const rowContentSchema = z.strictObject({
	attributes: namedTexts
		.optional()
		.describe(
			"Row details, by their export names. Include an exact text for each declared row detail.",
		),
	occurrences: z
		.array(
			z.strictObject({
				name: lookupWireNameSchema.describe("Repeated column export name."),
				values: z.array(
					z.strictObject({
						text: lookupTextSchema,
						properties: namedTexts.optional(),
					}),
				),
			}),
		)
		.max(250)
		.refine(namesAreUnique, "Give one ordered list per repeated column.")
		.optional(),
});
function namedTextsOf(values: z.infer<typeof namedTexts> = []) {
	return Object.fromEntries(values.map(({ name, text }) => [name, text]));
}
export function contentInput(
	content: z.infer<typeof rowContentSchema> | undefined,
) {
	if (content === undefined) return {};
	return {
		content: {
			attributes: namedTextsOf(content.attributes),
			occurrences: Object.fromEntries(
				(content.occurrences ?? []).map(({ name, values }) => [
					name,
					values.map(({ text, properties }) => ({
						text,
						properties: namedTextsOf(properties),
					})),
				]),
			),
		},
	};
}
/** Portable row input. Both names and values stay exact until the current table binds them. */
export const namedImportRowsSchema = z
	.array(
		z.strictObject({
			cells: z
				.array(
					z.strictObject({
						name: lookupWireNameSchema,
						value: lookupCellInputSchema,
					}),
				)
				.max(250)
				.refine(namesAreUnique, "Give each scalar column once."),
			content: rowContentSchema.optional(),
		}),
	)
	.min(1)
	.max(5000);
export const STRUCTURED_ROW_IMPORT_MAX_BYTES = 256 * 1024;
