import { z } from "zod";
import { authoredCasePropertyNameSchema } from "../casePropertyName";
import { caseTypeNameSchema, conditionSchema } from "../expression/types";
import { lookupOptionsSourceSchema } from "../lookupCarriers";
import { type SelectOption, selectOptionSchema } from "./base";

export const inlineOptionsSourceSchema = z.strictObject({
	kind: z.literal("inline"),
	options: z.array(selectOptionSchema).min(2),
});

/** Choices read the worker's available records; their values are case identities. */
export const caseOptionsSourceSchema = z.strictObject({
	kind: z.literal("cases"),
	caseType: caseTypeNameSchema,
	labelProperty: authoredCasePropertyNameSchema.describe(
		"Property name must use Nova's canonical case-property vocabulary.",
	),
	filter: conditionSchema.optional(),
});
export type CaseOptionsSource = z.infer<typeof caseOptionsSourceSchema>;
z.globalRegistry.add(caseOptionsSourceSchema, { id: "CaseOptionsSource" });

export const selectOptionsSourceSchema = z.discriminatedUnion("kind", [
	inlineOptionsSourceSchema,
	lookupOptionsSourceSchema,
	caseOptionsSourceSchema,
]);

export type InlineOptionsSource = z.infer<typeof inlineOptionsSourceSchema>;
export type SelectOptionsSource = z.infer<typeof selectOptionsSourceSchema>;

export function inlineOptionsOf(
	source: SelectOptionsSource,
): readonly SelectOption[] | undefined {
	return source.kind === "inline" ? source.options : undefined;
}

z.globalRegistry.add(selectOptionsSourceSchema, { id: "SelectOptionsSource" });
