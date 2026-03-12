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

/** Single translation entry for multilingual strings. */
const translationSchema = z.object({
  lang: z.string().describe('Language code (e.g. "en", "hin", "fra")'),
  text: z.string().describe('Text in this language'),
})

/**
 * Localized string — array of per-language translations.
 * e.g. [{"lang": "en", "text": "Patient Name"}] or [{"lang": "en", "text": "Patient Name"}, {"lang": "hin", "text": "रोगी का नाम"}]
 * Single-language apps still use the array format with one entry.
 */
export const localizedStringSchema = z.array(translationSchema)

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: localizedStringSchema.describe('Option label (shown to user)'),
})

/** Typed pair for case property ↔ question mappings (replaces Record<string, string>). */
const casePropertyMappingSchema = z.object({
  case_property: z.string().describe('Case property name'),
  question_id: z.string().describe('Question id in the form'),
})

const RESERVED_CASE_PROPERTIES = 'case_id, case_type, closed, closed_by, closed_on, date, date_modified, date_opened, doc_type, domain, external_id, index, indices, modified_on, name, opened_by, opened_on, owner_id, server_modified_on, status, type, user_id, xform_id'

// ── Tier 1: Scaffold Schema ────────────────────────────────────────────

export const scaffoldSchema = z.object({
  app_name: z.string().describe('Name of the CommCare application'),
  description: z.string().describe('Brief description of the app purpose and target users'),
  languages: z.array(z.string()).nullable().describe(
    'Language codes (e.g. ["en", "hin", "fra"]). First is the default language. null for English-only apps.'
  ),
  modules: z.array(z.object({
    name: localizedStringSchema.describe('Display name for the module/menu'),
    case_type: z.string().nullable().describe(
      'References a case_type name from the case_types array. Required if any form is "registration" or "followup". null for survey-only modules.'
    ),
    purpose: z.string().describe("Brief description of this module's role in the app"),
    forms: z.array(z.object({
      name: localizedStringSchema.describe('Display name for the form'),
      type: z.enum(['registration', 'followup', 'survey']).describe(
        '"registration" creates a new case (module must have case_type). ' +
        '"followup" updates an existing case (module must have case_type). ' +
        '"survey" is standalone data collection with no case management.'
      ),
      purpose: z.string().describe('Brief description of what this form collects and why'),
    })),
  })),
  case_types: z.array(z.object({
    name: z.string().describe('Case type name in snake_case (e.g., "patient", "household")'),
    case_name_property: z.string().describe(
      'Which property identifies this case (used as the case name). Must match one of the property names below.'
    ),
    properties: z.array(z.object({
      name: z.string().describe(
        'Property name in snake_case. ' +
        `Must NOT be a reserved word: ${RESERVED_CASE_PROPERTIES}. ` +
        'Must NOT be media/binary (photos, audio, video, signatures). ' +
        'Use descriptive alternatives (e.g. "visit_date" not "date", "full_name" not "name").'
      ),
      label: z.string().describe('Human-readable label (e.g., "Patient Age", "Gender")'),
    })).describe('Case properties to track. Forms will create questions to capture these.'),
  })).nullable().describe('Case types and their properties. null if all modules are survey-only.'),
})

// ── Tier 2: Module Content Schema ──────────────────────────────────────

export const moduleContentSchema = z.object({
  case_list_columns: z.array(z.object({
    field: z.string().describe('Case property name to display'),
    header: localizedStringSchema.describe('Column header text'),
  })).nullable().describe('Columns for the case list. null for survey-only modules.'),
  case_detail_columns: z.array(z.object({
    field: z.string().describe('Case property name'),
    header: localizedStringSchema.describe('Display label for this detail field'),
  })).nullable().describe(
    'Columns shown in the case detail view (when a user taps on a case). null to auto-mirror case_list_columns.'
  ),
})

// ── Tier 3: Form Content Schema ────────────────────────────────────────

