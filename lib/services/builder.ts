import type { AppBlueprint, Scaffold, BlueprintForm, CaseType } from '@/lib/schemas/blueprint'
import type { QuestionPath } from './questionPath'
import type { EditFocus } from '@/lib/signalGridController'
import { countDeep } from './questionTree'
import { MutableBlueprint } from './mutableBlueprint'
import { HistoryManager, type SnapshotMeta, type ViewMode } from './historyManager'
export type { ViewMode } from './historyManager'

/** Apply a data part to a builder — shared between real-time streaming (onData) and replay. */
export function applyDataPart(builder: Builder, type: string, data: any): void {
  // Inject energy for signal grid based on data part significance
  switch (type) {
    case 'data-module-done':
    case 'data-form-done':
    case 'data-form-fixed':
      builder.injectEnergy(200); break
    case 'data-form-updated':
    case 'data-blueprint-updated':
      builder.injectEnergy(100); break
    case 'data-phase':
    case 'data-schema':
    case 'data-scaffold':
    case 'data-partial-scaffold':
    case 'data-fix-attempt':
      builder.injectEnergy(50); break
  }

  switch (type) {
    case 'data-start-build': builder.startDataModel(); break
    case 'data-schema': builder.setSchema(data.caseTypes); break
    case 'data-partial-scaffold': builder.setPartialScaffold(data); break
    case 'data-scaffold': builder.setScaffold(data); break
    case 'data-phase': builder.setPhase(data.phase); break
    case 'data-module-done': builder.setModuleContent(data.moduleIndex, data.caseListColumns); break
    case 'data-form-done':
    case 'data-form-fixed':
    case 'data-form-updated':
      builder.setFormContent(data.moduleIndex, data.formIndex, data.form); break
    case 'data-blueprint-updated': builder.updateBlueprint(data.blueprint); break
    case 'data-fix-attempt': builder.setFixAttempt(data.attempt, data.errorCount); break
    case 'data-done': builder.setDone(data); break
    case 'data-error':
      if (data.fatal) builder.setError(data.message)
      else builder.setRecovering(data.message)
      break
  }
}

export enum BuilderPhase {
  Idle = 'idle',
  DataModel = 'data-model',
  Structure = 'structure',
  Modules = 'modules',
  Forms = 'forms',
  Validate = 'validate',
  Fix = 'fix',
  Done = 'done',
  Error = 'error',
}

/** Status label for each build phase, shown in the Signal Grid panel. */
export const PHASE_LABELS: Record<BuilderPhase, string> = {
  [BuilderPhase.Idle]: '',
  [BuilderPhase.DataModel]: 'Designing data model',
  [BuilderPhase.Structure]: 'Designing app structure',
  [BuilderPhase.Modules]: 'Building app content',
  [BuilderPhase.Forms]: 'Building app content',
  [BuilderPhase.Validate]: 'Validating blueprint',
  [BuilderPhase.Fix]: 'Fixing validation errors',
  [BuilderPhase.Done]: '',
  [BuilderPhase.Error]: 'Error',
}

export interface SelectedElement {
  type: 'module' | 'form' | 'question'
  moduleIndex: number
  formIndex?: number
  questionPath?: QuestionPath
}

/** Scope the agent is currently editing — drives signal grid focus zone. */
export interface EditScope {
  moduleIndex: number
  formIndex?: number
  /** Flat question index within the form (0-based, depth-first). */
  questionIndex?: number
}

/** Common shape for AppTree rendering — satisfied by both Scaffold and AppBlueprint */
export interface TreeData {
  app_name: string
  connect_type?: string
  modules: Array<{
    name: string
    case_type?: string | null
    purpose?: string
    forms: Array<{
      name: string
      type: string
      purpose?: string
      questions?: Array<any>
      connect?: Record<string, unknown>
    }>
    case_list_columns?: Array<{ field: string; header: string }> | null
    case_detail_columns?: Array<{ field: string; header: string }> | null
  }>
}

