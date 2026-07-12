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

/** Per-item shape inside `z.array(...)` for the `addFields` tool — one
 *  flat object whose kind policy gates which slots each kind may carry.
 *  `addFields` is the sole field-add tool (one field = a length-1 array),
 *  so this item shape is the whole add surface; its inferred type is the
 *  `FlatField` processing shape (`contentProcessing.ts`). */
export const addFieldsItemSchema = generated.addFieldsItemSchema;

/** Patch shape for the `editField` tool (same flat kind-gated form;
 *  `kind` required — the patch validates against that kind's slots). */
export const editFieldUpdatesSchema = generated.editFieldUpdatesSchema;
