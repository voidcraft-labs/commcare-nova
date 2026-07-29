import { z } from "zod";
import { lookupColumnIdSchema, lookupTableIdSchema } from "./lookupIds";
import { predicateSchema } from "./predicate/types";

/**
 * A select whose choices come from one Project lookup table.
 *
 * Stable table/column identities are persisted here; display names and wire
 * tags remain projections of the current lookup definition. The source
 * discriminant is final: a select has either inline options or this lookup
 * source, never both.
 */
export const lookupOptionsSourceSchema = z
	.object({
		kind: z.literal("lookup"),
		tableId: lookupTableIdSchema,
		valueColumnId: lookupColumnIdSchema,
		labelColumnId: lookupColumnIdSchema,
		filter: predicateSchema.optional(),
	})
	.strict();

export type LookupOptionsSource = z.infer<typeof lookupOptionsSourceSchema>;

// Keep recursive Predicate payloads behind one stable definition when this
// carrier appears in generated schemas. Register in place; `.meta()` would
// clone the shared node and duplicate recursive definitions.
z.globalRegistry.add(lookupOptionsSourceSchema, { id: "LookupOptionsSource" });