/** Partial module data being built during streaming generation.
 *  caseListColumns is undefined (not yet received), null (server said no columns), or an array. */
interface PartialModule {
  caseListColumns?: Array<{ field: string; header: string }> | null
  forms: Map<number, any> // formIndex → assembled BlueprintForm
}

export class Builder {
  // ── Private state ────────────────────────────────────────────────────

  private _phase = BuilderPhase.Idle
  private _scaffold?: Scaffold
  private _mb?: MutableBlueprint
  private _history?: HistoryManager
  private _isDragging = false
  private _agentActive = false
  private _postBuildEdit = false
  private _caseTypes?: CaseType[]
  private _statusMessage = ''
  private _selected?: SelectedElement
  private _newQuestionPath?: QuestionPath
  private _editorTab: 'ui' | 'logic' | 'data' = 'ui'
  private _mutationCount = 0
  private _progressCompleted = 0
  private _progressTotal = 0
  private _partialModules = new Map<number, PartialModule>()
  private _partialScaffold?: { appName?: string; description?: string; modules: TreeData['modules'] }
  private _errorSeverity: 'recovering' | 'failed' = 'failed'
  private _listeners = new Set<() => void>()
  private _version = 0
  private _questionAnchor: { el: HTMLElement; path: QuestionPath } | null = null
  private _anchorListeners = new Set<() => void>()

  // ── Stream energy (non-versioned — consumed by SignalGrid rAF loop, never triggers React re-renders) ──
  private _streamEnergy = 0
  private _thinkEnergy = 0

  // ── Edit scope (non-versioned — consumed by SignalGrid rAF loop) ──
  private _editScope: EditScope | null = null


  // ── Read-only public accessors ───────────────────────────────────────

  get phase(): BuilderPhase { return this._phase }
  get agentActive(): boolean { return this._agentActive }

  /** True when agent activates in Done phase after the initial summary has completed.
   *  Used by ChatSidebar to distinguish post-build summary (reasoning) from user-initiated edits (editing). */
  get postBuildEdit(): boolean { return this._postBuildEdit }

  /** True when the build pipeline is running (DataModel through Fix). */
  get isGenerating(): boolean {
    return this._phase === BuilderPhase.DataModel ||
      this._phase === BuilderPhase.Structure ||
      this._phase === BuilderPhase.Modules ||
      this._phase === BuilderPhase.Forms ||
      this._phase === BuilderPhase.Validate ||
      this._phase === BuilderPhase.Fix
  }

  /** True when the agent is actively working but the build pipeline isn't running.
   *  Drives the thinking indicator in the chat sidebar. */
  get isThinking(): boolean {
    return this._agentActive && !this.isGenerating
  }

  get errorSeverity(): 'recovering' | 'failed' { return this._errorSeverity }
  get isRecovering(): boolean { return this._phase === BuilderPhase.Error && this._errorSeverity === 'recovering' }

  get scaffold(): Scaffold | undefined { return this._scaffold }
  get caseTypes(): CaseType[] | undefined { return this._caseTypes }
  get statusMessage(): string { return this._statusMessage }
  get selected(): SelectedElement | undefined { return this._selected }
  get mutationCount(): number { return this._mutationCount }
  get editorTab(): 'ui' | 'logic' | 'data' { return this._editorTab }
  get questionAnchor(): { el: HTMLElement; path: QuestionPath } | null { return this._questionAnchor }
  get progressCompleted(): number { return this._progressCompleted }
  get progressTotal(): number { return this._progressTotal }

  /** Scaffold progress (0-1) derived from current state. Polled by SignalGrid rAF loop. */
  get scaffoldProgress(): number {
    if (this._phase === BuilderPhase.Idle) return 0
    if (this._phase === BuilderPhase.DataModel) return this._caseTypes ? 0.30 : 0.05
    if (this._phase === BuilderPhase.Structure) {
      if (this._scaffold) return 0.85
      if (this._partialScaffold) return 0.55
      return 0.35
    }
    return 1.0
  }

  /** The current blueprint as plain data, or undefined. */
  get blueprint(): AppBlueprint | undefined {
    return this._mb?.getBlueprint()
  }

