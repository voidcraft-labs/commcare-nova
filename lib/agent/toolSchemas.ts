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

import { generateToolSchemas } from "./toolSchemaGenerator";

const generated = generateToolSchemas();

/** Per-item shape inside `z.array(...)` for the `addFields` batch tool. */
export const addFieldsItemSchema = generated.addFieldsItemSchema;

/** Whole-input shape for the single-insert `addField` tool. */
export const addFieldSchema = generated.addFieldSchema;

/** Patch shape for the `editField` tool. */
export const editFieldUpdatesSchema = generated.editFieldUpdatesSchema;
