import type { AppBlueprint } from '@/lib/schemas/blueprint'
import { MutableBlueprint } from './mutableBlueprint'

/** Method names that mutate blueprint state and should create undo snapshots. */
const MUTATION_METHODS = new Set([
  'updateQuestion', 'addQuestion', 'removeQuestion', 'moveQuestion', 'duplicateQuestion',
  'updateModule', 'updateForm', 'replaceForm', 'addForm', 'removeForm',
  'addModule', 'removeModule', 'renameQuestion', 'renameCaseProperty',
  'updateCaseProperty', 'addChildCase',
])

export class HistoryManager {
  private undoStack: AppBlueprint[] = []
  private redoStack: AppBlueprint[] = []
  private maxDepth: number
  enabled = true

  /** Current MutableBlueprint — can be swapped on undo/redo. */
  private _mb: MutableBlueprint

  /** The Proxy-wrapped MutableBlueprint — use this instead of the raw instance. */
  readonly proxied: MutableBlueprint

  constructor(mb: MutableBlueprint, maxDepth = 50) {
    this._mb = mb
    this.maxDepth = maxDepth
    // Proxy delegates to this._mb, which can be swapped
    this.proxied = new Proxy({} as MutableBlueprint, {
      get: (_target, prop, _receiver) => {
        const value = (this._mb as any)[prop]
        if (typeof prop === 'string' && MUTATION_METHODS.has(prop) && typeof value === 'function') {
          return (...args: any[]) => {
            this.snapshot()
            return value.apply(this._mb, args)
          }
        }
        if (typeof value === 'function') {
          return value.bind(this._mb)
        }
        return value
      },
    })
  }

  private snapshot() {
    if (!this.enabled) return
    this.undoStack.push(structuredClone(this._mb.getBlueprint()))
    this.redoStack = []
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift()
    }
  }

  /** Undo: returns the new MutableBlueprint, or null if nothing to undo. */
  undo(): MutableBlueprint | null {
    if (this.undoStack.length === 0) return null
    this.redoStack.push(structuredClone(this._mb.getBlueprint()))
    const restored = this.undoStack.pop()!
    this._mb = new MutableBlueprint(restored)
    return this._mb
  }

  /** Redo: returns the new MutableBlueprint, or null if nothing to redo. */
  redo(): MutableBlueprint | null {
    if (this.redoStack.length === 0) return null
    this.undoStack.push(structuredClone(this._mb.getBlueprint()))
    const restored = this.redoStack.pop()!
    this._mb = new MutableBlueprint(restored)
    return this._mb
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  clear() {
    this.undoStack = []
    this.redoStack = []
  }
}
