/**
 * Shared schemas for the App Blueprint format.
 *
 * Three tiers of schemas for generation:
 * - scaffoldSchema: App structure + data model (Tier 1)
 * - moduleContentSchema: Case list design (Tier 2)
 * - formContentSchema: Questions + case config (Tier 3)
 *
 * Plus the assembled format:
 * - appBlueprintSchema: Full recursive blueprint for validation/expansion/MCP
 *
 * TypeScript types are derived via z.infer.
 */
import { z } from 'zod'

// ── Question types ──────────────────────────────────────────────────────

const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'long', 'trigger', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat'
] as const

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)')
})

// ── Tier 1: Scaffold Schema ────────────────────────────────────────────

export const scaffoldSchema = z.object({
  app_name: z.string().describe('Name of the CommCare application'),
  description: z.string().describe('Brief description of the app purpose and target users'),
  case_types: z.array(z.object({
    name: z.string().describe('Case type name in snake_case (e.g., "patient", "household")'),
    properties: z.array(z.object({
      name: z.string().describe('Property name in snake_case (e.g., "age", "gender"). Must NOT be a reserved word.'),
      label: z.string().describe('Human-readable label (e.g., "Patient Age", "Gender")'),
    })).describe('Case properties to track. Forms will create questions to capture these.'),
  })).nullable().describe('Case types and their properties. null if all modules are survey-only.'),
  modules: z.array(z.object({
    name: z.string().describe('Display name for the module/menu'),
    case_type: z.string().nullable().describe('References a case_type name above. null for survey-only modules.'),
    purpose: z.string().describe("Brief description of this module's role in the app"),
    forms: z.array(z.object({
      name: z.string().describe('Display name for the form'),
      type: z.enum(['registration', 'followup', 'survey']).describe('Form type'),
      purpose: z.string().describe('Brief description of what this form collects and why'),
    })),
  })),
})

// ── Tier 2: Module Content Schema ──────────────────────────────────────

export const moduleContentSchema = z.object({
  case_list_columns: z.array(z.object({
    field: z.string().describe('Case property name to display'),
    header: z.string().describe('Column header text'),
  })).nullable().describe('Columns for the case list. null for survey-only modules.'),
})

// ── Tier 3: Form Content Schema ────────────────────────────────────────

const flatQuestionSchema = z.object({
  id: z.string().describe(
    'Unique identifier within the form. Use snake_case starting with a letter (e.g. "patient_name", "visit_date").'
  ),
  type: z.enum(QUESTION_TYPES).describe(
    'Question type. Use the most specific type: "phone" for phone numbers, "date" for dates, "int" for counts, "decimal" for measurements, "select1" for single-choice, "select" for multi-choice, "hidden" with "calculate" for computed values, "group"/"repeat" for nested questions.'
  ),
  label: z.string().describe(
    'Human-readable question text. Write clear, natural labels like "Patient Name", "Date of Birth".'
  ),
  parent_id: z.string().nullable().describe(
    'ID of the parent group/repeat question this belongs to, or null for top-level questions. Groups/repeats must be listed BEFORE their children.'
  ),
  hint: z.string().nullable().describe('Help text shown below the question'),
  required: z.boolean().nullable().describe('True if the question must be answered'),
  readonly: z.boolean().nullable().describe('True if visible but not editable (use for display-only preloaded values)'),
  constraint: z.string().nullable().describe('XPath constraint expression, e.g. ". > 0 and . < 150"'),
  constraint_msg: z.string().nullable().describe('Error message when constraint fails'),
  relevant: z.string().nullable().describe('XPath expression — question only shows when true, e.g. "/data/age > 18"'),
  calculate: z.string().nullable().describe('XPath expression for auto-computed value (use with type "hidden")'),
  options: z.array(selectOptionSchema).nullable().describe(
    'Required for select1/select questions. At least 2 options.'
  ),
})

const formChildCaseSchema = z.object({
  case_type: z.string().describe(
    'The child case type in snake_case (e.g. "referral", "pregnancy"). Only letters, digits, underscores, hyphens.'
  ),
  case_name_field: z.string().describe(
    'Question id whose value becomes the child case name'
  ),
  case_properties: z.record(z.string(), z.string()).nullable().describe(
    'Map of child case property name -> question id. Do NOT use reserved property names as keys.'
  ),
  relationship: z.enum(['child', 'extension']).nullable().describe(
    '"child" (default) or "extension". Use "extension" when the child should prevent the parent from being closed.'
  ),
  repeat_context: z.string().nullable().describe(
    'Question id of a repeat group — creates one child case per repeat entry'
  ),
})

