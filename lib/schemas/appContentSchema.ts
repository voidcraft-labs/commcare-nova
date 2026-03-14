/**
 * App Content Schema — unified structured output for columns + all forms.
 *
 * No nullable(), no optional() — the Anthropic schema compiler times out on anyOf unions.
 * Use empty string "" for absent string fields, empty array [] for absent arrays,
 * false for absent booleans.
 *
 * Questions use a flat shape (parentId + sortOrder) to avoid recursive schemas.
 * After generation, flat questions are converted to nested trees via
 * buildQuestionTree() and defaults are merged via processContentOutput().
 */
import { z } from 'zod'
import type { CaseType, Scaffold, ModuleContent, BlueprintForm, Question } from './blueprint'

// ── XPath utilities ──────────────────────────────────────────────────

const XPATH_FIELDS = ['constraint', 'relevant', 'calculate', 'default_value', 'required'] as const

/** Unescape HTML entities that LLMs sometimes emit in XPath strings. */
function unescapeXPath(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

// ── Output interfaces ────────────────────────────────────────────────
// These use standard TS optionals for the post-processing layer.
// The Zod schema below uses empty values instead of optional/nullable.

/** The flat question shape as it comes from the structured output (before tree conversion). */
export interface FlatQuestion {
  id: string
  type: string
  parentId: string
  sortOrder: number
  label?: string
  hint?: string
  help?: string
  required?: string
  readonly?: boolean
  constraint?: string
  constraint_msg?: string
  relevant?: string
  calculate?: string
  default_value?: string
  case_property?: string
  is_case_name?: boolean
  options?: Array<{ value: string; label: string }>
}

/** Content output for a single form. */
export interface FormContentOutput {
  formIndex: number
  questions: FlatQuestion[]
  close_case: { question: string; answer: string }
  child_cases: Array<{
    case_type: string
    case_name_field: string
    case_properties: Array<{ case_property: string; question_id: string }>
    relationship: 'child' | 'extension'
    repeat_context: string
  }>
}

/** Content output for a single module. */
export interface ModuleContentOutput {
  moduleIndex: number
  case_list_columns: Array<{ field: string; header: string }>
  case_detail_columns: Array<{ field: string; header: string }>
  forms: FormContentOutput[]
}

/** Top-level content output. */
export interface AppContentOutput {
  modules: ModuleContentOutput[]
}

// ── Schema ───────────────────────────────────────────────────────────
// NO nullable(). NO optional(). Empty values instead.

const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'trigger', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
] as const

const selectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
})

const casePropertyMappingSchema = z.object({
  case_property: z.string(),
  question_id: z.string(),
})

const columnSchema = z.object({
  field: z.string().describe('Case property name or "case_name"'),
  header: z.string().describe('Column header text — short and scannable'),
})

const questionSchema = z.object({
  id: z.string().describe(
    'Unique identifier within the form. Use snake_case starting with a letter (e.g. "patient_name", "visit_date").'
  ),
  type: z.enum(QUESTION_TYPES).describe(
    'Question type. Pick the most specific type: ' +
    '"phone" for phone numbers, "date"/"time"/"datetime" for temporal, ' +
    '"int" for whole numbers, "decimal" for measurements, ' +
    '"select1" for single-choice, "select" for multi-choice, ' +
    '"hidden" with calculate for computed values, "group"/"repeat" for nesting. ' +
    'Only "text" for genuinely free-text fields.'
  ),
  parentId: z.string().describe(
    'ID of the parent group or repeat question. Empty string for top-level questions.'
  ),
  sortOrder: z.number().describe(
    'Display order within the parent context. Start at 0, increment by 1.'
  ),
  label: z.string().describe(
    'Human-readable question text. Write clear labels like "Patient Name", "Date of Birth". ' +
    'Empty string when mapping to a case property to use the property label as default. ' +
    'Empty string for hidden questions.'
  ),
  hint: z.string().optional().describe(
    'Short hint shown below the question. Omit if none.'
  ),
  help: z.string().optional().describe(
    'Detailed help text shown on demand via help icon. Omit if none.'
  ),
  required: z.string().describe(
    '"true()" if always required. An XPath expression for conditional requirement (e.g. "/data/age >= 18"). Empty string if not required.'
  ),
  readonly: z.boolean().describe(
    'True if visible but not editable. Use for display-only preloaded values in followup forms. False if editable.'
  ),
  constraint: z.string().optional().describe(
    'XPath constraint expression (e.g. ". > 0 and . < 150"). Use raw operators (>, <, >=, <=), never HTML-escaped. Omit if none.'
  ),
  constraint_msg: z.string().optional().describe(
    'Human-friendly error message when constraint fails (e.g. "Age must be between 1 and 149"). Omit if none.'
  ),
  relevant: z.string().optional().describe(
    'XPath expression — question only shows when true. ' +
    'Use full path: /data/question_id for top-level, /data/group_id/question_id for nested. ' +
    'Use #case/property_name for case data. Omit if always shown.'
  ),
  calculate: z.string().optional().describe(
    'XPath expression for auto-computed value (recomputes as referenced values change). ' +
    'Required for "hidden" type questions. Use #case/property_name for case data. Omit if none.'
  ),
  default_value: z.string().optional().describe(
    'XPath expression for the initial value set when the form opens (one-time, not recalculated). ' +
    'Use #case/property_name to preload case data in followup forms. ' +
    'Different from calculate: default_value sets once on load, calculate updates continuously. Omit if none.'
  ),
  case_property: z.string().describe(
    'Case property this question maps to. Must match a property name from the module\'s case type. ' +
    'On registration forms, the answer is saved to this property. ' +
    'On followup forms, the property value is preloaded and saved back (unless readonly). ' +
    'Defaults (label, hint, constraint, etc.) are applied automatically from the data model. ' +
    'Empty string if this question does not map to a case property. ' +
    'Must NOT be set on media questions (image, audio, video, signature).'
  ),
  is_case_name: z.boolean().describe(
    'True if this question provides the case name. Registration and followup forms must have exactly one. ' +
    'Auto-derived from case_name_property when possible. False if not.'
  ),
  options: z.array(selectOptionSchema).describe(
    'Options for select1/select questions — at least 2 options. ' +
    'When mapping to a case property, defaults to the property options. ' +
    'Empty array for non-select question types.'
  ),
})

