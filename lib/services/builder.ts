import type { AppBlueprint, Scaffold, BlueprintForm, CaseType } from '@/lib/schemas/blueprint'
import { MutableBlueprint } from './mutableBlueprint'
import { HistoryManager } from './historyManager'

/** Apply a data part to a builder — shared between real-time streaming (onData) and replay. */
export function applyDataPart(builder: Builder, type: string, data: any): void {
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
    case 'data-error': builder.setError(data.message); break
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

export interface SelectedElement {
  type: 'module' | 'form' | 'question'
  moduleIndex: number
  formIndex?: number
  questionPath?: string
}

/** Common shape for AppTree rendering — satisfied by both Scaffold and AppBlueprint */
export interface TreeData {
  app_name: string
  modules: Array<{
    name: string
    case_type?: string | null
    purpose?: string
    forms: Array<{
      name: string
      type: string
      purpose?: string
      questions?: Array<any>
    }>
    case_list_columns?: Array<{ field: string; header: string }> | null
    case_detail_columns?: Array<{ field: string; header: string }> | null
  }>
}

/** Partial module data being built during streaming generation */
interface PartialModule {
  caseListColumns?: Array<{ field: string; header: string }> | null
  forms: Map<number, any> // formIndex → assembled BlueprintForm
}

export class Builder {
  phase = BuilderPhase.Idle
  scaffold: Scaffold | null = null
  private _mb: MutableBlueprint | null = null
  private history: HistoryManager | null = null
  caseTypes: CaseType[] | null = null
  statusMessage = ''
  selected: SelectedElement | null = null
  /** When true, DetailPanel should auto-focus the label field on mount. Cleared after read. */
  autoFocusLabel = false
  mutationCount = 0
  progressCompleted = 0
  progressTotal = 0
  private partialModules: Map<number, PartialModule> = new Map()
  /** Partial scaffold being built during streaming */
  private partialScaffold: { appName?: string; description?: string; modules: TreeData['modules'] } | null = null
  private listeners = new Set<() => void>()

  /** The current blueprint as plain data, or null. */
  get blueprint(): AppBlueprint | null {
    return this._mb?.getBlueprint() ?? null
  }

  /** The persistent MutableBlueprint instance for direct mutation.
   *  Returns the Proxy-wrapped version when history is active. */
  get mb(): MutableBlueprint | null {
    return this.history?.proxied ?? this._mb
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify() {
    this.listeners.forEach(fn => fn())
  }

  /** Derive progress counts from the scaffold and partialModules state. */
  private updateProgress() {
    if (!this.scaffold || (this.phase !== BuilderPhase.Modules && this.phase !== BuilderPhase.Forms)) {
      this.progressCompleted = 0
      this.progressTotal = 0
      return
    }

    // Total = modules + all forms across modules
    this.progressTotal = this.scaffold.modules.length +
      this.scaffold.modules.reduce((sum, m) => sum + m.forms.length, 0)

    // Completed = modules with columns + forms with content
    this.progressCompleted = 0
    for (const [, partial] of this.partialModules) {
      if (partial.caseListColumns !== undefined) this.progressCompleted++
      this.progressCompleted += partial.forms.size
    }
  }

  // ── Undo/Redo ──────────────────────────────────────────────────────

  undo() {
    const newMb = this.history?.undo()
    if (!newMb) return
    this._mb = newMb
    this.selected = null
    this.mutationCount++
    this.notify()
  }

  redo() {
    const newMb = this.history?.redo()
    if (!newMb) return
    this._mb = newMb
    this.selected = null
    this.mutationCount++
    this.notify()
  }

  get canUndo(): boolean {
    return this.history?.canUndo ?? false
  }

  get canRedo(): boolean {
    return this.history?.canRedo ?? false
  }

  /** Transition to data model phase (SA called generateSchema). */
  startDataModel() {
    if (this.history) this.history.enabled = false
    this.phase = BuilderPhase.DataModel
    this.statusMessage = 'Designing data model...'
    this.notify()
  }

  /** Store case types from data model generation. */
  setSchema(caseTypes: CaseType[]) {
    this.caseTypes = caseTypes
    this.notify()
  }

  /** Update partial scaffold from streaming tool call args. */
  setPartialScaffold(partial: any) {
    if (!partial?.modules?.length) return
    this.partialScaffold = {
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
    this.phase = BuilderPhase.Structure
    this.statusMessage = 'Designing app structure...'
    this.notify()
  }

  /** Store the completed scaffold for tree display. */
  setScaffold(scaffold: Scaffold) {
    this.scaffold = scaffold
    this._mb = null
    this.partialScaffold = null
    this.notify()
  }

  /** Update module content (case list columns). */
  setModuleContent(moduleIndex: number, caseListColumns: Array<{ field: string; header: string }> | null) {
    let partial = this.partialModules.get(moduleIndex)
    if (!partial) {
      partial = { forms: new Map() }
      this.partialModules.set(moduleIndex, partial)
    }
    partial.caseListColumns = caseListColumns
    this.updateProgress()
    this.notify()
  }

  /** Update form content (assembled form with questions). */
  setFormContent(moduleIndex: number, formIndex: number, form: BlueprintForm) {
    let partial = this.partialModules.get(moduleIndex)
    if (!partial) {
      partial = { forms: new Map() }
      this.partialModules.set(moduleIndex, partial)
    }
    partial.forms.set(formIndex, form)
    this.updateProgress()
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
    const statusMap: Record<string, string> = {
      structure: 'Designing app structure...',
      modules: 'Building app content...',
      forms: 'Building app content...',
      validate: 'Validating blueprint...',
      fix: 'Fixing validation errors...',
    }
    const newPhase = phaseMap[phase]
    if (!newPhase) return
    this.phase = newPhase
    this.statusMessage = statusMap[phase] ?? this.statusMessage
    this.updateProgress()
    this.notify()
  }

  /** Update status message for fix attempt progress. */
  setFixAttempt(attempt: number, errorCount: number) {
    this.statusMessage = `Fixing ${errorCount} error${errorCount !== 1 ? 's' : ''} (attempt ${attempt})...`
    this.notify()
  }

  /** Set the completed blueprint after validation. */
  setDone(result: { blueprint: AppBlueprint; hqJson: Record<string, any>; success: boolean }) {
    this._mb = new MutableBlueprint(result.blueprint)
    this.history = new HistoryManager(this._mb)
    this.partialModules.clear()
    this.phase = BuilderPhase.Done
    this.statusMessage = ''
    this.progressCompleted = 0
    this.progressTotal = 0
    this.notify()
  }

  /** Set error state with a message. */
  setError(message: string) {
    this.phase = BuilderPhase.Error
    this.statusMessage = message
    this.partialModules.clear()
    this.notify()
  }

  /** Provides a common shape for AppTree — uses blueprint if available, otherwise merges partials with scaffold, otherwise scaffold. */
  get treeData(): TreeData | null {
    if (this.blueprint) return this.blueprint

    if (this.scaffold && this.partialModules.size > 0) {
      // Overlay partial data on top of the scaffold
      return {
        app_name: this.scaffold.app_name,
        modules: this.scaffold.modules.map((sm, mIdx) => {
          const partial = this.partialModules.get(mIdx)
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

    if (this.scaffold) return this.scaffold

    if (this.partialScaffold && this.partialScaffold.modules.length > 0) {
      return {
        app_name: this.partialScaffold.appName ?? 'Generating...',
        modules: this.partialScaffold.modules,
      }
    }

    return null
  }

  select(el: SelectedElement | null) {
    this.selected = el
    this.notify()
  }

  updateBlueprint(bp: AppBlueprint) {
    this._mb = new MutableBlueprint(bp)
    this.notify()
  }

  /** Notify subscribers that the blueprint was mutated in-place via mb. */
  notifyBlueprintChanged = () => {
    this.mutationCount++
    this.notify()
  }

  reset() {
    this.phase = BuilderPhase.Idle
    this.scaffold = null
    this._mb = null
    this.history?.clear()
    this.history = null
    this.caseTypes = null
    this.statusMessage = ''
    this.selected = null
    this.autoFocusLabel = false
    this.mutationCount = 0
    this.progressCompleted = 0
    this.progressTotal = 0
    this.partialModules.clear()
    this.partialScaffold = null
    this.notify()
  }
}
