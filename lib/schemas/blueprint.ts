/**
 * Shared schemas for the App Blueprint format.
 *
 * Generation schemas used by SA tools:
 * - caseTypesOutputSchema: Data model (generateSchema tool)
 * - scaffoldModulesSchema: Module/form structure (generateScaffold tool)
 * - moduleContentSchema: Case list columns (addModule tool)
 *
 * TypeScript types are derived via z.infer.
 */
import { z } from 'zod'

// ── Question types ──────────────────────────────────────────────────────

export const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'label', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat'
] as const

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

/** Typed pair for case property ↔ question mappings (replaces Record<string, string>). */
const casePropertyMappingSchema = z.object({
  case_property: z.string().describe('Case property name'),
  question_id: z.string().describe('Question id in the form'),
})

const RESERVED_CASE_PROPERTIES = 'case_id, case_type, closed, closed_by, closed_on, date, date_modified, date_opened, doc_type, domain, external_id, index, indices, modified_on, name, opened_by, opened_on, owner_id, server_modified_on, status, type, user_id, xform_id'

// ── Case property data types (excludes media, structural, hidden/secret) ──

const CASE_PROPERTY_DATA_TYPES = [
  'text', 'int', 'decimal', 'date', 'time', 'datetime',
  'select1', 'select', 'phone', 'geopoint',
] as const

// ── Case property + case type schemas ────────────────────────────────

const casePropertySchema = z.object({
  name: z.string().describe(
    'Property name in snake_case. ' +
    `Must NOT be a reserved word: ${RESERVED_CASE_PROPERTIES}. ` +
    'Must NOT be media/binary (photos, audio, video, signatures). ' +
    'Use descriptive alternatives (e.g. "visit_date" not "date", "full_name" not "name").'
  ),
  label: z.string().describe('Human-readable label for this property. Used as the default question label in all forms.'),
  data_type: z.enum(CASE_PROPERTY_DATA_TYPES).optional().describe(
    'Data type. Determines the default question type. Omit for "text".'
  ),
  hint: z.string().optional().describe('Hint text shown below questions collecting this property.'),
  help: z.string().optional().describe('Extended help text accessible via help icon.'),
  required: z.string().optional().describe('"true()" if always required. Omit if optional.'),
  constraint: z.string().optional().describe('XPath constraint, e.g. ". > 0 and . < 150"'),
  constraint_msg: z.string().optional().describe('Error message when constraint fails.'),
  options: z.array(selectOptionSchema).optional().describe('Options for select1/select properties.'),
})

const caseTypeSchema = z.object({
  name: z.string().describe('Case type name in snake_case (e.g., "patient", "household")'),
  case_name_property: z.string().describe(
    'Which property identifies this case (used as the case name). Must match one of the property names below.'
  ),
  properties: z.array(casePropertySchema).describe('Case properties to track. Forms will create questions to capture these.'),
})

// ── Case Types Output Schema (for generateSchema tool) ─────────────────

export const caseTypesOutputSchema = z.object({
  case_types: z.array(caseTypeSchema).describe('Case types and their properties'),
})

// ── Scaffold Modules Schema (for generateScaffold tool, minus case_types) ──

export const scaffoldModulesSchema = z.object({
  app_name: z.string().describe('Name of the CommCare application'),
  description: z.string().describe('Brief description of the app purpose and target users'),
  modules: z.array(z.object({
    name: z.string().describe('Display name for the module/menu'),
    case_type: z.string().nullable().describe(
      'References a case_type name from the data model. Required if any form is "registration" or "followup". null for survey-only modules.'
    ),
    purpose: z.string().describe("Brief description of this module's role in the app"),
    forms: z.array(z.object({
      name: z.string().describe('Display name for the form'),
      type: z.enum(['registration', 'followup', 'survey']).describe(
        '"registration" creates a new case. "followup" updates an existing case. "survey" is standalone.'
      ),
      purpose: z.string().describe('Brief description of what this form collects and why'),
      formDesign: z.string().describe(
        'Free-text UX design spec for this form. Describe the intended question flow, ' +
        'grouping, skip logic patterns, calculated fields, and how this form relates to ' +
        'sibling forms.'
      ),
    })),
  })),
})

