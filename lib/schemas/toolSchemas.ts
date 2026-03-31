/**
 * SA tool input schemas — derived from the canonical question fields in blueprint.ts.
 *
 * Three question shapes for three tool contexts:
 * - addQuestionsQuestionSchema: batch generation (flat with parentId, sentinel fields)
 * - editQuestionUpdatesSchema: partial updates (all optional, some nullable for clearing)
 * - addQuestionQuestionSchema: single insertion (all optional except id/type)
 *
 * The Anthropic schema compiler times out with >8 .optional() fields per
 * array item. addQuestions works around this by making label, required, and
 * case_property_on required (sentinel: empty string = not set). Post-processing
 * via stripEmpty() converts sentinels back. See contentProcessing.ts.
 */
import { z } from 'zod'
import { questionFields, selectOptionSchema, QUESTION_DOCS } from './blueprint'

// ── addQuestions: batch generation (flat with parentId, 3 sentinels) ──

/**
 * Flat question schema for batch generation. Adds parentId for tree building,
 * and makes 3 fields required sentinels to stay under the 8-optional limit.
 */
export const addQuestionsQuestionSchema = z.object({
  id: questionFields.id,
  type: questionFields.type,
  parentId: z.string().describe('Parent group/repeat ID. Empty string for top-level.'),
  // Required sentinels (3) — use empty string when not applicable.
  // Keeps optional count at 8 (Anthropic compiler limit).
  label: z.string().describe(QUESTION_DOCS.label),
  required: z.string().describe(QUESTION_DOCS.required),
  case_property_on: z.string().describe(QUESTION_DOCS.case_property_on),
  // Optionals (8)
  hint: questionFields.hint,
  help: questionFields.help,
  validation: questionFields.validation,
  validation_msg: questionFields.validation_msg,
  relevant: questionFields.relevant,
  calculate: questionFields.calculate,
  default_value: questionFields.default_value,
  options: questionFields.options,
})

/** Full addQuestions input schema (wraps question array with module/form indices). */
export const addQuestionsSchema = {
  schema: z.object({
    moduleIndex: z.number().describe('0-based module index'),
    formIndex: z.number().describe('0-based form index'),
    questions: z.array(addQuestionsQuestionSchema),
  }),
  /** Pre-computed JSON schema for test-schema.ts size checks. */
  get jsonSchema() { return z.toJSONSchema(this.schema) },
}

// ── editQuestion: partial updates (all optional, some nullable) ──────

/**
 * Update schema for editQuestion. All fields optional (only include what changed).
 * XPath fields that can be cleared accept null.
 */
export const editQuestionUpdatesSchema = z.object({
  id: questionFields.id.optional(),
  label: questionFields.label,
  type: questionFields.type.optional(),
  hint: questionFields.hint,
  required: questionFields.required,
  validation: questionFields.validation,
  validation_msg: questionFields.validation_msg,
  // Nullable fields — accept null to clear the value
  relevant: z.string().nullable().optional().describe(QUESTION_DOCS.relevant),
  calculate: z.string().nullable().optional().describe(QUESTION_DOCS.calculate),
  default_value: z.string().nullable().optional().describe(QUESTION_DOCS.default_value),
  options: z.array(selectOptionSchema).nullable().optional().describe(QUESTION_DOCS.options),
  case_property_on: z.string().nullable().optional().describe(QUESTION_DOCS.case_property_on),
}).describe('Fields to update. Only include fields you want to change.')

// ── addQuestion: single insertion (all optional except id/type) ──────

/** Question schema for single insertion. Same shape as blueprint questionFields (no children). */
export const addQuestionQuestionSchema = z.object({
  id: questionFields.id,
  type: questionFields.type,
  label: questionFields.label,
  hint: questionFields.hint,
  required: questionFields.required,
  validation: questionFields.validation,
  validation_msg: questionFields.validation_msg,
  relevant: questionFields.relevant,
  calculate: questionFields.calculate,
  default_value: questionFields.default_value,
  options: questionFields.options,
  case_property_on: questionFields.case_property_on,
})
