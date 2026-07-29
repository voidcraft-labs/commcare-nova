import { z } from "zod";
import { lookupOptionsSourceSchema } from "../lookupCarriers";
import { type SelectOption, selectOptionSchema } from "./base";

export const inlineOptionsSourceSchema = z
	.object({
		kind: z.literal("inline"),
		options: z.array(selectOptionSchema).min(2),
	})
	.strict();

export const selectOptionsSourceSchema = z.discriminatedUnion("kind", [
	inlineOptionsSourceSchema,
	lookupOptionsSourceSchema,
]);

export type InlineOptionsSource = z.infer<typeof inlineOptionsSourceSchema>;
export type SelectOptionsSource = z.infer<typeof selectOptionsSourceSchema>;

export function inlineOptionsOf(
	source: SelectOptionsSource,
): readonly SelectOption[] | undefined {
	return source.kind === "inline" ? source.options : undefined;
}

z.globalRegistry.add(selectOptionsSourceSchema, { id: "SelectOptionsSource" });