export const formContentSchema = z.object({
  case_name_field: z.string().nullable().describe(
    'Registration forms only: question id whose value becomes the case name. Required for registration forms.'
  ),
  case_properties: z.record(z.string(), z.string()).nullable().describe(
    'Map of case property name -> question id. These question values get saved to the case. Do NOT include case_name_field here. NEVER use reserved property names as keys.'
  ),
  case_preload: z.record(z.string(), z.string()).nullable().describe(
    'Followup forms only: map of question id -> case property name. Pre-fills form questions with existing case data.'
  ),
  close_case: z.object({
    question: z.string().nullable().describe('Question id to check for conditional close. null for unconditional close.'),
    answer: z.string().nullable().describe('Value that triggers case closure. null for unconditional close.'),
  }).nullable().describe(
    'Followup forms only. null if form should not close the case. {} or {question: null, answer: null} = always close. {question, answer} = conditional close.'
  ),
  child_cases: z.array(formChildCaseSchema).nullable().describe(
    'Create child/sub-cases linked to the current case. Valid on both registration and followup forms.'
  ),
  questions: z.array(flatQuestionSchema).describe(
    'Flat array of questions in the form. Use parent_id to place questions inside groups/repeats. Every form must have at least one question.'
  ),
})

// ── Assembled Blueprint Schema (for validation/expansion/MCP) ──────────

/**
 * Recursive question schema — the "assembled" format with nested children.
 */
const blueprintQuestionSchema = z.object({
  id: z.string().describe(
    'Unique identifier within the form. Use snake_case starting with a letter (e.g. "patient_name", "visit_date").'
  ),
  type: z.enum(QUESTION_TYPES).describe(
    'Question type. Use the most specific type: "phone" for phone numbers (not "text"), "date" for dates, "int" for counts, "decimal" for measurements, "select1" for single-choice, "select" for multi-choice, "hidden" with "calculate" for computed values, "group"/"repeat" for nested questions.'
  ),
  label: z.string().describe(
    'Human-readable question text. Write clear, natural labels like "Patient Name", "Date of Birth". Never put technical notes in labels.'
  ),
  hint: z.string().optional().describe('Help text shown below the question'),
  required: z.boolean().optional().describe('True if the question must be answered'),
  readonly: z.boolean().optional().describe('True if visible but not editable (use for display-only preloaded values)'),
  constraint: z.string().optional().describe('XPath constraint expression, e.g. ". > 0 and . < 150"'),
  constraint_msg: z.string().optional().describe('Error message when constraint fails'),
  relevant: z.string().optional().describe('XPath expression — question only shows when true, e.g. "/data/age > 18"'),
  calculate: z.string().optional().describe('XPath expression for auto-computed value (use with type "hidden")'),
  options: z.array(selectOptionSchema).optional().describe(
    'Required for select1/select questions. At least 2 options.'
  ),
  get children() {
    return z.array(blueprintQuestionSchema).optional().describe(
      'Nested questions for group/repeat types'
    )
  },
})

const blueprintChildCaseSchema = z.object({
  case_type: z.string().describe(
    'The child case type in snake_case (e.g. "referral", "pregnancy", "household_member"). Only letters, digits, underscores, hyphens.'
  ),
  case_name_field: z.string().describe(
    'Question id whose value becomes the child case name'
  ),
  case_properties: z.record(z.string(), z.string()).optional().describe(
    'Map of child case property name -> question id. Do NOT use reserved property names as keys.'
  ),
  relationship: z.enum(['child', 'extension']).optional().describe(
    '"child" (default) or "extension". Use "extension" when the child should prevent the parent from being closed.'
  ),
  repeat_context: z.string().optional().describe(
    'Question id of a repeat group — creates one child case per repeat entry'
  ),
}).describe('Creates a child/sub-case linked to the parent case')

