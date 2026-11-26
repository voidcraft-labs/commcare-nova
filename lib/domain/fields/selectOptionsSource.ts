import { z } from "zod";
import { authoredCasePropertyNameSchema } from "../casePropertyName";
import {
	caseTypeNameSchema,
	conditionSchema,
	type Expression,
} from "../expression/types";
import { lookupOptionsSourceSchema } from "../lookupCarriers";
import { type SelectOption, selectOptionSchema } from "./base";

export const inlineOptionsSourceSchema = z.strictObject({
	kind: z.literal("inline"),
	options: z.array(selectOptionSchema).min(1),
});

/** Choices read the worker's available records; their values are case identities. */
export const caseOptionsSourceSchema = z.strictObject({
	kind: z.literal("cases"),
	caseType: caseTypeNameSchema,
	labelProperty: authoredCasePropertyNameSchema.describe(
		"Property name must use Nova's canonical case-property vocabulary.",
	),
	sortProperty: authoredCasePropertyNameSchema
		.optional()
		.describe(
			"Order choices by this record property's text. Omit to keep the device's record order.",
		),
	filter: conditionSchema.optional(),
});
export type CaseOptionsSource = z.infer<typeof caseOptionsSourceSchema>;
z.globalRegistry.add(caseOptionsSourceSchema, { id: "CaseOptionsSource" });

/** Names and opaque IDs from the worker's whole restored case database. */
export const availableCasesOptionsSourceSchema = z.strictObject({
	kind: z.literal("available-cases"),
});
export type AvailableCasesOptionsSource = z.infer<
	typeof availableCasesOptionsSourceSchema
>;
export type DeviceCaseOptionsSource =
	| CaseOptionsSource
	| AvailableCasesOptionsSource;

export const selectOptionsSourceSchema = z.discriminatedUnion("kind", [
	inlineOptionsSourceSchema,
	lookupOptionsSourceSchema,
	caseOptionsSourceSchema,
	availableCasesOptionsSourceSchema,
]);

export type InlineOptionsSource = z.infer<typeof inlineOptionsSourceSchema>;
export type SelectOptionsSource = z.infer<typeof selectOptionsSourceSchema>;

export function inlineOptionsOf(
	source: SelectOptionsSource,
): readonly SelectOption[] | undefined {
	return source.kind === "inline" ? source.options : undefined;
}

z.globalRegistry.add(selectOptionsSourceSchema, { id: "SelectOptionsSource" });

export function isDeviceCaseOptionsSource(
	source: SelectOptionsSource,
): source is DeviceCaseOptionsSource {
	return source.kind === "cases" || source.kind === "available-cases";
}

export function optionsSourceFilter(
	source: SelectOptionsSource,
): Expression | undefined {
	return "filter" in source ? source.filter : undefined;
}