// ── Module Content Schema (case list columns) ─────────────────────────

export const moduleContentSchema = z.object({
  case_list_columns: z.array(z.object({
    field: z.string().describe('Case property name to display'),
    header: z.string().describe('Column header text'),
  })).nullable().describe('Columns for the case list. null for survey-only modules.'),
  case_detail_columns: z.array(z.object({
    field: z.string().describe('Case property name'),
    header: z.string().describe('Display label for this detail field'),
  })).nullable().describe(
    'Columns shown in the case detail view (when a user taps on a case). null to auto-mirror case_list_columns.'
  ),
})

// ── Question Schema ───────────────────────────────────────────────────

const questionFields = {
  id: z.string().describe(
    'Unique identifier within the form. Use snake_case starting with a letter (e.g. "patient_name", "visit_date").'
  ),
  type: z.enum(QUESTION_TYPES).describe(
    'Question type. Always pick the most specific type available: ' +
    '"phone" for phone numbers (not "text"), ' +
    '"date"/"time"/"datetime" for temporal values, ' +
    '"int" for whole numbers (age, count, quantity), ' +
    '"decimal" for measurements (weight, height, price), ' +
    '"select1" for any fixed single-choice (yes/no, gender, status), ' +
    '"select" for multi-choice (symptoms, services), ' +
    '"geopoint" for GPS, "image"/"audio"/"video"/"signature"/"barcode" for media capture, ' +
    '"hidden" with "calculate" for computed values (BMI, risk score, age from DOB), ' +
    '"secret" for passwords/PINs, ' +
    '"group"/"repeat" for nesting. ' +
    'Only use "text" for genuinely free-text fields: names, addresses, notes.'
  ),
  label: z.string().optional().describe(
    'Human-readable question text. Write clear, professional labels like "Patient Name", "Date of Birth". ' +
    'Omit for hidden questions — they have no visible label.'
  ),
  hint: z.string().optional().describe('Help text shown below the question.'),
  help: z.string().optional().describe('Extended help text accessible via help icon.'),
  required: z.string().optional().describe(
    '"true()" if always required. An XPath expression for conditional requirement (e.g. "/data/age >= 18").'
  ),
  constraint: z.string().optional().describe('XPath constraint expression, e.g. ". > 0 and . < 150"'),
  constraint_msg: z.string().optional().describe('Error message when constraint fails.'),
  relevant: z.string().optional().describe(
    'XPath expression — question only shows when true. ' +
    'Use the full path: /data/question_id for top-level, /data/group_id/question_id for nested. ' +
    'Use #case/property_name to reference existing case data. ' +
    'e.g. "/data/age > 18", "#case/risk_level = \'high\'"'
  ),
  calculate: z.string().optional().describe(
    'XPath expression for auto-computed value (use with type "hidden"). ' +
    'Use the full path: /data/question_id for top-level, /data/group_id/question_id for nested. ' +
    'Use #case/property_name to reference existing case data. ' +
    'Never reference the question\'s own node — use #case/ to read the current case value instead.'
  ),
  default_value: z.string().optional().describe(
    'XPath expression for the initial value set when the form opens (one-time, not recalculated). ' +
    'Use #case/property_name to reference case data. Use string literals wrapped in quotes, e.g. "\'pending\'". ' +
    'Different from calculate: default_value sets once on load, calculate updates continuously.'
  ),
  options: z.array(selectOptionSchema).optional().describe(
    'Options for select1/select questions — at least 2 options. Omit for all other question types.'
  ),
  case_property: z.string().optional().describe(
    'Case property name this question maps to. On registration forms, the answer is saved to this property. ' +
    'On followup forms, the property value is preloaded into the question AND saved back. ' +
    'Omit if this question does not map to a case property. ' +
    `Must NOT be a reserved name: ${RESERVED_CASE_PROPERTIES}. ` +
    'Must NOT be set on media questions (image, audio, video, signature).'
  ),
  is_case_name: z.boolean().optional().describe(
    'True if this question provides the case name. Registration and followup forms that set or update the case name must have exactly one.'
  ),
}