const childCaseSchema = z.object({
  case_type: z.string().describe('Child case type from the data model'),
  case_name_field: z.string().describe('Question id for child case name'),
  case_properties: z.array(casePropertyMappingSchema),
  relationship: z.enum(['child', 'extension']),
  repeat_context: z.string().describe('Repeat group question id, empty if not in repeat'),
})

const formSchema = z.object({
  formIndex: z.number().describe('0-based, matching scaffold order'),
  questions: z.array(questionSchema).describe('All questions using parentId for nesting and sortOrder for ordering'),
  close_case: z.object({
    question: z.string().describe('Question id for conditional close, empty if unconditional or no close'),
    answer: z.string().describe('Value that triggers closure, empty if unconditional or no close'),
  }).describe('Both empty = no close case. Both set = conditional close. Use "__unconditional__" in question field for unconditional close.'),
  child_cases: z.array(childCaseSchema).describe('Empty array if no child cases'),
})

const moduleSchema = z.object({
  moduleIndex: z.number().describe('0-based, matching scaffold order'),
  case_list_columns: z.array(columnSchema).describe('Empty array for survey-only modules'),
  case_detail_columns: z.array(columnSchema).describe('Empty array to mirror case_list_columns'),
  forms: z.array(formSchema),
})

export const appContentSchema = z.object({
  modules: z.array(moduleSchema),
})

// ── Post-processing: strip empty values ──────────────────────────────

/** Convert empty strings to undefined, empty arrays to undefined, false booleans to undefined.
 *  With optional schema fields, values may already be undefined — pass through as-is. */
function stripEmpty(q: FlatQuestion): Partial<FlatQuestion> {
  const result: any = {}
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue
    if (v === '') continue
    if (v === false && k !== 'type') continue
    if (Array.isArray(v) && v.length === 0) continue
    result[k] = v
  }
  // parentId: empty string → null for tree building
  if (result.parentId === undefined) result.parentId = null
  else if (result.parentId === '') result.parentId = null
  return result
}

// ── Post-processing: flat → nested tree ──────────────────────────────

/**
 * Convert flat questions (parentId + sortOrder) to a nested tree (children arrays).
 */
export function buildQuestionTree(flat: Array<Partial<FlatQuestion>>): Question[] {
  const sorted = [...flat].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))

  const byParent = new Map<string | null, Array<Partial<FlatQuestion>>>()
  for (const q of sorted) {
    const parent = q.parentId || null
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent)!.push(q)
  }

  function buildLevel(parentId: string | null): Question[] {
    const children = byParent.get(parentId) ?? []
    return children.map(q => {
      const { parentId: _, sortOrder: __, ...rest } = q
      const nested = buildLevel(q.id!)
      if (nested.length > 0) {
        return { ...rest, children: nested } as Question
      }
      return rest as Question
    })
  }

  return buildLevel(null)
}

// ── Post-processing: data model defaults + XPath sanitization ────────

/**
 * Apply data model defaults from case type metadata and sanitize XPath.
 */
