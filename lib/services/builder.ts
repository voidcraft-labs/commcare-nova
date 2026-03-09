import type { AppBlueprint } from '@/lib/schemas/blueprint'
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

export class Builder {
  phase = BuilderPhase.Idle
  blueprint: AppBlueprint | null = null
  statusMessage = ''
  selected: SelectedElement | null = null
  private listeners = new Set<() => void>()
  private _conversation = ''
  private _appName = ''

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

  /** Show the scaffold blueprint in the tree. Stores context for /api/blueprint/fill. */
  setScaffold(bp: AppBlueprint, conversation: string, appName: string) {
    this.blueprint = bp
    this._conversation = conversation
    this._appName = appName
    this.phase = BuilderPhase.Scaffolding
    this.statusMessage = ''
    this.notify()
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
          conversation: this._conversation,
          appName: this._appName,
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
    this.blueprint = null
    this.statusMessage = ''
    this.selected = null
    this._conversation = ''
    this._appName = ''
    this.notify()
  }
}