const leafQuestionSchema = z.object(questionFields)

const questionSchema = z.object({
  ...questionFields,
  children: z.array(leafQuestionSchema).optional().describe('Nested questions for group/repeat types'),
})

// ── Child Case Schema ─────────────────────────────────────────────────

const childCaseSchema = z.object({
  case_type: z.string().describe(
    'The child case type in snake_case (e.g. "referral", "pregnancy", "household_member"). Only letters, digits, underscores, hyphens.'
  ),
  case_name_field: z.string().describe(
    'Question id whose value becomes the child case name'
  ),
  case_properties: z.array(casePropertyMappingSchema).optional().describe(
    'Child case property-to-question mappings. Do NOT use reserved property names.'
  ),
  relationship: z.enum(['child', 'extension']).optional().describe(
    '"child" (default) or "extension". Use "extension" when the child should prevent the parent from being closed.'
  ),
  repeat_context: z.string().optional().describe(
    'Question id of a repeat group — creates one child case per repeat entry'
  ),
}).describe('Creates a child/sub-case linked to the parent case')

// ── Form Schema ──────────────────────────────────────────────────────

export const blueprintFormSchema = z.object({
  name: z.string().describe('Display name for the form'),
  type: z.enum(['registration', 'followup', 'survey']).describe(
    '"registration" creates a new case. "followup" updates an existing case. "survey" is standalone data collection with no case management.'
  ),
  close_case: z.object({
    question: z.string().optional().describe('Question id to check for conditional close'),
    answer: z.string().optional().describe('Value that triggers case closure'),
  }).optional().describe(
    'Followup forms only. Present = close the case. Empty {} = always close. {question, answer} = close only when that answer is selected. Omit entirely if form should not close the case.'
  ),
  child_cases: z.array(childCaseSchema).optional().describe(
    'Create child/sub-cases linked to the current case. Valid on both registration and followup forms.'
  ),
  questions: z.array(questionSchema).describe(
    'Array of questions with nested children for groups/repeats. Every form must have at least one question.'
  ),
}).describe('A form within a module')

// ── Module and App schemas ──────────────────────────────────────────────

const caseListColumnSchema = z.object({
  field: z.string().describe('Case property name'),
  header: z.string().describe('Column header display text'),
})

const blueprintModuleSchema = z.object({
  name: z.string().describe('Display name for the module/menu'),
  case_type: z.string().optional().describe(
    'Required if any form is "registration" or "followup". Use short snake_case (e.g. "patient", "household_visit"). Only letters, digits, underscores, hyphens.'
  ),
  forms: z.array(blueprintFormSchema).describe('Array of forms in this module'),
  case_list_columns: z.array(caseListColumnSchema).optional().describe(
    'Columns shown in the case list. Each has "field" (case property) and "header" (display text). Use "case_name" to display the case name.'
  ),
  case_detail_columns: z.array(caseListColumnSchema).optional().describe(
    'Columns shown in the case detail view (when a user taps on a case). Omit to auto-mirror case_list_columns.'
  ),
}).describe('A module (menu) in the app')

/** Top-level schema for a complete CommCare app in blueprint format. */
export const appBlueprintSchema = z.object({
  app_name: z.string().describe('Name of the CommCare application'),
  modules: z.array(blueprintModuleSchema).describe(
    'Array of modules. Each module is a menu containing forms.'
  ),
  case_types: z.array(caseTypeSchema).nullable().describe(
    'Case type definitions with property metadata. null if all modules are survey-only.'
  ),
}).describe('A CommCare application definition in blueprint format')

// ── Types ──────────────────────────────────────────────────────────────

export type AppBlueprint = z.infer<typeof appBlueprintSchema>
export type BlueprintModule = z.infer<typeof blueprintModuleSchema>
export type BlueprintForm = z.infer<typeof blueprintFormSchema>
export type Question = z.infer<typeof questionSchema>
export type BlueprintChildCase = z.infer<typeof childCaseSchema>
export type CaseProperty = z.infer<typeof casePropertySchema>
export type CaseType = z.infer<typeof caseTypeSchema>