const flatQuestionSchema = z.object({
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
  label: localizedStringSchema.describe(
    'Human-readable question text. Write clear, professional labels like "Patient Name", "Date of Birth". ' +
    'Empty array [] for hidden questions — they have no visible label.'
  ),
  parent_id: z.string().describe(
    'ID of the parent group/repeat question this belongs to, or empty string "" for top-level. Parent groups/repeats must appear BEFORE their children in the array.'
  ),
  hint: localizedStringSchema.describe('Help text shown below the question. Empty array [] if none.'),
  help: localizedStringSchema.describe('Extended help text accessible via help icon. Empty array [] if none.'),
  required: z.string().describe(
    '"true()" if always required. An XPath expression for conditional requirement (e.g. "/data/age >= 18"). Empty string "" if never required.'
  ),
  readonly: z.boolean().describe('True if visible but not editable (use for display-only preloaded values in followup forms), false otherwise'),
  constraint: z.string().nullable().describe('XPath constraint expression, e.g. ". > 0 and . < 150"'),
  constraint_msg: localizedStringSchema.describe('Error message when constraint fails. Empty array [] if none.'),
  relevant: z.string().nullable().describe(
    'XPath expression — question only shows when true. ' +
    'Use the full path: /data/question_id for top-level, /data/group_id/question_id for nested. ' +
    'Use #case/property_name to reference existing case data. ' +
    'e.g. "/data/age > 18", "#case/risk_level = \'high\'"'
  ),
  calculate: z.string().nullable().describe(
    'XPath expression for auto-computed value (use with type "hidden"). ' +
    'Use the full path: /data/question_id for top-level, /data/group_id/question_id for nested. ' +
    'Use #case/property_name to reference existing case data. ' +
    'Never reference the question\'s own node — use #case/ to read the current case value instead.'
  ),
  default_value: z.string().nullable().describe(
    'XPath expression for the initial value set when the form opens (one-time, not recalculated). ' +
    'Use #case/property_name to reference case data. Use string literals wrapped in quotes, e.g. "\'pending\'". ' +
    'Different from calculate: default_value sets once on load, calculate updates continuously.'
  ),
  options: z.array(selectOptionSchema).nullable().describe(
    'Required for select1/select questions. At least 2 options.'
  ),
  case_property: z.string().nullable().describe(
    'Case property name this question maps to. On registration forms, the answer is saved to this property. ' +
    'On followup forms, the property value is preloaded into the question AND saved back (unless readonly). ' +
    'null if this question does not map to a case property. ' +
    `Must NOT be a reserved name: ${RESERVED_CASE_PROPERTIES}. ` +
    'Must NOT be set on media questions (image, audio, video, signature).'
  ),
  is_case_name: z.boolean().describe(
    'True if this question provides the case name. Registration and followup forms that set or update the case name must have exactly one. false otherwise.'
  ),
})

const formChildCaseSchema = z.object({
  case_type: z.string().describe(
    'The child case type in snake_case (e.g. "referral", "pregnancy"). Only letters, digits, underscores, hyphens.'
  ),
  case_name_field: z.string().describe(
    'Question id whose value becomes the child case name'
  ),
  case_properties: z.array(casePropertyMappingSchema).nullable().describe(
    'Child case property-to-question mappings. Do NOT use reserved property names.'
  ),
  relationship: z.enum(['child', 'extension']).nullable().describe(
    '"child" (default) or "extension". Use "extension" when the child should prevent the parent from being closed.'
  ),
  repeat_context: z.string().nullable().describe(
    'Question id of a repeat group — creates one child case per repeat entry'
  ),
})

