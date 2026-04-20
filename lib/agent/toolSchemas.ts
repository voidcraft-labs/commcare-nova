/**
 * Materialized SA tool input schemas.
 *
 * This file is the single point where the generator runs — downstream
 * consumers (solutionsArchitect.ts, test-schema.ts) import stable
 * named values from here rather than re-running the generator. Running
 * it once keeps Zod's internal cache attached to these specific Zod
 * nodes (important for `z.toJSONSchema` behavior) and avoids
 * accidentally producing two non-referentially-equal schemas for the
 * same tool.
 */

import { z } from "zod";
import { generateToolSchemas } from "./toolSchemaGenerator";

const generated = generateToolSchemas();

/** Per-item shape inside `z.array(...)` for the `addFields` batch tool. */
export const addFieldsItemSchema = generated.addFieldsItemSchema;

/** Whole-input shape for the single-insert `addField` tool. */
export const addFieldSchema = generated.addFieldSchema;

/** Patch shape for the `editField` tool. */
export const editFieldUpdatesSchema = generated.editFieldUpdatesSchema;

/**
 * Full `addFields` input — wraps the per-item schema in an array and
 * carries the module/form anchor. Exposed as an object with both the
 * Zod schema and a cached JSON Schema so `scripts/test-schema.ts` can
 * verify the structured-output compile size without re-running the
 * toJSONSchema conversion on every check.
 */
export const addFieldsSchema = {
	schema: z.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fields: z.array(addFieldsItemSchema),
	}),
	get jsonSchema() {
		return z.toJSONSchema(this.schema);
	},
};