const blueprintFormSchema = z.object({
  name: z.string().describe('Display name for the form'),
  type: z.enum(['registration', 'followup', 'survey']).describe(
    '"registration" creates a new case (MUST have case_name_field). "followup" updates an existing case (should have case_preload). "survey" has no case management.'
  ),
  case_name_field: z.string().optional().describe(
    'Registration forms only: question id whose value becomes the case name. Required for registration forms.'
  ),
  case_properties: z.record(z.string(), z.string()).optional().describe(
    'Map of case property name -> question id. These question values get saved to the case. Do NOT include case_name_field here. NEVER use reserved property names (case_id, case_name, case_type, status, name, date, type, etc.) as keys. NEVER map media questions (image, audio, video, signature) to case properties.'
  ),
  case_preload: z.record(z.string(), z.string()).optional().describe(
    'Followup forms only: map of question id -> case property name. Pre-fills form questions with existing case data. To load case name use "case_name" as the value. If user should edit and save back, include same field in BOTH case_preload AND case_properties.'
  ),
  close_case: z.object({
    question: z.string().optional().describe('Question id to check for conditional close'),
    answer: z.string().optional().describe('Value that triggers case closure'),
  }).optional().describe(
    'Followup forms only. Present = close the case. Empty {} = always close. {question, answer} = close only when that answer is selected. Omit entirely if form should not close the case.'
  ),
  child_cases: z.array(blueprintChildCaseSchema).optional().describe(
    'Create child/sub-cases linked to the current case. Valid on both registration and followup forms.'
  ),
  questions: z.array(blueprintQuestionSchema).describe(
    'Array of questions in the form. Every form must have at least one question.'
  ),
}).describe('A form within a module')

const caseListColumnSchema = z.object({
  field: z.string().describe('Case property name'),
  header: z.string().describe('Column header display text')
})

const blueprintModuleSchema = z.object({
  name: z.string().describe('Display name for the module/menu'),
  case_type: z.string().optional().describe(
    'Required if any form is "registration" or "followup". Use short snake_case (e.g. "patient", "household_visit"). Only letters, digits, underscores, hyphens.'
  ),
  forms: z.array(blueprintFormSchema).describe('Array of forms in this module'),
  case_list_columns: z.array(caseListColumnSchema).optional().describe(
    'Columns shown in the case list. Each has "field" (case property) and "header" (display text). Do NOT include "name" — it is shown automatically. Do NOT use reserved property names.'
  ),
}).describe('A module (menu) in the app')

/** Top-level schema for a complete CommCare app in blueprint format. */
export const appBlueprintSchema = z.object({
  app_name: z.string().describe('Name of the CommCare application'),
  modules: z.array(blueprintModuleSchema).describe(
    'Array of modules. Each module is a menu containing forms.'
  ),
}).describe('A CommCare application definition in blueprint format')

// ── Types ──────────────────────────────────────────────────────────────

export type AppBlueprint = z.infer<typeof appBlueprintSchema>
export type BlueprintModule = z.infer<typeof blueprintModuleSchema>
export type BlueprintForm = z.infer<typeof blueprintFormSchema>
export type BlueprintQuestion = z.infer<typeof blueprintQuestionSchema>
export type BlueprintChildCase = z.infer<typeof blueprintChildCaseSchema>

export type Scaffold = z.infer<typeof scaffoldSchema>
export type ModuleContent = z.infer<typeof moduleContentSchema>
export type FormContent = z.infer<typeof formContentSchema>
export type FlatQuestion = z.infer<typeof flatQuestionSchema>

// ── JSON Schema export ─────────────────────────────────────────────────

export function getAppBlueprintJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(appBlueprintSchema)
}

// ── Assembly utilities ─────────────────────────────────────────────────

/**
 * Convert flat questions (with parent_id) to nested questions (with children).
 * Groups/repeats must appear before their children in the flat array.
 */