export type CasePropertyMapping = z.infer<typeof casePropertyMappingSchema>
export type Scaffold = z.infer<typeof scaffoldModulesSchema>
export type ModuleContent = z.infer<typeof moduleContentSchema>

// ── JSON Schema export ─────────────────────────────────────────────────

export function getAppBlueprintJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(appBlueprintSchema)
}

// ── Summary utility ────────────────────────────────────────────────────

/** Generate a concise text summary of an AppBlueprint for chat context. */
export function summarizeBlueprint(bp: AppBlueprint): string {
  const lines = [`App: "${bp.app_name}"`]
  if (bp.case_types) {
    for (const ct of bp.case_types) {
      lines.push(`  Case type "${ct.name}": ${ct.properties.map(p => p.name).join(', ')}`)
    }
  }
  for (const mod of bp.modules) {
    lines.push(`  Module: "${mod.name}" (case_type: ${mod.case_type ?? 'none'})`)
    if (mod.case_list_columns?.length) {
      lines.push(`    Columns: ${mod.case_list_columns.map(c => c.header).join(', ')}`)
    }
    for (const form of mod.forms) {
      const qCount = form.questions?.length ?? 0
      lines.push(`    Form: "${form.name}" (${form.type}, ${qCount} questions)`)
    }
  }
  return lines.join('\n')
}

// ── Data model defaults merge ──────────────────────────────────────────

/** Merge data model defaults from case property metadata into a question. */
export function mergeQuestionDefaults(
  question: Question,
  caseTypes: CaseType[] | null,
  moduleCaseType: string | undefined,
): Question {
  if (!question.case_property || !caseTypes || !moduleCaseType) return question
  const ct = caseTypes.find(c => c.name === moduleCaseType)
  const prop = ct?.properties.find(p => p.name === question.case_property)
  if (!prop) return question

  // Auto-derive is_case_name when this question maps to the case name property
  const isCaseName = question.is_case_name ?? (ct!.case_name_property === question.case_property ? true : undefined)

  return {
    ...question,
    label: question.label ?? prop.label,
    hint: question.hint ?? prop.hint,
    help: question.help ?? prop.help,
    required: question.required ?? prop.required,
    constraint: question.constraint ?? prop.constraint,
    constraint_msg: question.constraint_msg ?? prop.constraint_msg,
    options: question.options ?? prop.options,
    ...(isCaseName != null && { is_case_name: isCaseName }),
  }
}

/** Recursively merge data model defaults into a form's question tree. */
export function mergeFormQuestions(
  questions: Question[],
  caseTypes: CaseType[] | null,
  moduleCaseType: string | undefined,
): Question[] {
  return questions.map(q => {
    const merged = mergeQuestionDefaults(q, caseTypes, moduleCaseType)
    if (q.children) {
      return { ...merged, children: mergeFormQuestions(q.children, caseTypes, moduleCaseType) }
    }
    return merged
  })
}

// ── Case config derivation ─────────────────────────────────────────────

/**
 * Derive form-level case config from per-question case_property / is_case_name fields.
 * Works on any question-like objects with nested children.
 */
interface CaseConfigQuestion {
  id: string
  case_property?: string
  is_case_name?: boolean
  children?: CaseConfigQuestion[]
}

export function deriveCaseConfig(questions: CaseConfigQuestion[], formType: 'registration' | 'followup' | 'survey') {
  let case_name_field: string | undefined
  let case_properties: CasePropertyMapping[] | undefined
  let case_preload: CasePropertyMapping[] | undefined

  if (formType === 'survey') return { case_name_field, case_properties, case_preload }

  const props: CasePropertyMapping[] = []
  const preload: CasePropertyMapping[] = []

  function walk(qs: CaseConfigQuestion[]) {
    for (const q of qs) {
      if (q.is_case_name) case_name_field = q.id
      if (q.case_property) {
        if (formType === 'followup') {
          preload.push({ case_property: q.case_property, question_id: q.id })
        }
        props.push({ case_property: q.case_property, question_id: q.id })
      }
      if (q.children) walk(q.children)
    }
  }

  walk(questions)

  if (props.length > 0) case_properties = props
  if (preload.length > 0) case_preload = preload

  return { case_name_field, case_properties, case_preload }
}