export const formContentSchema = z.object({
  close_case: z.object({
    question: z.string().nullable().describe('Question id to check for conditional close. null for unconditional close.'),
    answer: z.string().nullable().describe('Value that triggers case closure. null for unconditional close.'),
  }).nullable().describe(
    'Followup forms only. null = form does not close the case (this is the default — most forms should NOT close cases). ' +
    'Only include when the form\'s explicit purpose is to end/close/discharge/complete a case. ' +
    '{question: null, answer: null} = always close. {question, answer} = conditional close.'
  ),
  child_cases: z.array(formChildCaseSchema).nullable().describe(
    'Create child/sub-cases linked to the current case. null unless the form explicitly creates sub-entities.'
  ),
  questions: z.array(flatQuestionSchema).describe(
    'Flat array of questions. Use parent_id to nest inside groups/repeats. Every form must have at least one question.'
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
  label: localizedStringSchema.optional().describe(
    'Human-readable question text. Write clear, natural labels like "Patient Name", "Date of Birth". Omitted for hidden questions.'
  ),
  hint: localizedStringSchema.optional().describe('Help text shown below the question'),
  help: localizedStringSchema.optional().describe('Extended help text accessible via help icon'),
  required: z.string().optional().describe('"true()" if always required. XPath expression for conditional requirement. Omit or empty string if not required.'),
  readonly: z.boolean().optional().describe('True if visible but not editable (use for display-only preloaded values)'),
  constraint: z.string().optional().describe('XPath constraint expression, e.g. ". > 0 and . < 150"'),
  constraint_msg: localizedStringSchema.optional().describe('Error message when constraint fails. Omit if none.'),
  relevant: z.string().optional().describe('XPath expression — question only shows when true, e.g. "/data/age > 18"'),
  calculate: z.string().optional().describe('XPath expression for auto-computed value (use with type "hidden")'),
  default_value: z.string().optional().describe('XPath expression for the initial value set when the form opens'),
  options: z.array(selectOptionSchema).optional().describe(
    'Required for select1/select questions. At least 2 options.'
  ),
  case_property: z.string().optional().describe('Case property name this question maps to'),
  is_case_name: z.boolean().optional().describe('True if this question provides the case name'),
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

const blueprintFormSchema = z.object({
  name: localizedStringSchema.describe('Display name for the form'),
  type: z.enum(['registration', 'followup', 'survey']).describe(
    '"registration" creates a new case (MUST have case_name_field). "followup" updates an existing case (should have case_preload). "survey" has no case management.'
  ),
  case_name_field: z.string().optional().describe(
    'Registration forms only: question id whose value becomes the case name. Required for registration forms.'
  ),
  case_properties: z.array(casePropertyMappingSchema).optional().describe(
    'Case property-to-question mappings. These question values get saved to the case. Do NOT include case_name_field here. NEVER use reserved property names. NEVER map media questions (image, audio, video, signature).'
  ),
  case_preload: z.array(casePropertyMappingSchema).optional().describe(
    'Followup forms only: question-to-case-property mappings for pre-filling form questions with existing case data. To load case name use "case_name" as the case_property. If user should edit and save back, include same mapping in BOTH case_preload AND case_properties.'
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
  header: localizedStringSchema.describe('Column header display text'),
})

const blueprintModuleSchema = z.object({
  name: localizedStringSchema.describe('Display name for the module/menu'),
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
  languages: z.array(z.string()).optional().describe(
    'Language codes (e.g. ["en", "hin"]). First is the default. Omit for English-only.'
  ),
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

export type CasePropertyMapping = z.infer<typeof casePropertyMappingSchema>
export type Scaffold = z.infer<typeof scaffoldSchema>
export type ModuleContent = z.infer<typeof moduleContentSchema>
export type FormContent = z.infer<typeof formContentSchema>
export type FlatQuestion = z.infer<typeof flatQuestionSchema>

/** A localized string: array of per-language {lang, text} translations. */
export type LocalizedString = Array<{ lang: string; text: string }>

/** Resolve a localized string (or plain string) to plain text. */
export function displayText(value: string | LocalizedString | undefined | null): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (value.length === 0) return ''
  return value[0].text
}

/** Resolve a localized string for a specific language, with fallback. */
export function resolveLocalizedText(field: LocalizedString | undefined | null, lang: string, defaultLang: string): string {
  if (!field || field.length === 0) return ''
  return field.find(t => t.lang === lang)?.text ?? field.find(t => t.lang === defaultLang)?.text ?? field[0]?.text ?? ''
}

/** Convert a LocalizedString to an HQ-style Record<string, string>. */
export function toHqLocalizedRecord(field: LocalizedString, languages: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const l of languages) {
    result[l] = field.find(t => t.lang === l)?.text ?? field.find(t => t.lang === languages[0])?.text ?? field[0]?.text ?? ''
  }
  return result
}

// ── JSON Schema export ─────────────────────────────────────────────────

export function getAppBlueprintJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(appBlueprintSchema)
}

// ── Summary utility ────────────────────────────────────────────────────

/** Generate a concise text summary of an AppBlueprint for chat context. */
export function summarizeBlueprint(bp: AppBlueprint): string {
  const str = displayText
  const lines = [`App: "${bp.app_name}"`]
  if (bp.languages && bp.languages.length > 1) {
    lines.push(`  Languages: ${bp.languages.join(', ')}`)
  }
  for (const mod of bp.modules) {
    lines.push(`  Module: "${str(mod.name)}" (case_type: ${mod.case_type ?? 'none'})`)
    if (mod.case_list_columns?.length) {
      lines.push(`    Columns: ${mod.case_list_columns.map(c => str(c.header)).join(', ')}`)
    }
    for (const form of mod.forms) {
      const qCount = form.questions?.length ?? 0
      lines.push(`    Form: "${str(form.name)}" (${form.type}, ${qCount} questions)`)
    }
  }
  return lines.join('\n')
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
      ...(fq.label.length > 0 && { label: fq.label }),
      ...(fq.hint.length > 0 && { hint: fq.hint }),
      ...(fq.help.length > 0 && { help: fq.help }),
      ...(fq.required && { required: fq.required }),
      ...(fq.readonly && { readonly: fq.readonly }),
      ...(fq.constraint != null && { constraint: fq.constraint }),
      ...(fq.constraint_msg.length > 0 && { constraint_msg: fq.constraint_msg }),
      ...(fq.relevant != null && { relevant: fq.relevant }),
      ...(fq.calculate != null && { calculate: fq.calculate }),
      ...(fq.default_value != null && { default_value: fq.default_value }),
      ...(fq.options != null && { options: fq.options }),
      ...(fq.case_property != null && { case_property: fq.case_property }),
      ...(fq.is_case_name && { is_case_name: fq.is_case_name }),
    }

    byId.set(fq.id, q)

    if (!fq.parent_id) {
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
      label: q.label ?? [],
      parent_id: parentId ?? '',
      hint: q.hint ?? [],
      help: q.help ?? [],
      required: q.required ?? '',
      readonly: q.readonly ?? false,
      constraint: q.constraint ?? null,
      constraint_msg: q.constraint_msg ?? [],
      relevant: q.relevant ?? null,
      calculate: q.calculate ?? null,
      default_value: q.default_value ?? null,
      options: q.options ?? null,
      case_property: q.case_property ?? null,
      is_case_name: q.is_case_name ?? false,
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
    ...(c.case_properties != null && c.case_properties.length > 0 && { case_properties: c.case_properties }),
    ...(c.relationship != null && { relationship: c.relationship }),
    ...(c.repeat_context != null && { repeat_context: c.repeat_context }),
  }))
}

