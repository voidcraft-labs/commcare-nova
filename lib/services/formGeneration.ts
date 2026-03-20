/**
 * Single-form content generation via structured output.
 *
 * Used by the SA's `addForm` and `regenerateForm` tools, and by the validation
 * loop when regenerating empty forms. Generates questions for one form at a time
 * using Anthropic structured output with the singleFormSchema.
 */
import { z } from 'zod'
import {
  type AppBlueprint, type BlueprintForm,
  QUESTION_TYPES,
} from '../schemas/blueprint'
import {
  processSingleFormOutput,
  type FlatQuestion,
} from '../schemas/contentProcessing'
import { GenerationContext } from './generationContext'

// Re-export QUESTION_TYPES so consumers can import from this module
export { QUESTION_TYPES } from '../schemas/blueprint'

// ── Single-form generation ───────────────────────────────────────────

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

/**
 * Schema for single-form structured output generation.
 *
 * The Anthropic schema compiler times out with >8 optional fields per array item.
 * Fields that are almost always present use required + empty sentinels instead.
 * Post-processing (stripEmpty + applyDefaults) converts sentinels back to undefined.
 */
export const singleFormSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    type: z.enum(QUESTION_TYPES),
    parentId: z.string().describe('Parent group/repeat ID. Empty string for top-level.'),
    // Required sentinels (4) — almost always present, low cost as empty values
    label: z.string().describe('Question label. Empty string to use case property default or for hidden questions.'),
    required: z.string().describe('"true()" if always required, XPath for conditional. Empty string if not required.'),
    case_property: z.string().describe('Case property name. Empty string if not mapped.'),
    is_case_name: z.boolean().describe('True if this is the case name field. False if not.'),
    // Optionals (8) — sparse, saves tokens when absent
    hint: z.string().optional(),
    help: z.string().optional(),
    validation: z.string().optional(),
    validation_msg: z.string().optional(),
    relevant: z.string().optional(),
    calculate: z.string().optional(),
    default_value: z.string().optional().describe("XPath for initial value on form load. String values must be quoted: `'text'`, not `text`."),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  })),
  close_case: z.object({
    question: z.string().describe('Question ID for conditional close. Empty string if no close.'),
    answer: z.string().describe('Value that triggers closure. Empty string if no close.'),
  }),
  child_cases: z.array(z.object({
    case_type: z.string(),
    case_name_field: z.string(),
    case_properties: z.array(z.object({ case_property: z.string(), question_id: z.string() })),
    relationship: z.enum(['child', 'extension']),
    repeat_context: z.string().describe('Repeat group question ID. Empty string if not in repeat.'),
  })).describe('Empty array if no child cases.'),
})

const FORM_GENERATION_SYSTEM = `You are a senior CommCare form builder. Build the questions for a single form.

Questions use a flat structure: parentId (empty string for top-level, group id for nested). Array order determines display order.

For case wiring: registration forms save to case properties, followup forms preload from case using default_value with #case/property_name.
For display-only context in followups, use label questions with <output value="#case/property_name"/> labels (labels support markdown formatting). Use groups for visual sections. Calculate don't ask for derived values.
Use raw XPath operators (>, <), never HTML-escaped. Reference questions by /data/question_id.
All XPath field values are expressions — string literals must be quoted: \`'pending'\`, not \`pending\`.

### Design Principles
- Use groups to create visual sections that help the worker understand the form's structure
- Calculate, don't ask: if a value can be derived (age from DOB, BMI from height+weight), use a hidden calculated field
- Coordinate sibling forms: Registration and followup forms for the same case type should use the same question IDs and group structure for shared fields
- Confirm context in followups: start with label questions showing key case details using <output value="#case/property_name"/>
- Use relevant for conditional visibility. Use validation with validation_msg for input validation rules
- Default the common case: Use default_value (e.g. today()) when 90%+ of submissions will use the same value
- hidden questions MUST have either calculate or default_value — a hidden question with neither saves blank data`

/**
 * Generate content for a single form using structured output.
 * Returns a BlueprintForm with nested questions.
 */
export async function generateSingleFormContent(
  ctx: GenerationContext,
  blueprint: AppBlueprint,
  moduleIndex: number,
  formIndex: number,
  instructions: string,
): Promise<BlueprintForm> {
  const mod = blueprint.modules[moduleIndex]
  const form = mod.forms[formIndex]
  const caseTypes = blueprint.case_types ?? []
  const ct = caseTypes.find(c => c.name === mod.case_type) ?? null

  const dataModel = ct
    ? `Case type: ${ct.name} (case_name_property: ${ct.case_name_property})\nProperties:\n${ct.properties.map(p => {
        const parts = [p.name]
        if (p.data_type) parts.push(`(${p.data_type})`)
        if (p.label) parts.push(`— ${p.label}`)
        return `  - ${parts.join(' ')}`
      }).join('\n')}`
    : 'No case type (survey)'

  const siblingForms = mod.forms.map(f => `"${f.name}" (${f.type})`).join(', ')

  const formGenCfg = ctx.pipelineConfig.formGeneration
  const result = await ctx.generate(singleFormSchema, {
    model: formGenCfg.model,
    reasoning: ctx.reasoningForStage('formGeneration'),
    system: FORM_GENERATION_SYSTEM,
    prompt: `App: "${blueprint.app_name}"
Module: "${mod.name}"
Form: "${form.name}" (${form.type})
Sibling forms: ${siblingForms}
${dataModel}

## Instructions
${instructions}

Build the complete questions for this form.`,
    label: `Generate form "${form.name}"`,
    maxOutputTokens: formGenCfg.maxOutputTokens || undefined,
  })

  if (!result) {
    return { name: form.name, type: form.type, questions: [] }
  }

  return processSingleFormOutput(
    { formIndex, questions: result.questions as FlatQuestion[], close_case: result.close_case, child_cases: result.child_cases },
    form.name,
    form.type,
    ct,
  )
}

// ── Module column prompt builder ─────────────────────────────────────

export function buildColumnPrompt(blueprint: AppBlueprint, moduleIndex: number, instructions: string): string {
  const mod = blueprint.modules[moduleIndex]
  const caseTypes = blueprint.case_types ?? []
  const ct = caseTypes.find(c => c.name === mod.case_type)

  const dataModel = ct
    ? `Case type: ${ct.name}\nProperties: ${ct.properties.map(p => p.name).join(', ')}`
    : 'Survey-only module (no case type)'

  return `App: "${blueprint.app_name}"
Module: "${mod.name}"
${dataModel}

## Instructions
${instructions}

Design the case list columns and case detail columns for this module.
- Choose columns that help the user quickly identify and differentiate records
- Include case_name as the first column unless there is a reason not to
- 3-5 columns is typical
- Column headers should be short and scannable
- For case_detail_columns, include more fields than the list. Use null to auto-mirror.
- Survey-only modules should have null for both.`
}
