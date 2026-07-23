import { z } from "zod";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "./lookupIds";
import { type Predicate, predicateSchema } from "./predicate/types";

/**
 * A select whose choices come from one Project lookup table.
 *
 * Stable table/column identities are persisted here; display names and wire
 * tags remain projections of the current lookup definition. Inline select
 * options stay on the field as the rolling-receiver fallback.
 */
export type LookupOptionsSource = {
	kind: "lookup-table";
	tableId: LookupTableId;
	valueColumnId: LookupColumnId;
	labelColumnId: LookupColumnId;
	filter?: Predicate;
};

export const lookupOptionsSourceSchema: z.ZodType<LookupOptionsSource> = z
	.object({
		kind: z.literal("lookup-table"),
		tableId: lookupTableIdSchema,
		valueColumnId: lookupColumnIdSchema,
		labelColumnId: lookupColumnIdSchema,
		filter: predicateSchema.optional(),
	})
	.strict();

// Keep recursive Predicate payloads behind one stable definition when this
// carrier appears in generated schemas. Register in place; `.meta()` would
// clone the shared node and duplicate recursive definitions.
z.globalRegistry.add(lookupOptionsSourceSchema, { id: "LookupOptionsSource" });
