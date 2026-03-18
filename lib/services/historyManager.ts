import type { AppBlueprint } from '@/lib/schemas/blueprint'
import { type QuestionPath, qpath, qpathParent } from './questionPath'
import { MutableBlueprint } from './mutableBlueprint'

/** Method names that mutate blueprint state and should create undo snapshots. */
const MUTATION_METHODS = new Set([
  'updateQuestion', 'addQuestion', 'removeQuestion', 'moveQuestion', 'duplicateQuestion',
  'updateModule', 'updateForm', 'replaceForm', 'addForm', 'removeForm',
  'addModule', 'removeModule', 'renameQuestion', 'renameCaseProperty',
  'updateCaseProperty', 'addChildCase',
])

export type MutationType = 'add' | 'remove' | 'move' | 'duplicate' | 'update' | 'rename' | 'structural'

export interface SnapshotMeta {
  type: MutationType
  moduleIndex: number
  formIndex: number
  questionPath?: QuestionPath
  secondaryPath?: QuestionPath
}

interface SnapshotEntry {
  blueprint: AppBlueprint
  meta: SnapshotMeta
}

/** Maps a proxy-intercepted method call to SnapshotMeta. */
function deriveMeta(method: string, args: any[]): SnapshotMeta {
  const moduleIndex = typeof args[0] === 'number' ? args[0] : -1
  const formIndex = typeof args[1] === 'number' ? args[1] : -1

  switch (method) {
    case 'addQuestion':
      return { type: 'add', moduleIndex, formIndex, questionPath: qpath(args[2]?.id, args[3]?.parentPath) }
    case 'removeQuestion':
      return { type: 'remove', moduleIndex, formIndex, questionPath: args[2] }
    case 'moveQuestion':
      return { type: 'move', moduleIndex, formIndex, questionPath: args[2] }
    case 'duplicateQuestion':
      // secondaryPath patched after execution with the clone's path
      return { type: 'duplicate', moduleIndex, formIndex, questionPath: args[2] }
    case 'updateQuestion':
      return { type: 'update', moduleIndex, formIndex, questionPath: args[2] }
    case 'renameQuestion':
      return { type: 'rename', moduleIndex, formIndex, questionPath: args[2], secondaryPath: qpath(args[3], qpathParent(args[2])) }
    default:
      return { type: 'structural', moduleIndex, formIndex }
  }
}

export class HistoryManager {
  private undoStack: SnapshotEntry[] = []
  private redoStack: SnapshotEntry[] = []
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
        const value = Reflect.get(this._mb, prop, this._mb)
        if (typeof prop === 'string' && MUTATION_METHODS.has(prop) && typeof value === 'function') {
          return (...args: any[]) => {
            const meta = deriveMeta(prop, args)
            this.snapshot(meta)
            const result = value.apply(this._mb, args)
            // Patch duplicate clone ID after execution
            if (prop === 'duplicateQuestion' && typeof result === 'string' && this.undoStack.length > 0) {
              this.undoStack[this.undoStack.length - 1].meta.secondaryPath = result as QuestionPath
            }
            return result
          }
        }
        if (typeof value === 'function') {
          return value.bind(this._mb)
        }
        return value
      },
    })
  }

  private snapshot(meta: SnapshotMeta) {
    if (!this.enabled) return
    this.undoStack.push({ blueprint: structuredClone(this._mb.getBlueprint()), meta })
    this.redoStack = []
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift()
    }
  }

  /** Undo: returns the new MutableBlueprint + meta, or undefined if nothing to undo. */
  undo(): { mb: MutableBlueprint; meta: SnapshotMeta } | undefined {
    if (this.undoStack.length === 0) return undefined
    const entry = this.undoStack.pop()!
    this.redoStack.push({ blueprint: structuredClone(this._mb.getBlueprint()), meta: entry.meta })
    this._mb = new MutableBlueprint(entry.blueprint)
    return { mb: this._mb, meta: entry.meta }
  }

  /** Redo: returns the new MutableBlueprint + meta, or undefined if nothing to redo. */
  redo(): { mb: MutableBlueprint; meta: SnapshotMeta } | undefined {
    if (this.redoStack.length === 0) return undefined
    const entry = this.redoStack.pop()!
    this.undoStack.push({ blueprint: structuredClone(this._mb.getBlueprint()), meta: entry.meta })
    this._mb = new MutableBlueprint(entry.blueprint)
    return { mb: this._mb, meta: entry.meta }
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