function applyDefaults(q: Partial<FlatQuestion>, caseType: CaseType | null): Partial<FlatQuestion> {
  const result = { ...q }

  // Unescape HTML entities in XPath fields
  for (const f of XPATH_FIELDS) {
    const val = result[f as keyof FlatQuestion]
    if (typeof val === 'string') {
      ;(result as any)[f] = unescapeXPath(val)
    }
  }

  // Merge data model defaults from case type
  if (result.case_property && caseType) {
    const prop = caseType.properties.find(p => p.name === result.case_property)
    if (prop) {
      result.type ??= (prop.data_type ?? 'text') as any
      result.label ??= prop.label
      result.hint ??= prop.hint
      result.help ??= prop.help
      result.required ??= prop.required
      result.constraint ??= prop.constraint
      result.constraint_msg ??= prop.constraint_msg
      result.options ??= prop.options
    }
    // Auto-derive is_case_name
    result.is_case_name ??= caseType.case_name_property === result.case_property ? true : undefined
  }

  return result
}

// ── Full content processing ──────────────────────────────────────────

/**
 * Process raw content output into the format expected by assembleBlueprint.
 *
 * Strips empty values from structured output, applies data model defaults,
 * converts flat questions to nested trees.
 */
export function processContentOutput(
  content: AppContentOutput,
  scaffold: Scaffold,
): { moduleContents: ModuleContent[]; formContents: BlueprintForm[][] } {
  const caseTypes = scaffold.case_types ?? []

  const moduleContents: ModuleContent[] = []
  const formContents: BlueprintForm[][] = []

  for (const modOutput of content.modules) {
    const mIdx = modOutput.moduleIndex
    const scaffoldMod = scaffold.modules[mIdx]
    const ct = caseTypes.find(c => c.name === scaffoldMod?.case_type) ?? null

    // Module content (columns) — empty array → null for assembleBlueprint compatibility
    moduleContents[mIdx] = {
      case_list_columns: modOutput.case_list_columns.length > 0 ? modOutput.case_list_columns : null,
      case_detail_columns: modOutput.case_detail_columns.length > 0 ? modOutput.case_detail_columns : null,
    }

    // Form contents
    formContents[mIdx] = []
    for (const formOutput of modOutput.forms) {
      const fIdx = formOutput.formIndex
      const scaffoldForm = scaffoldMod?.forms[fIdx]

      // Strip empties, apply defaults, convert to nested tree
      const stripped = formOutput.questions.map(q => stripEmpty(q))
      const withDefaults = stripped.map(q => applyDefaults(q, ct))
      const nestedQuestions = buildQuestionTree(withDefaults)

      // Process close_case — empty strings mean no close case
      const hasCloseCase = formOutput.close_case.question || formOutput.close_case.answer
      const closeCase = hasCloseCase ? {
        ...(formOutput.close_case.question && { question: formOutput.close_case.question }),
        ...(formOutput.close_case.answer && { answer: formOutput.close_case.answer }),
      } : undefined

      // Process child_cases — empty array means none
      const childCases = formOutput.child_cases.length > 0 ? formOutput.child_cases.map(cc => ({
        ...cc,
        // Strip empty repeat_context
        ...(cc.repeat_context ? { repeat_context: cc.repeat_context } : {}),
      })) : undefined

      formContents[mIdx][fIdx] = {
        name: scaffoldForm?.name ?? `Form ${fIdx}`,
        type: scaffoldForm?.type ?? 'survey',
        questions: nestedQuestions,
        ...(closeCase && { close_case: closeCase }),
        ...(childCases && { child_cases: childCases }),
      }
    }
  }

  return { moduleContents, formContents }
}

/**
 * Process a single form's flat questions into a BlueprintForm.
 * Used by regenerateForm and validateAndFix empty form fallback.
 */
export function processSingleFormOutput(
  formOutput: FormContentOutput,
  formName: string,
  formType: 'registration' | 'followup' | 'survey',
  caseType: CaseType | null,
): BlueprintForm {
  const stripped = formOutput.questions.map(q => stripEmpty(q))
  const withDefaults = stripped.map(q => applyDefaults(q, caseType))
  const nestedQuestions = buildQuestionTree(withDefaults)

  const hasCloseCase = formOutput.close_case.question || formOutput.close_case.answer
  const closeCase = hasCloseCase ? {
    ...(formOutput.close_case.question && { question: formOutput.close_case.question }),
    ...(formOutput.close_case.answer && { answer: formOutput.close_case.answer }),
  } : undefined

  const childCases = formOutput.child_cases.length > 0 ? formOutput.child_cases : undefined

  return {
    name: formName,
    type: formType,
    questions: nestedQuestions,
    ...(closeCase && { close_case: closeCase }),
    ...(childCases && { child_cases: childCases }),
  }
}