/**
 * Derive form-level case config from per-question case_property / is_case_name fields.
 */
export function deriveCaseConfig(questions: FlatQuestion[], formType: 'registration' | 'followup' | 'survey') {
  let case_name_field: string | undefined
  let case_properties: CasePropertyMapping[] | undefined
  let case_preload: CasePropertyMapping[] | undefined

  if (formType === 'survey') return { case_name_field, case_properties, case_preload }

  const props: CasePropertyMapping[] = []
  const preload: CasePropertyMapping[] = []

  for (const q of questions) {
    if (q.is_case_name) case_name_field = q.id
    if (q.case_property) {
      if (formType === 'followup') {
        preload.push({ case_property: q.case_property, question_id: q.id })
        if (!q.readonly) {
          props.push({ case_property: q.case_property, question_id: q.id })
        }
      } else {
        props.push({ case_property: q.case_property, question_id: q.id })
      }
    }
  }

  if (props.length > 0) case_properties = props
  if (preload.length > 0) case_preload = preload

  return { case_name_field, case_properties, case_preload }
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
    ...(scaffold.languages != null && { languages: scaffold.languages }),
    modules: scaffold.modules.map((sm, mIdx) => {
      const mc = moduleContents[mIdx]
      const forms: BlueprintForm[] = sm.forms.map((sf, fIdx) => {
        const fc = formContents[mIdx][fIdx]
        const { case_name_field, case_properties, case_preload } = deriveCaseConfig(fc.questions, sf.type)
        const closeCase = assembleCloseCase(fc.close_case)
        const childCases = assembleChildCases(fc.child_cases)

        return {
          name: sf.name,
          type: sf.type,
          ...(case_name_field != null && { case_name_field }),
          ...(case_properties != null && { case_properties }),
          ...(case_preload != null && { case_preload }),
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
        ...(mc.case_detail_columns != null && { case_detail_columns: mc.case_detail_columns }),
      }
    }),
  }
}
