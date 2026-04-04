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
  /** Label with hashtag refs evaluated to runtime values. Only set when the label contains refs. */
  resolvedLabel?: string
  /** Hint with hashtag refs evaluated to runtime values. Only set when the hint contains refs. */
  resolvedHint?: string
}

/** Navigation screen types for the preview. */
export type PreviewScreen =
  | { type: 'home' }
  | { type: 'module'; moduleIndex: number }
  | { type: 'caseList'; moduleIndex: number; formIndex: number }
  | { type: 'form'; moduleIndex: number; formIndex: number; caseId?: string }

/** Returns the immediate parent screen in the hierarchy, or undefined if already at home. */
export function getParentScreen(screen: PreviewScreen): PreviewScreen | undefined {
  switch (screen.type) {
    case 'module': return { type: 'home' }
    case 'caseList':
    case 'form': return { type: 'module', moduleIndex: screen.moduleIndex }
    default: return undefined
  }
}

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

/** Stable string key for a PreviewScreen, suitable as a React key.
 *  Encodes the screen's type and hierarchy indices so two screens at
 *  different navigation depths never collide, even if their labels match. */
export function screenKey(screen: PreviewScreen): string {
  switch (screen.type) {
    case 'home': return 'home'
    case 'module': return `module-${screen.moduleIndex}`
    case 'caseList': return `caseList-${screen.moduleIndex}-${screen.formIndex}`
    case 'form': return `form-${screen.moduleIndex}-${screen.formIndex}`
  }
}

/** A row of dummy case data for case list display. */
export interface DummyCaseRow {
  case_id: string
  /** Map of property name → display value */
  properties: Map<string, string>
}