  /** The persistent MutableBlueprint instance for direct mutation.
   *  Returns the Proxy-wrapped version when history is active. */
  get mb(): MutableBlueprint | undefined {
    return this._history?.proxied ?? this._mb
  }

  // ── Subscribe ────────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }

  getSnapshot = () => this._version

  private notify() {
    this._version++
    this._listeners.forEach(fn => fn())
  }

  // ── Question anchor (selected question's DOM element) ────────────────

  /** Called by EditableQuestionWrapper ref callback when the selected question mounts/unmounts.
   *  Uses a separate listener set so only ContextualEditor re-renders — not the entire builder
   *  subscriber tree (which would re-render the wrapper and re-trigger the ref callback). */
  setQuestionAnchor = (anchor: { el: HTMLElement; path: QuestionPath } | null): void => {
    if (this._questionAnchor?.el === anchor?.el) return
    this._questionAnchor = anchor
    for (const fn of this._anchorListeners) fn()
  }

  subscribeAnchor = (fn: () => void) => {
    this._anchorListeners.add(fn)
    return () => { this._anchorListeners.delete(fn) }
  }

  getAnchorSnapshot = () => this._questionAnchor

  // ── New question state ───────────────────────────────────────────────

  /** Mark a question as newly added. Activates auto-focus and select-all behaviors. */
  markNewQuestion(path: QuestionPath): void {
    this._newQuestionPath = path
  }

  /** Returns true if the question at `path` was just added and hasn't been saved yet. */
  isNewQuestion(path: QuestionPath): boolean {
    return this._newQuestionPath === path
  }

  /** Deactivate new-question behaviors (called on first save). */
  clearNewQuestion(): void {
    this._newQuestionPath = undefined
  }

  setEditorTab(tab: 'ui' | 'logic' | 'data'): void {
    this._editorTab = tab
  }

  // ── Progress ─────────────────────────────────────────────────────────

  /** Derive progress counts from the scaffold and partialModules state. */
  private updateProgress() {
    if (!this._scaffold || (this._phase !== BuilderPhase.Modules && this._phase !== BuilderPhase.Forms)) {
      this._progressCompleted = 0
      this._progressTotal = 0
      return
    }

    // Total = modules + all forms across modules
    this._progressTotal = this._scaffold.modules.length +
      this._scaffold.modules.reduce((sum, m) => sum + m.forms.length, 0)

    // Completed = modules with columns + forms with content
    this._progressCompleted = 0
    for (const [, partial] of this._partialModules) {
      if (partial.caseListColumns !== undefined) this._progressCompleted++
      this._progressCompleted += partial.forms.size
    }
  }

  // ── View mode ────────────────────────────────────────────────────

  /** Update the current view mode — kept in sync by BuilderLayout. */
  setViewMode(mode: ViewMode) {
    if (this._history) this._history.viewMode = mode
  }

  // ── Drag state ────────────────────────────────────────────────────

  setDragging(active: boolean) {
    this._isDragging = active
  }

  /** Called by BuilderLayout to sync chat transport status with builder state. */
  setAgentActive(active: boolean) {
    if (this._agentActive === active) return
    // Agent reactivating after Done = user-initiated edit (not the post-build summary)
    if (active && this._phase === BuilderPhase.Done) {
      this._postBuildEdit = true
    }
    this._agentActive = active
    this.notify()
  }

  /** Inject burst energy from data parts (UI-visible changes). Drives building-mode flashes. */
  injectEnergy(amount: number): void {
    this._streamEnergy += amount
  }

  /** Inject think energy from token generation (text, reasoning, tool args). Drives neural firing. */
  injectThinkEnergy(amount: number): void {
    this._thinkEnergy += amount
  }

  /** Read and drain accumulated burst energy. Called by SignalGridController each animation frame. */
  drainEnergy(): number {
    const e = this._streamEnergy
    this._streamEnergy = 0
    return e
  }

