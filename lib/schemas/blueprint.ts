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
  'text', 'int', 'date', 'single_select', 'multi_select', 'geopoint', 'image',
  'barcode', 'decimal', 'label', 'time', 'datetime',
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
  'single_select', 'multi_select', 'geopoint',
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
  required: z.string().optional().describe('"true()" if always required. Omit if optional. String values must be quoted: `\'text\'`, not `text`.'),
  validation: z.string().optional().describe('XPath validation expression, e.g. ". > 0 and . < 150". String values must be quoted: `\'text\'`, not `text`.'),
  validation_msg: z.string().optional().describe('Error message when validation fails.'),
  options: z.array(selectOptionSchema).optional().describe('Options for single_select/multi_select properties.'),
})

const caseTypeSchema = z.object({
  name: z.string().describe('Case type name in snake_case (e.g., "patient", "household")'),
  properties: z.array(casePropertySchema).describe('Case properties to track. Forms will create questions to capture these. The case name question must always have id "case_name".'),
  parent_type: z.string().optional().describe(
    'Parent case type name. Present only for child case types (e.g., a "child" case type with parent_type "mother").'
  ),
  relationship: z.enum(['child', 'extension']).optional().describe(
    '"child" (default) or "extension". Only used when parent_type is set. Use "extension" when the child should prevent the parent from being closed.'
  ),
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
    'Unique identifier per parent level. Use alphanumeric snake_case (must start with a letter).'
  ),
  type: z.enum(QUESTION_TYPES).describe(
    'Question type. Always pick the most specific type available: ' +
    '"text" for free text values (shape can be enforced with validation expression), ' +
    '"date"/"time"/"datetime" for temporal values, ' +
    '"int" for whole numbers (age, count, quantity), ' +
    '"decimal" for measurements (weight, height, price), ' +
    '"single_select" for any fixed single-choice (yes/no, gender, status), ' +
    '"multi_select" for multi-choice (symptoms, services), ' +
    '"geopoint" for GPS, "image"/"audio"/"video"/"signature"/"barcode" for media capture, ' +
    '"hidden" with "calculate" for computed values (BMI, risk score, age from DOB), ' +
    '"secret" for passwords/PINs, ' +
    '"group"/"repeat" for nesting. '
  ),
  label: z.string().optional().describe(
    'Human-friendly label for the element. `<output value="{XPath}"/>` will be replaced with the result `{XPath}` on load and when any of its dependencies change.' +
    'Omit for hidden questions — they have no visible label.'
  ),
  hint: z.string().optional().describe('Help text shown below the question.'),
  help: z.string().optional().describe('Extended help text accessible via help icon.'),
  required: z.string().optional().describe(
    'An XPath expression for requiring the element (can be `true()` for always required).'
  ),
  validation: z.string().optional().describe('XPath expression for validation.'),
  validation_msg: z.string().optional().describe('Error message when validation fails.'),
  relevant: z.string().optional().describe(
    'XPath expression evaluated to conditionally show or hide this element.'
  ),
  calculate: z.string().optional().describe(
    'XPath expression evaluated on form load and after any its dependency updates.'
  ),
  default_value: z.string().optional().describe(
    'XPath expression evaluated once on form load.'
  ),
  options: z.array(selectOptionSchema).optional().describe(
    'Options for single_select/multi_select questions — at least 2 options. Omit for all other question types.'
  ),
  case_property_on: z.string().optional().describe(
    'Case type name this question saves to (e.g. "patient"). ' +
    'When this matches the module\'s case_type, the question is a normal case property. ' +
    'When different, it creates a child case of that type. ' +
    'The question for the case name must always have id "case_name". ' +
    `Question id must NOT be a reserved name: ${RESERVED_CASE_PROPERTIES}. ` +
    'Must NOT be set on media questions (image, audio, video, signature).'
  ),
}

const questionSchema: z.ZodType<Question> = z.object({
  ...questionFields,
  children: z.lazy(() => z.array(questionSchema)).optional().describe('Nested questions for group/repeat types'),
})

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

