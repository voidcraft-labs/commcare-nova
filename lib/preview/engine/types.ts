/** Per-question reactive state tracked by the form engine. */
export interface QuestionState {
  path: string
  value: string
  visible: boolean
  required: boolean
  valid: boolean
  errorMessage?: string
  /** Whether the user has interacted with and left this field. */
  touched: boolean
  /** Label text with <output/> tags resolved. Only set when the label contains output tags. */
  resolvedLabel?: string
  /** Hint text with <output/> tags resolved. Only set when the hint contains output tags. */
  resolvedHint?: string
  /** When set, this field's value comes from an unresolved case property (no case data loaded). */
  caseRef?: string
}

/** Navigation screen types for the preview. */
export type PreviewScreen =
  | { type: 'home' }
  | { type: 'module'; moduleIndex: number }
  | { type: 'caseList'; moduleIndex: number; formIndex: number }
  | { type: 'form'; moduleIndex: number; formIndex: number; caseId?: string }

export function screensEqual(a: PreviewScreen, b: PreviewScreen): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'home') return true
  if (a.type === 'module' && b.type === 'module')
    return a.moduleIndex === b.moduleIndex
  if (a.type === 'caseList' && b.type === 'caseList')
    return a.moduleIndex === b.moduleIndex && a.formIndex === b.formIndex
  if (a.type === 'form' && b.type === 'form')
    return a.moduleIndex === b.moduleIndex
      && a.formIndex === b.formIndex
      && a.caseId === b.caseId
  return false
}

/** A row of dummy case data for case list display. */
export interface DummyCaseRow {
  case_id: string
  /** Map of property name → display value */
  properties: Map<string, string>
}