  /** Read and drain accumulated think energy. Called by SignalGridController each animation frame. */
  drainThinkEnergy(): number {
    const e = this._thinkEnergy
    this._thinkEnergy = 0
    return e
  }

  // ── Edit focus (non-versioned — drives signal grid zone during editing) ──

  /** Update the scope the agent is currently editing. Null = no specific scope. */
  setEditScope(scope: EditScope | null): void {
    this._editScope = scope
  }

  /** Compute the normalized edit focus zone from the current scope and blueprint structure.
   *  Returns null when there's no blueprint or no scope (= full-width fallback). */
  computeEditFocus(): EditFocus | null {
    const bp = this._mb?.getBlueprint()
    if (!bp || !this._editScope) return null

    // Build a flat map: for each module, for each form, the cumulative question count.
    // This gives us the total question count and the position of any form within it.
    let total = 0
    const formPositions: Array<{ moduleIndex: number; formIndex: number; start: number; count: number }> = []

    for (let mi = 0; mi < bp.modules.length; mi++) {
      const mod = bp.modules[mi]
      if (!mod.forms) continue
      for (let fi = 0; fi < mod.forms.length; fi++) {
        const count = countDeep(mod.forms[fi].questions)
        formPositions.push({ moduleIndex: mi, formIndex: fi, start: total, count })
        total += count
      }
    }

    if (total === 0) return null

    const scope = this._editScope

    // Module-level scope (no formIndex): span all forms in the module
    if (scope.formIndex == null) {
      const modForms = formPositions.filter(f => f.moduleIndex === scope.moduleIndex)
      if (modForms.length === 0) return null
      const start = modForms[0].start / total
      const end = (modForms[modForms.length - 1].start + modForms[modForms.length - 1].count) / total
      return clampEditFocus(start, end)
    }

    // Form-level scope
    const form = formPositions.find(f => f.moduleIndex === scope.moduleIndex && f.formIndex === scope.formIndex)
    if (!form || form.count === 0) return null

    // Question-level scope
    if (scope.questionIndex != null) {
      const qPos = (form.start + Math.min(scope.questionIndex, form.count - 1)) / total
      // Zone centered on the question, min 15% width
      const halfZone = Math.max(MIN_EDIT_ZONE / 2, form.count / total * 0.3)
      return clampEditFocus(qPos - halfZone, qPos + halfZone)
    }

    // Form-level: span the whole form
    return clampEditFocus(form.start / total, (form.start + form.count) / total)
  }

  // ── Undo/Redo ──────────────────────────────────────────────────────

  private deriveSelection(meta: SnapshotMeta, direction: 'undo' | 'redo'): SelectedElement | undefined {
    const isUndo = direction === 'undo'
    let questionPath: QuestionPath | undefined

    switch (meta.type) {
      case 'add':
        questionPath = isUndo ? undefined : meta.questionPath
        break
      case 'remove':
        questionPath = isUndo ? meta.questionPath : undefined
        break
      case 'move':
      case 'update':
        questionPath = meta.questionPath
        break
      case 'duplicate':
        questionPath = isUndo ? meta.questionPath : meta.secondaryPath
        break
      case 'rename':
        questionPath = isUndo ? meta.questionPath : meta.secondaryPath
        break
      case 'structural':
        return undefined
    }

    if (!questionPath) return undefined

    // Verify the question exists in the restored blueprint
    if (!this._mb?.getQuestion(meta.moduleIndex, meta.formIndex, questionPath)) return undefined

    return {
      type: 'question',
      moduleIndex: meta.moduleIndex,
      formIndex: meta.formIndex,
      questionPath,
    }
  }

  undo(): ViewMode | undefined {
    if (this._isDragging) return undefined
    const result = this._history?.undo()
    if (!result) return undefined
    this._mb = result.mb
    this._selected = this.deriveSelection(result.meta, 'undo')
    this._mutationCount++
    this.notify()
    return result.viewMode
  }

