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
}

/** Navigation screen types for the preview. */
export type PreviewScreen =
  | { type: 'home' }
  | { type: 'module'; moduleIndex: number }
  | { type: 'caseList'; moduleIndex: number; formIndex: number }
  | { type: 'form'; moduleIndex: number; formIndex: number; caseData?: Map<string, string> }

/** A row of dummy case data for case list display. */
export interface DummyCaseRow {
  case_id: string
  /** Map of property name → display value */
  properties: Map<string, string>
}
