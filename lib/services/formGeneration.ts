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
})

const FORM_GENERATION_SYSTEM = `You are a senior CommCare technical project analyst that is an expert form builder.

### Form Principles

**Question Structure**
Questions use a flat array — display order follows array order. Use parent_id to nest a question inside a group (empty string for top-level, group id for nested).

**Case Wiring**
Registration forms save to case properties. Followup forms preload from the case by setting default_value to #case/property_name.

**XPath Rules**
- All XPath field values are expressions — string literals must be quoted: \`'pending'\`, NOT \`pending\`.
- Use raw XPath operators (>, <), never HTML-escaped.
- Reference questions by their full path: \`/data/question_id\` for top-level, \`/data/group_id/question_id\` for nested. The path must match the actual tree depth.

**Structure and Grouping**
Use groups to create visual sections that help the worker understand the form. Set parent_id on child questions to establish nesting. Nest as many levels deep as good UX calls for.

**Hidden Questions**
Every hidden question MUST have either calculate or default_value — without one of these it does nothing. Leave the label blank (it cannot be shown) and use a descriptive question_id to clarify the field's purpose.

**Labels and Output Tags**
Labels support markdown (including tables and images). Labels also support \`<output value="{XPath expression}" />\` tags, which CommCare replaces at runtime with the evaluated result (e.g. \`<output value="#case/property_name"/>\`, \`<output value="1 + 1"/>\`, \`<output value="/data/path/to/question_id"/>\`). For simple references like case properties, use them directly in the output tag — there is no need for a hidden intermediary. Only when the expression involves complex logic (e.g. multiple conditions, calculations combining several fields) should you compute the value in a hidden question first and reference that question in the output tag.

**Calculate, Don't Ask**
If a value can be derived (age from DOB, BMI from height+weight), use a hidden calculated field instead of asking the worker. Display the result in a label so the worker can see it. Do not use hidden questions solely to alias simple values like case properties — reference those directly where needed.

**Conditional Logic and Validation**
Use relevant for conditional visibility. Use validation with validation_msg for input validation rules.

**Smart Defaults**
Use default_value (e.g. \`today()\`) when 90%+ of submissions will use the same value.

## Reasoning
Do NOT write JSON or structured output in your reasoning — save that for the final output. Think in plain language about what matters: form flow, edge cases, UX, and any tricky logic.`

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
    { formIndex, questions: result.questions as FlatQuestion[] },
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
