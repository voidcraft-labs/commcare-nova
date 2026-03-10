import type { AppBlueprint, Scaffold, BlueprintForm } from '@/lib/schemas/blueprint'

export enum BuilderPhase {
  Idle = 'idle',
  Planning = 'planning',
  Designing = 'designing',
  Modules = 'modules',
  Forms = 'forms',
  Validating = 'validating',
  Fixing = 'fixing',
  Done = 'done',
  Editing = 'editing',
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
  blueprint: AppBlueprint | null = null
  statusMessage = ''
  selected: SelectedElement | null = null
  progressCompleted = 0
  progressTotal = 0
  private partialModules: Map<number, PartialModule> = new Map()
  /** Partial scaffold being built during tier 1 streaming */
  private partialScaffold: { appName?: string; description?: string; modules: TreeData['modules'] } | null = null
  private listeners = new Set<() => void>()

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify() {
    this.listeners.forEach(fn => fn())
  }

  /** Derive progress counts from the scaffold and partialModules state. */
  private updateProgress() {
    if (!this.scaffold) {
      this.progressCompleted = 0
      this.progressTotal = 0
      return
    }

    if (this.phase === BuilderPhase.Modules) {
      this.progressTotal = this.scaffold.modules.length
      this.progressCompleted = 0
      for (const [, partial] of this.partialModules) {
        if (partial.caseListColumns !== undefined) this.progressCompleted++
      }
    } else if (this.phase === BuilderPhase.Forms) {
      this.progressTotal = this.scaffold.modules.reduce((sum, m) => sum + m.forms.length, 0)
      this.progressCompleted = 0
      for (const [, partial] of this.partialModules) {
        this.progressCompleted += partial.forms.size
      }
    } else {
      this.progressCompleted = 0
      this.progressTotal = 0
    }
  }

  /** Transition to planning phase (Claude is generating the plan in chat). */
  startPlanning() {
    this.phase = BuilderPhase.Planning
    this.statusMessage = 'Generating plan...'
    this.notify()
  }

  /** Transition to designing phase (generation pipeline started). */
  startDesigning() {
    this.phase = BuilderPhase.Designing
    this.statusMessage = 'Designing app architecture...'
    this.partialScaffold = null
    this.partialModules.clear()
    this.notify()
  }

  /** Transition to editing phase (edit pipeline started). */
  startEditing() {
    this.phase = BuilderPhase.Editing
    this.statusMessage = 'Applying changes...'
    this.partialModules.clear()
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
    this.phase = BuilderPhase.Designing
    this.notify()
  }

  /** Store the completed scaffold for tree display. */
  setScaffold(scaffold: Scaffold) {
    this.scaffold = scaffold
    this.blueprint = null
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
      designing: BuilderPhase.Designing,
      editing: BuilderPhase.Editing,
      modules: BuilderPhase.Modules,
      forms: BuilderPhase.Forms,
      validating: BuilderPhase.Validating,
      fixing: BuilderPhase.Fixing,
    }
    const statusMap: Record<string, string> = {
      designing: 'Designing app architecture...',
      editing: 'Applying changes...',
      modules: 'Generating module content...',
      forms: 'Generating form content...',
      validating: 'Validating blueprint...',
      fixing: 'Fixing validation errors...',
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
    this.blueprint = result.blueprint
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
                return {
                  name: assembledForm.name,
                  type: assembledForm.type,
                  purpose: sf.purpose,
                  questions: assembledForm.questions,
                }
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
    this.blueprint = bp
    this.notify()
  }

  reset() {
    this.phase = BuilderPhase.Idle
    this.scaffold = null
    this.blueprint = null
    this.statusMessage = ''
    this.selected = null
    this.progressCompleted = 0
    this.progressTotal = 0
    this.partialModules.clear()
    this.partialScaffold = null
    this.notify()
  }
}
