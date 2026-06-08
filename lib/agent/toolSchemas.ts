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

/** Per-item shape inside `z.array(...)` for the `addFields` tool — a
 *  per-kind discriminated union (each arm carries only its kind's props).
 *  `addFields` is the sole field-add tool (one field = a length-1 array),
 *  so this item shape is the whole add surface. */
export const addFieldsItemSchema = generated.addFieldsItemSchema;

/** Patch shape for the `editField` tool (per-kind union; `kind` required as
 *  the discriminator). */
export const editFieldUpdatesSchema = generated.editFieldUpdatesSchema;

/**
 * Wide processing-type sources — NOT tool inputs. The per-kind union arms
 * above are structural subsets of these, so the add-path pipeline
 * (`FlatField`) and the edit patch mapper type against one wide shape
 * instead of a 19-way union.
 */
export const wideFlatItemSchema = generated.wideFlatItemSchema;
export const wideEditUpdatesSchema = generated.wideEditUpdatesSchema;
