import { z } from "zod";
import { selectOptionSchema } from "./fields/base";
import { lookupColumnIdSchema, lookupTableIdSchema } from "./lookupIds";
import { predicateSchema } from "./predicate/types";

/**
 * A select's complete, exclusive choice source.
 *
 * Inline and Project-table choices are mutually exclusive stored shapes. There
 * is no field-level option list beside this union, no precedence rule, and no
 * inactive fallback body. Every consumer switches on `kind`.
 */
export const inlineOptionsSourceSchema = z
	.object({
		kind: z.literal("inline"),
		options: z.array(selectOptionSchema).min(2),
	})
	.strict();

export const lookupOptionsSourceSchema = z
	.object({
		kind: z.literal("lookup"),
		tableId: lookupTableIdSchema,
		valueColumnId: lookupColumnIdSchema,
		labelColumnId: lookupColumnIdSchema,
		filter: predicateSchema.optional(),
	})
	.strict();

export const selectOptionsSourceSchema = z.discriminatedUnion("kind", [
	inlineOptionsSourceSchema,
	lookupOptionsSourceSchema,
]);

export type InlineOptionsSource = z.infer<typeof inlineOptionsSourceSchema>;
export type LookupOptionsSource = z.infer<typeof lookupOptionsSourceSchema>;
export type SelectOptionsSource = z.infer<typeof selectOptionsSourceSchema>;

// Keep recursive Predicate payloads behind one stable definition when this
// union appears in generated schemas. Register in place; `.meta()` would clone
// the shared node and duplicate recursive definitions.
z.globalRegistry.add(selectOptionsSourceSchema, { id: "SelectOptionsSource" });