  redo(): ViewMode | undefined {
    if (this._isDragging) return undefined
    const result = this._history?.redo()
    if (!result) return undefined
    this._mb = result.mb
    this._selected = this.deriveSelection(result.meta, 'redo')
    this._mutationCount++
    this.notify()
    return result.viewMode
  }

  get canUndo(): boolean {
    return this._history?.canUndo ?? false
  }

  get canRedo(): boolean {
    return this._history?.canRedo ?? false
  }

  /** Transition to data model phase (SA called generateSchema). */
  startDataModel() {
    if (this._history) {
      this._history.clear()
      this._history.enabled = false
    }
    this._phase = BuilderPhase.DataModel
    this._statusMessage = PHASE_LABELS[BuilderPhase.DataModel]
    this.notify()
  }

  /** Store case types from data model generation. */
  setSchema(caseTypes: CaseType[]) {
    this._caseTypes = caseTypes
    this.notify()
  }

  /** Update partial scaffold from streaming tool call args. */
  setPartialScaffold(partial: any) {
    if (!partial?.modules?.length) return
    this._partialScaffold = {
      appName: partial.app_name,
      modules: partial.modules.filter((m: any) => m?.name).map((m: any) => ({
        name: m.name,
        case_type: m.case_type,
        purpose: m.purpose,
        forms: (m.forms ?? []).filter((f: any) => f?.name).map((f: any) => ({
          name: f.name,
          type: f.type,
          purpose: f.purpose,
        })),
      })),
    }
    this._phase = BuilderPhase.Structure
    this._statusMessage = PHASE_LABELS[BuilderPhase.Structure]
    this.notify()
  }

  /** Store the completed scaffold for tree display. */
  setScaffold(scaffold: Scaffold) {
    this._scaffold = scaffold
    this._mb = undefined
    this._partialScaffold = undefined
    this.notify()
  }

  /** Update module content (case list columns). */
  setModuleContent(moduleIndex: number, caseListColumns: Array<{ field: string; header: string }> | null) {
    let partial = this._partialModules.get(moduleIndex)
    if (!partial) {
      partial = { forms: new Map() }
      this._partialModules.set(moduleIndex, partial)
    }
    partial.caseListColumns = caseListColumns
    this.updateProgress()
    this.notify()
  }

  /** Update form content (assembled form with questions). */
  setFormContent(moduleIndex: number, formIndex: number, form: BlueprintForm) {
    // During edit mode (_mb exists), update the blueprint directly
    if (this._mb) {
      this._mb.replaceForm(moduleIndex, formIndex, form)
    } else {
      // During initial build, accumulate in partialModules
      let partial = this._partialModules.get(moduleIndex)
      if (!partial) {
        partial = { forms: new Map() }
        this._partialModules.set(moduleIndex, partial)
      }
      partial.forms.set(formIndex, form)
      this.updateProgress()
    }
    this.notify()
  }

  /** Advance to a named phase with appropriate status message. */
  setPhase(phase: string) {
    const phaseMap: Record<string, BuilderPhase> = {
      structure: BuilderPhase.Structure,
      modules: BuilderPhase.Modules,
      forms: BuilderPhase.Forms,
      validate: BuilderPhase.Validate,
      fix: BuilderPhase.Fix,
    }
    const newPhase = phaseMap[phase]
    if (!newPhase) return
    this._phase = newPhase
    this._statusMessage = PHASE_LABELS[newPhase] || this._statusMessage
    this.updateProgress()
    this.notify()
  }

  /** Update status message for fix attempt progress. */
  setFixAttempt(attempt: number, errorCount: number) {
    this._statusMessage = `${PHASE_LABELS[BuilderPhase.Fix]} — ${errorCount} error${errorCount !== 1 ? 's' : ''} (attempt ${attempt})`
    this.notify()
  }

  /** Set the completed blueprint after validation. */
  setDone(result: { blueprint: AppBlueprint; hqJson: Record<string, any>; success: boolean }) {
    this._mb = new MutableBlueprint(result.blueprint)
    this._history = new HistoryManager(this._mb)
    this._partialModules.clear()
    this._phase = BuilderPhase.Done
    this._postBuildEdit = false
    this._statusMessage = ''
    this._progressCompleted = 0
    this._progressTotal = 0
    this.notify()
  }