export function unflattenQuestions(flat: FlatQuestion[]): BlueprintQuestion[] {
  const result: BlueprintQuestion[] = []
  const byId = new Map<string, BlueprintQuestion>()

  for (const fq of flat) {
    const q: BlueprintQuestion = {
      id: fq.id,
      type: fq.type,
      label: fq.label,
      ...(fq.hint != null && { hint: fq.hint }),
      ...(fq.required != null && { required: fq.required }),
      ...(fq.readonly != null && { readonly: fq.readonly }),
      ...(fq.constraint != null && { constraint: fq.constraint }),
      ...(fq.constraint_msg != null && { constraint_msg: fq.constraint_msg }),
      ...(fq.relevant != null && { relevant: fq.relevant }),
      ...(fq.calculate != null && { calculate: fq.calculate }),
      ...(fq.options != null && { options: fq.options }),
    }

    byId.set(fq.id, q)

    if (fq.parent_id == null) {
      result.push(q)
    } else {
      const parent = byId.get(fq.parent_id)
      if (parent) {
        if (!parent.children) parent.children = []
        parent.children.push(q)
      } else {
        // Parent not found — fall back to top level
        result.push(q)
      }
    }
  }

  return result
}

/**
 * Convert nested questions (with children) to flat array (with parent_id).
 * Inverse of unflattenQuestions.
 */
export function flattenQuestions(questions: BlueprintQuestion[], parentId: string | null = null): FlatQuestion[] {
  const result: FlatQuestion[] = []
  for (const q of questions) {
    result.push({
      id: q.id,
      type: q.type,
      label: q.label,
      parent_id: parentId,
      hint: q.hint ?? null,
      required: q.required ?? null,
      readonly: q.readonly ?? null,
      constraint: q.constraint ?? null,
      constraint_msg: q.constraint_msg ?? null,
      relevant: q.relevant ?? null,
      calculate: q.calculate ?? null,
      options: q.options ?? null,
    })
    if (q.children) {
      result.push(...flattenQuestions(q.children, q.id))
    }
  }
  return result
}

/** Convert blueprint close_case (optional) to flat form-content format (nullable) */
export function closeCaseToFlat(closeCase: BlueprintForm['close_case']): FormContent['close_case'] {
  if (closeCase == null) return null
  return { question: closeCase.question ?? null, answer: closeCase.answer ?? null }
}

/** Convert flat form-content close_case (nullable) to blueprint format (optional) */
function assembleCloseCase(cc: FormContent['close_case']): BlueprintForm['close_case'] {
  if (cc == null) return undefined
  return {
    ...(cc.question != null && { question: cc.question }),
    ...(cc.answer != null && { answer: cc.answer }),
  }
}

/** Convert flat form-content child_cases to blueprint format */
function assembleChildCases(cases: FormContent['child_cases']): BlueprintForm['child_cases'] {
  if (cases == null) return undefined
  return cases.map(c => ({
    case_type: c.case_type,
    case_name_field: c.case_name_field,
    ...(c.case_properties != null && { case_properties: c.case_properties }),
    ...(c.relationship != null && { relationship: c.relationship }),
    ...(c.repeat_context != null && { repeat_context: c.repeat_context }),
  }))
}

/**
 * Assemble a full AppBlueprint from scaffold + module contents + form contents.
 *
 * @param scaffold - Tier 1 output
 * @param moduleContents - Array of Tier 2 outputs, one per module (same order as scaffold.modules)
 * @param formContents - 2D array of Tier 3 outputs, formContents[moduleIdx][formIdx]
 */
export function assembleBlueprint(
  scaffold: Scaffold,
  moduleContents: ModuleContent[],
  formContents: FormContent[][],
): AppBlueprint {
  return {
    app_name: scaffold.app_name,
    modules: scaffold.modules.map((sm, mIdx) => {
      const mc = moduleContents[mIdx]
      const forms: BlueprintForm[] = sm.forms.map((sf, fIdx) => {
        const fc = formContents[mIdx][fIdx]
        const closeCase = assembleCloseCase(fc.close_case)
        const childCases = assembleChildCases(fc.child_cases)

        return {
          name: sf.name,
          type: sf.type,
          ...(fc.case_name_field != null && { case_name_field: fc.case_name_field }),
          ...(fc.case_properties != null && { case_properties: fc.case_properties }),
          ...(fc.case_preload != null && { case_preload: fc.case_preload }),
          ...(closeCase !== undefined && { close_case: closeCase }),
          ...(childCases !== undefined && { child_cases: childCases }),
          questions: unflattenQuestions(fc.questions),
        }
      })

      return {
        name: sm.name,
        ...(sm.case_type != null && { case_type: sm.case_type }),
        forms,
        ...(mc.case_list_columns != null && { case_list_columns: mc.case_list_columns }),
      }
    }),
  }
}