export type BlueprintForm = z.infer<typeof blueprintFormSchema>
export type BlueprintModule = z.infer<typeof blueprintModuleSchema>
export type AppBlueprint = z.infer<typeof appBlueprintSchema>
/** Recursive question type — supports arbitrary nesting depth for groups/repeats. */
export interface Question {
  id: string
  type: typeof QUESTION_TYPES[number]
  label?: string
  hint?: string
  help?: string
  required?: string
  validation?: string
  validation_msg?: string
  relevant?: string
  calculate?: string
  default_value?: string
  options?: Array<{ value: string; label: string }>
  case_property_on?: string
  children?: Question[]
}
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

// ── Case config derivation ─────────────────────────────────────────────

/**
 * Derive form-level case config from per-question case_property_on fields.
 *
 * Questions with case_property_on matching the module's case type → primary case config.
 * Questions with case_property_on pointing to a different type → child case creation.
 * Case name is always the question with id "case_name" within each case type group.
 */
export interface CaseConfigQuestion {
  id: string
  type?: string
  case_property_on?: string
  children?: CaseConfigQuestion[]
}

export interface DerivedChildCase {
  case_type: string
  case_name_field: string
  case_properties: CasePropertyMapping[]
  relationship: 'child' | 'extension'
  repeat_context?: string
}

export interface DerivedCaseConfig {
  case_name_field?: string
  case_properties?: CasePropertyMapping[]
  case_preload?: CasePropertyMapping[]
  child_cases?: DerivedChildCase[]
}

export function deriveCaseConfig(
  questions: CaseConfigQuestion[],
  formType: 'registration' | 'followup' | 'survey',
  moduleCaseType?: string,
  caseTypes?: CaseType[] | null,
): DerivedCaseConfig {
  const empty: DerivedCaseConfig = {}
  if (formType === 'survey') return empty

  const primaryProps: CasePropertyMapping[] = []
  const primaryPreload: CasePropertyMapping[] = []
  let case_name_field: string | undefined

  // Child case groups: case_type → { questions with their repeat ancestor }
  const childGroups = new Map<string, Array<{ id: string; repeatAncestor?: string }>>()

  function walk(qs: CaseConfigQuestion[], repeatAncestor?: string) {
    for (const q of qs) {
      const currentRepeat = (q.type === 'repeat') ? q.id : repeatAncestor

      if (q.case_property_on) {
        if (q.case_property_on === moduleCaseType) {
          // Primary case property
          if (q.id === 'case_name') {
            case_name_field = q.id
          } else {
            if (formType === 'followup') {
              primaryPreload.push({ case_property: q.id, question_id: q.id })
            }
            primaryProps.push({ case_property: q.id, question_id: q.id })
          }
        } else {
          // Child case property
          if (!childGroups.has(q.case_property_on)) childGroups.set(q.case_property_on, [])
          childGroups.get(q.case_property_on)!.push({ id: q.id, repeatAncestor: currentRepeat })
        }
      }

      if (q.children) walk(q.children, currentRepeat)
    }
  }

  walk(questions)

  const result: DerivedCaseConfig = {}
  if (case_name_field) result.case_name_field = case_name_field
  if (primaryProps.length > 0) result.case_properties = primaryProps
  if (primaryPreload.length > 0) result.case_preload = primaryPreload

  // Derive child cases
  if (childGroups.size > 0 && caseTypes) {
    const derived: DerivedChildCase[] = []

    for (const [childType, entries] of childGroups) {
      const ctDef = caseTypes.find(ct => ct.name === childType)
      const relationship = ctDef?.relationship ?? 'child'

      // Find case_name question for this child type
      const nameEntry = entries.find(e => e.id === 'case_name')
      const childCaseName = nameEntry?.id ?? entries[0].id

      // Properties: all entries except the case name
      const childProps: CasePropertyMapping[] = entries
        .filter(e => e.id !== childCaseName)
        .map(e => ({ case_property: e.id, question_id: e.id }))

      // Repeat context: if all entries share the same repeat ancestor, use it
      const repeatAncestors = new Set(entries.map(e => e.repeatAncestor).filter(Boolean))
      const repeat_context = repeatAncestors.size === 1 ? [...repeatAncestors][0] : undefined

      derived.push({
        case_type: childType,
        case_name_field: childCaseName,
        case_properties: childProps,
        relationship,
        ...(repeat_context && { repeat_context }),
      })
    }

    result.child_cases = derived
  }

  return result
}

