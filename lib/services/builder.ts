import type { AppBlueprint, Scaffold } from '@/lib/schemas/blueprint'
import type { FillStreamEvent, ScaffoldStreamEvent } from '@/lib/types'
import { logUsage } from '@/lib/usage'
import type { ClaudeUsage } from '@/lib/usage'

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
    this.partialScaffold = null
    this.phase = BuilderPhase.Scaffolding
    this.statusMessage = ''
    this.notify()
  }

  /** Stream the scaffold (tier 1) via NDJSON from /api/blueprint/scaffold. */
  async streamScaffold(apiKey: string, appName: string, appSpecification: string) {
    this.phase = BuilderPhase.Planning
    this.statusMessage = 'Generating blueprint structure...'
    this.partialScaffold = { modules: [] }
    this.notify()

    try {
      const res = await fetch('/api/blueprint/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, appName, appSpecification }),
      })

      if (!res.ok) {
        const errorData = await res.json().catch(() => null)
        this.phase = BuilderPhase.Error
        this.statusMessage = errorData?.error || `HTTP ${res.status}`
        this.partialScaffold = null
        this.notify()
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let receivedDone = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          if (!line.trim()) continue
          let event: ScaffoldStreamEvent
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }

          switch (event.type) {
            case 'scaffold_meta':
              this.partialScaffold = {
                ...this.partialScaffold!,
                appName: event.appName,
                description: event.description,
              }
              this.notify()
              break

            case 'scaffold_module':
              this.partialScaffold!.modules.push({
                name: event.module.name,
                case_type: event.module.case_type,
                purpose: event.module.purpose,
                forms: event.module.forms.map(f => ({
                  name: f.name,
                  type: f.type,
                  purpose: f.purpose,
                })),
              })
              this.notify()
              break

            case 'scaffold_done':
              if (event.usage) logUsage('Scaffold', event.usage)
              this.scaffold = event.scaffold
              this.partialScaffold = null
              this.phase = BuilderPhase.Scaffolding
              this.statusMessage = ''
              receivedDone = true
              this.notify()
              break

            case 'error':
              this.phase = BuilderPhase.Error
              this.statusMessage = event.message
              this.partialScaffold = null
              receivedDone = true
              this.notify()
              break
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event: ScaffoldStreamEvent = JSON.parse(buffer)
          if (event.type === 'scaffold_done') {
            if (event.usage) logUsage('Scaffold', event.usage)
            this.scaffold = event.scaffold
            this.partialScaffold = null
            this.phase = BuilderPhase.Scaffolding
            this.statusMessage = ''
            receivedDone = true
            this.notify()
          } else if (event.type === 'error') {
            this.phase = BuilderPhase.Error
            this.statusMessage = event.message
            this.partialScaffold = null
            receivedDone = true
            this.notify()
          }
        } catch {
          // ignore
        }
      }

      if (!receivedDone) {
        this.phase = BuilderPhase.Error
        this.statusMessage = 'Scaffold stream ended unexpectedly'
        this.partialScaffold = null
        this.notify()
      }
    } catch (err) {
      this.phase = BuilderPhase.Error
      this.statusMessage = err instanceof Error ? err.message : 'Scaffold failed'
      this.partialScaffold = null
      this.notify()
    }
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

  /** Fill the blueprint (tiers 2+3 via /api/blueprint/fill) with NDJSON streaming. */
  async fillBlueprint(apiKey: string) {
    this.phase = BuilderPhase.Modules
    this.statusMessage = 'Generating...'
    this.progressCompleted = 0
    this.progressTotal = 0
    this.partialModules.clear()
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

      if (!res.ok) {
        const errorData = await res.json().catch(() => null)
        this.phase = BuilderPhase.Error
        this.statusMessage = errorData?.error || `HTTP ${res.status}`
        this.partialModules.clear()
        this.notify()
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const allUsage: ClaudeUsage[] = []
      let receivedTerminal = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last incomplete line in the buffer
        buffer = lines.pop()!

        for (const line of lines) {
          if (!line.trim()) continue

          let event: FillStreamEvent
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }

          if (event.type === 'done' || event.type === 'error') {
            receivedTerminal = true
          }
          this.handleStreamEvent(event, allUsage)
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event: FillStreamEvent = JSON.parse(buffer)
          if (event.type === 'done' || event.type === 'error') {
            receivedTerminal = true
          }
          this.handleStreamEvent(event, allUsage)
        } catch {
          // ignore incomplete final line
        }
      }

      // If we never got a terminal event, something went wrong
      if (!receivedTerminal) {
        this.phase = BuilderPhase.Error
        this.statusMessage = 'Stream ended unexpectedly'
        this.partialModules.clear()
        this.notify()
      }
    } catch (err) {
      this.phase = BuilderPhase.Error
      this.statusMessage = err instanceof Error ? err.message : 'Failed'
      this.partialModules.clear()
      this.notify()
    }
  }

  private handleStreamEvent(event: FillStreamEvent, allUsage: ClaudeUsage[]) {
    switch (event.type) {
      case 'phase': {
        const phaseMap: Record<string, BuilderPhase> = {
          modules: BuilderPhase.Modules,
          forms: BuilderPhase.Forms,
          validating: BuilderPhase.Validating,
          fixing: BuilderPhase.Fixing,
        }
        this.phase = phaseMap[event.phase] ?? this.phase
        this.notify()
        break
      }

      case 'progress':
        this.statusMessage = event.message
        this.progressCompleted = event.completed
        this.progressTotal = event.total
        this.notify()
        break

      case 'module_done': {
        let partial = this.partialModules.get(event.moduleIndex)
        if (!partial) {
          partial = { forms: new Map() }
          this.partialModules.set(event.moduleIndex, partial)
        }
        partial.caseListColumns = event.caseListColumns
        this.notify()
        break
      }

      case 'form_done': {
        let partial = this.partialModules.get(event.moduleIndex)
        if (!partial) {
          partial = { forms: new Map() }
          this.partialModules.set(event.moduleIndex, partial)
        }
        partial.forms.set(event.formIndex, event.form)
        this.notify()
        break
      }

      case 'fix_attempt':
        this.statusMessage = `Fixing ${event.errorCount} error${event.errorCount !== 1 ? 's' : ''} (attempt ${event.attempt})...`
        this.notify()
        break

      case 'usage':
        allUsage.push(event.usage)
        break

      case 'done':
        this.blueprint = event.blueprint
        this.partialModules.clear()
        this.phase = BuilderPhase.Done
        this.statusMessage = ''
        this.progressCompleted = 0
        this.progressTotal = 0
        logUsage('Blueprint Fill', event.usage)
        this.notify()
        break

      case 'error':
        this.phase = BuilderPhase.Error
        this.statusMessage = event.message
        this.partialModules.clear()
        this.notify()
        break
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
    this.progressCompleted = 0
    this.progressTotal = 0
    this.partialModules.clear()
    this.partialScaffold = null
    this.notify()
  }
}
