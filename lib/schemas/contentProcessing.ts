/**
 * Content post-processing utilities for structured output from form generation.
 *
 * Converts flat questions (parentId-based) to nested trees, strips empty sentinel
 * values from structured output, and merges data model defaults from case types.
 */
import type { CaseType, BlueprintForm, Question } from './blueprint'

// ── XPath utilities ──────────────────────────────────────────────────

const XPATH_FIELDS = ['validation', 'relevant', 'calculate', 'default_value', 'required'] as const

/** Unescape HTML entities that LLMs sometimes emit in XPath strings. */
function unescapeXPath(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

// ── Types ───────────────────────────────────────────────────────────

/** The flat question shape as it comes from structured output (before tree conversion). */
export interface FlatQuestion {
  id: string
  type: string
  parentId: string
  label?: string
  hint?: string
  help?: string
  required?: string
  validation?: string
  validation_msg?: string
  relevant?: string
  calculate?: string
  default_value?: string
  case_property?: string
  is_case_name?: boolean
  options?: Array<{ value: string; label: string }>
}

/** Content output for a single form (structured output shape). */
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

// ── Strip empty sentinel values ─────────────────────────────────────

/** Convert empty strings to undefined, empty arrays to undefined, false booleans to undefined.
 *  With optional schema fields, values may already be undefined — pass through as-is. */
export function stripEmpty(q: FlatQuestion): Partial<FlatQuestion> {
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

// ── Flat → nested tree conversion ───────────────────────────────────

/**
 * Convert flat questions (parentId) to a nested tree (children arrays).
 * Array order is preserved — questions appear in the order they were generated.
 */
export function buildQuestionTree(flat: Array<Partial<FlatQuestion>>): Question[] {
  const byParent = new Map<string | null, Array<Partial<FlatQuestion>>>()
  for (const q of flat) {
    const parent = q.parentId || null
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent)!.push(q)
  }

  function buildLevel(parentId: string | null): Question[] {
    const children = byParent.get(parentId) ?? []
    return children.map(q => {
      const { parentId: _, ...rest } = q
      const nested = buildLevel(q.id!)
      if (nested.length > 0) {
        return { ...rest, children: nested } as Question
      }
      return rest as Question
    })
  }

  return buildLevel(null)
}

// ── Data model defaults + XPath sanitization ────────────────────────

/**
 * Apply data model defaults from case type metadata and sanitize XPath.
 */
export function applyDefaults(q: Partial<FlatQuestion>, caseType: CaseType | null): Partial<FlatQuestion> {
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
      result.validation ??= prop.validation
      result.validation_msg ??= prop.validation_msg
      result.options ??= prop.options
    }
    // Auto-derive is_case_name
    result.is_case_name ??= caseType.case_name_property === result.case_property ? true : undefined
  }

  return result
}

// ── Single form processing ──────────────────────────────────────────

/**
 * Process a single form's flat questions into a BlueprintForm.
 * Strips empty sentinels, applies data model defaults, converts to nested tree.
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
