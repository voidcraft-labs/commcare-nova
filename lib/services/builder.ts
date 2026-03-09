import type { AppBlueprint, Scaffold } from '@/lib/schemas/blueprint'
import { logUsage } from '@/lib/usage'

export enum BuilderPhase {
  Idle = 'idle',
  Planning = 'planning',
  Scaffolding = 'scaffolding',
  Modules = 'modules',
  Forms = 'forms',
  Validating = 'validating',
  Fixing = 'fixing',
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
  }>
}

export class Builder {
  phase = BuilderPhase.Idle
  scaffold: Scaffold | null = null
  blueprint: AppBlueprint | null = null
  statusMessage = ''
  selected: SelectedElement | null = null
  private listeners = new Set<() => void>()

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify() {
    this.listeners.forEach(fn => fn())
  }

  /** Transition to planning phase (Claude is generating the plan). */
  startPlanning() {
    this.phase = BuilderPhase.Planning
    this.statusMessage = 'Generating plan...'
    this.notify()
  }

  /** Update planning message when scaffold API call begins. */
  startScaffolding() {
    this.statusMessage = 'Generating blueprint structure...'
    this.notify()
  }

  /** Store the raw scaffold for tree display. Blueprint is set later after fill. */
  setScaffold(scaffold: Scaffold) {
    this.scaffold = scaffold
    this.blueprint = null
    this.phase = BuilderPhase.Scaffolding
    this.statusMessage = ''
    this.notify()
  }

  /** Provides a common shape for AppTree — uses blueprint if available, otherwise scaffold. */
  get treeData(): TreeData | null {
    if (this.blueprint) return this.blueprint
    if (this.scaffold) return this.scaffold
    return null
  }

  /** Fill the blueprint (tiers 2+3 via /api/blueprint/fill). Called after scaffold is visible. */
  async fillBlueprint(apiKey: string) {
    this.phase = BuilderPhase.Modules
    this.statusMessage = 'Generating...'
    this.notify()

    try {
      const res = await fetch('/api/blueprint/fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          scaffold: this.scaffold,
        }),
      })
      const result = await res.json()

      if (!res.ok || !result.success) {
        this.phase = BuilderPhase.Error
        this.statusMessage = result.errors?.[0] || 'Generation failed'
        this.notify()
        return
      }

      if (result.usage) {
        logUsage('Blueprint Fill', result.usage)
      }
      this.blueprint = result.blueprint
      this.phase = BuilderPhase.Done
      this.statusMessage = ''
      this.notify()
    } catch (err) {
      this.phase = BuilderPhase.Error
      this.statusMessage = err instanceof Error ? err.message : 'Failed'
      this.notify()
    }
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
    this.notify()
  }
}
