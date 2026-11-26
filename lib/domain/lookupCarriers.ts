import { z } from "zod";
import { conditionSchema } from "./expression/types";
import { lookupTableIdSchema } from "./lookupIds";
import { lookupReadSchema } from "./lookupRead";

/**
 * A select whose choices come from one Project lookup table.
 *
 * Stable table/column identities are persisted here; display names and wire
 * tags remain projections of the current lookup definition. The source
 * discriminant is final: a select has either inline options or this lookup
 * source, never both.
 */
export const lookupOptionsSourceSchema = z.strictObject({
	kind: z.literal("lookup"),
	tableId: lookupTableIdSchema,
	valueColumnId: lookupReadSchema,
	labelColumnId: lookupReadSchema,
	filter: conditionSchema.optional(),
});

export type LookupOptionsSource = z.infer<typeof lookupOptionsSourceSchema>;

// Keep recursive Expression payloads behind one stable definition when this
// carrier appears in generated schemas. Register in place; `.meta()` would
// clone the shared node and duplicate recursive definitions.
z.globalRegistry.add(lookupOptionsSourceSchema, { id: "LookupOptionsSource" });