  /** Set fatal error state — generation is over. */
  setError(message: string) {
    this._phase = BuilderPhase.Error
    this._errorSeverity = 'failed'
    this._statusMessage = message
    this._partialModules.clear()
    this.notify()
  }

  /** Set recovering state — the SA is attempting to fix the issue. */
  setRecovering(message: string) {
    this._phase = BuilderPhase.Error
    this._errorSeverity = 'recovering'
    this._statusMessage = message
    this.notify()
  }

  /** Provides a common shape for AppTree — uses blueprint if available, otherwise merges partials with scaffold, otherwise scaffold. */
  get treeData(): TreeData | undefined {
    if (this.blueprint) return this.blueprint

    if (this._scaffold && this._partialModules.size > 0) {
      // Overlay partial data on top of the scaffold
      return {
        app_name: this._scaffold.app_name,
        modules: this._scaffold.modules.map((sm, mIdx) => {
          const partial = this._partialModules.get(mIdx)
          return {
            name: sm.name,
            case_type: sm.case_type,
            purpose: sm.purpose,
            case_list_columns: partial?.caseListColumns !== undefined
              ? partial.caseListColumns
              : undefined,
            forms: sm.forms.map((sf, fIdx) => {
              const assembledForm = partial?.forms.get(fIdx)
              if (assembledForm) {
                return { ...assembledForm, purpose: sf.purpose }
              }
              return {
                name: sf.name,
                type: sf.type,
                purpose: sf.purpose,
              }
            }),
          }
        }),
      }
    }

    if (this._scaffold) return this._scaffold

    if (this._partialScaffold && this._partialScaffold.modules.length > 0) {
      return {
        app_name: this._partialScaffold.appName ?? '',
        modules: this._partialScaffold.modules,
      }
    }

    return undefined
  }

  select(el?: SelectedElement) {
    if (this._history && el && this._selected) {
      const prev = this._selected
      if (prev.formIndex !== undefined && el.formIndex !== undefined &&
          (prev.moduleIndex !== el.moduleIndex || prev.formIndex !== el.formIndex)) {
        this._history.clear()
      }
    }
    this._selected = el
    this.notify()
  }

  updateBlueprint(bp: AppBlueprint) {
    this._mb = new MutableBlueprint(bp)
    this.notify()
  }

  /** Notify subscribers that the blueprint was mutated in-place via mb. */
  notifyBlueprintChanged = () => {
    this._mutationCount++
    this.notify()
  }

  reset() {
    this._phase = BuilderPhase.Idle
    this._scaffold = undefined
    this._mb = undefined
    this._history?.clear()
    this._history = undefined
    this._caseTypes = undefined
    this._statusMessage = ''
    this._selected = undefined
    this._newQuestionPath = undefined
    this._agentActive = false
    this._postBuildEdit = false
    this._mutationCount = 0
    this._progressCompleted = 0
    this._progressTotal = 0
    this._partialModules.clear()
    this._partialScaffold = undefined
    this._streamEnergy = 0
    this._thinkEnergy = 0
    this._editScope = null
    this.notify()
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Minimum zone width fraction for edit focus (matches signalGridController constant). */
const MIN_EDIT_ZONE = 0.15

/** Clamp an edit focus zone: enforce minimum width, don't wrap, stay in 0-1. */
function clampEditFocus(start: number, end: number): EditFocus {
  let width = end - start
  if (width < MIN_EDIT_ZONE) {
    const center = (start + end) / 2
    start = center - MIN_EDIT_ZONE / 2
    end = center + MIN_EDIT_ZONE / 2
    width = MIN_EDIT_ZONE
  }
  // Clamp to 0-1 without wrapping — shift the window instead
  if (start < 0) { end -= start; start = 0 }
  if (end > 1) { start -= (end - 1); end = 1 }
  return { start: Math.max(0, start), end: Math.min(1, end) }
}
