import type { BlueprintForm, Question, CaseType } from '@/lib/schemas/blueprint'
import { mergeFormQuestions } from '@/lib/schemas/blueprint'
import type { EvalContext } from '../xpath/types'
import { evaluate } from '../xpath/evaluator'
import { toBoolean } from '../xpath/coerce'
import { DataInstance } from './dataInstance'
import { TriggerDag } from './triggerDag'
import { resolveOutputTags, type ResolvedOutput } from './outputTag'
import type { QuestionState } from './types'

/**
 * Reactive form engine. Initializes from a BlueprintForm + case type metadata,
 * maintains a data instance, builds a trigger DAG, and cascades recalculation
 * on every value change.
 */
export class FormEngine {
  private instance: DataInstance
  private dag: TriggerDag
  private states = new Map<string, QuestionState>()
  private listeners = new Set<() => void>()
  private _version = 0
  private mergedQuestions: Question[]
  private caseData: Map<string, string>
  private moduleCaseType: string | undefined
  private formType: string
  /** Set as a side-effect by resolveHashtag when an unresolved #case/ ref is encountered. */
  private _lastCaseRef: string | undefined

  constructor(
    form: BlueprintForm,
    caseTypes?: CaseType[] | null,
    moduleCaseType?: string,
    caseData?: Map<string, string>,
  ) {
    this.moduleCaseType = moduleCaseType
    this.formType = form.type
    this.caseData = caseData ?? new Map()

    // 1. Merge data model defaults
    this.mergedQuestions = mergeFormQuestions(form.questions, caseTypes, moduleCaseType)

    // 2. Build data instance
    this.instance = new DataInstance()
    this.instance.initFromQuestions(this.mergedQuestions)

    // 3. Pre-populate case property values for followup forms
    if (form.type === 'followup' && this.caseData.size > 0) {
      this.preloadCaseData(this.mergedQuestions)
    }

    // 4. Build trigger DAG
    this.dag = new TriggerDag()
    this.dag.build(this.mergedQuestions)

    // 5. Initialize all question states
    this.initStates(this.mergedQuestions)

    // 6. Apply default_value expressions
    this.applyDefaults(this.mergedQuestions)

    // 7. Run full cascade — evaluate all expressions in topological order
    this.fullCascade()
  }

  /** Set a value and trigger recalculation cascade. */
  setValue(path: string, value: string): void {
    this.instance.set(path, value)

    // Update this question's own state
    const state = this.states.get(path)
    if (state) state.value = value

    // Get affected paths in topological order
    const affected = this.dag.getAffected(path)

    // Re-evaluate affected expressions
    for (const affectedPath of affected) {
      this.evaluateExpressions(affectedPath)
    }

    // Re-validate the changed question itself
    if (state) {
      if (state.touched) {
        // Field already shown to user — run full validation (required + constraint)
        this.validateField(path, state)
      } else {
        // Not yet touched — only track constraint validity internally
        this.evaluateConstraint(path, state)
      }
    }

    this.notify()
  }

  /** Add a new repeat instance. Returns the new index. */
  addRepeat(repeatPath: string): number {
    const newIndex = this.instance.addRepeatInstance(repeatPath)

    // Initialize states for new instance
    const templatePrefix = `${repeatPath}[0]/`
    for (const [key] of this.instance.entries()) {
      if (key.startsWith(`${repeatPath}[${newIndex}]/`)) {
        const suffix = key.slice(`${repeatPath}[${newIndex}]/`.length)
        const templatePath = templatePrefix + suffix
        const templateState = this.states.get(templatePath)
        this.states.set(key, {
          path: key,
          value: '',
          visible: templateState?.visible ?? true,
          required: templateState?.required ?? false,
          valid: true,
          touched: false,
        })
      }
    }

    this.notify()
    return newIndex
  }

  /** Remove a repeat instance. */
  removeRepeat(repeatPath: string, index: number): void {
    const count = this.instance.getRepeatCount(repeatPath)
    if (count <= 1) return

    // Remove states for this index
    const prefix = `${repeatPath}[${index}]/`
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(prefix)) this.states.delete(key)
    }

    // Renumber states for higher indices
    for (let i = index + 1; i < count; i++) {
      const oldPrefix = `${repeatPath}[${i}]/`
      const newPrefix = `${repeatPath}[${i - 1}]/`
      for (const [key, state] of [...this.states.entries()]) {
        if (key.startsWith(oldPrefix)) {
          const suffix = key.slice(oldPrefix.length)
          this.states.delete(key)
          state.path = newPrefix + suffix
          this.states.set(state.path, state)
        }
      }
    }

    this.instance.removeRepeatInstance(repeatPath, index)
    this.notify()
  }

  /** Get the repeat count for a repeat group path. */
  getRepeatCount(repeatPath: string): number {
    return this.instance.getRepeatCount(repeatPath)
  }

  /** Mark a field as touched (on blur). Runs constraint validation only — required is deferred to submit. */
  touch(path: string): void {
    const state = this.states.get(path)
    if (!state || state.touched) return

    state.touched = true
    this.evaluateConstraint(path, state)
    this.notify()
  }

  /**
   * Validate all visible fields. Marks every field as touched, runs required
   * checks and constraints. Returns true if the form is valid.
   */
  validateAll(): boolean {
    let valid = true
    for (const [path, state] of this.states) {
      if (!state.visible) continue
      state.touched = true
      this.validateField(path, state)
      if (!state.valid) valid = false
    }
    this.notify()
    return valid
  }

  /** Get the reactive state for a question path. */
  getState(path: string): QuestionState {
    return this.states.get(path) ?? {
      path,
      value: '',
      visible: true,
      required: false,
      valid: true,
      touched: false,
    }
  }

  /** Get the merged question tree (with data model defaults applied). */
  getQuestions(): Question[] {
    return this.mergedQuestions
  }

  /** Clear touched state and validation errors on all fields (for mode switches). */
  resetValidation(): void {
    for (const state of this.states.values()) {
      state.touched = false
      state.valid = true
      state.errorMessage = undefined
    }
    this.notify()
  }

  /** Get a snapshot of all values and touched state for persisting across engine recreations. */
  getValueSnapshot(): { values: Map<string, string>, touched: Set<string> } {
    const values = new Map<string, string>()
    const touched = new Set<string>()
    for (const [path, state] of this.states) {
      if (state.value) values.set(path, state.value)
      if (state.touched) touched.add(path)
    }
    return { values, touched }
  }

  /** Restore values and touched state from a snapshot, then re-evaluate all expressions. */
  restoreValues(snapshot: { values: Map<string, string>, touched: Set<string> }): void {
    for (const [path, value] of snapshot.values) {
      const state = this.states.get(path)
      if (state) {
        state.value = value
        this.instance.set(path, value)
      }
    }
    // Re-evaluate all expressions with restored values
    this.fullCascade()
    // Restore touched state and re-validate
    for (const path of snapshot.touched) {
      const state = this.states.get(path)
      if (state) {
        state.touched = true
        this.validateField(path, state)
      }
    }
    this.notify()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => this._version

  private notify(): void {
    this._version++
    this.listeners.forEach(fn => fn())
  }

  /** Pre-populate case property values into the data instance for followup forms. */
  private preloadCaseData(questions: Question[], prefix = '/data'): void {
    for (const q of questions) {
      const path = `${prefix}/${q.id}`
      if (q.case_property && this.caseData.has(q.case_property)) {
        this.instance.set(path, this.caseData.get(q.case_property)!)
      }
      if (q.children) {
        const childPrefix = q.type === 'repeat' ? `${path}[0]` : path
        this.preloadCaseData(q.children, childPrefix)
      }
    }
  }

  /** Initialize QuestionState for all questions. */
  private initStates(questions: Question[], prefix = '/data'): void {
    for (const q of questions) {
      const path = `${prefix}/${q.id}`

      if (q.type === 'group') {
        this.states.set(path, {
          path,
          value: '',
          visible: true,
          required: false,
          valid: true,
          touched: false,
        })
        if (q.children) this.initStates(q.children, path)
      } else if (q.type === 'repeat') {
        this.states.set(path, {
          path,
          value: '',
          visible: true,
          required: false,
          valid: true,
          touched: false,
        })
        if (q.children) this.initStates(q.children, `${path}[0]`)
      } else {
        const isRequired = q.required === 'true()'
        const state: QuestionState = {
          path,
          value: this.instance.get(path) ?? '',
          visible: true,
          required: isRequired,
          valid: true,
          touched: false,
        }
        // Mark followup form fields that read from case data when none is loaded
        if (this.formType === 'followup' && q.case_property && this.caseData.size === 0) {
          state.caseRef = q.case_property
        }
        this.states.set(path, state)
      }
    }
  }

  /** Apply default_value expressions (one-time on init). */
  private applyDefaults(questions: Question[], prefix = '/data'): void {
    for (const q of questions) {
      const path = `${prefix}/${q.id}`
      if (q.default_value && !this.instance.get(path)) {
        const ctx = this.createEvalContext(path)
        const result = evaluate(q.default_value, ctx)
        const value = String(result)
        if (value && value !== 'false') {
          this.instance.set(path, value)
          const state = this.states.get(path)
          if (state) state.value = value
        }
      }
      if (q.children) {
        const childPrefix = q.type === 'repeat' ? `${path}[0]` : path
        this.applyDefaults(q.children, childPrefix)
      }
    }
  }

  /** Evaluate all expressions for all paths in topological order. */
  private fullCascade(): void {
    const allPaths = this.dag.getAllPaths()
    for (const path of allPaths) {
      this.evaluateExpressions(path)
    }
  }

  /** Evaluate all registered expressions for a given path. */
  private evaluateExpressions(path: string): void {
    const expressions = this.dag.getExpressions(path)
    if (expressions.length === 0) return

    const state = this.states.get(path)
    if (!state) return

    const ctx = this.createEvalContext(path)

    for (const { type, expr } of expressions) {
      switch (type) {
        case 'calculate': {
          const result = evaluate(expr, ctx)
          const value = String(result)
          this.instance.set(path, value)
          state.value = value
          break
        }
        case 'relevant': {
          const result = evaluate(expr, ctx)
          state.visible = toBoolean(result)
          break
        }
        case 'required': {
          const result = evaluate(expr, ctx)
          state.required = toBoolean(result)
          break
        }
        case 'constraint': {
          this.evaluateConstraint(path, state)
          break
        }
        case 'output': {
          const q = this.findQuestion(path)
          if (q) {
            const resolve = (exprStr: string): ResolvedOutput => {
              this._lastCaseRef = undefined
              const result = String(evaluate(exprStr, ctx))
              // If resolveHashtag flagged an unresolved case ref, return a styled element
              if (this._lastCaseRef) {
                const ref = this._lastCaseRef
                this._lastCaseRef = undefined
                return { text: ref, className: 'case-ref' }
              }
              return result
            }
            state.resolvedLabel = q.label ? resolveOutputTags(q.label, resolve) : undefined
            state.resolvedHint = q.hint ? resolveOutputTags(q.hint, resolve) : undefined
          }
          break
        }
      }
    }
  }

  /** Validate a single field: required check + constraint check. */
  private validateField(path: string, state: QuestionState): void {
    // Required check
    if (state.required && !state.value) {
      state.valid = false
      state.errorMessage = 'This field is required'
      return
    }

    // Constraint check (only if has a value)
    this.evaluateConstraint(path, state)
  }

  /** Evaluate constraint for a question. */
  private evaluateConstraint(path: string, state: QuestionState): void {
    const expressions = this.dag.getExpressions(path)
    const constraintExpr = expressions.find(e => e.type === 'constraint')
    if (!constraintExpr || !state.value) {
      state.valid = true
      state.errorMessage = undefined
      return
    }

    const ctx = this.createEvalContext(path)
    const result = evaluate(constraintExpr.expr, ctx)
    state.valid = toBoolean(result)
    if (!state.valid) {
      // Find the constraint_msg from the question
      const q = this.findQuestion(path)
      state.errorMessage = q?.constraint_msg ?? 'Invalid value'
    } else {
      state.errorMessage = undefined
    }
  }

  /** Create an EvalContext for evaluating expressions at a given path. */
  private createEvalContext(path: string): EvalContext {
    // Extract repeat position from path like /data/repeat[2]/child
    let position = 1
    let size = 1
    const repeatMatch = path.match(/\[(\d+)\]/)
    if (repeatMatch) {
      position = parseInt(repeatMatch[1], 10) + 1 // 1-based
      const repeatBase = path.slice(0, path.indexOf('['))
      size = this.instance.getRepeatCount(repeatBase)
    }

    return {
      getValue: (p: string) => this.instance.get(p),
      resolveHashtag: (ref: string) => {
        if (ref.startsWith('#form/')) {
          const questionId = ref.slice(6)
          return this.instance.get(`/data/${questionId}`) ?? ''
        }
        if (ref.startsWith('#case/')) {
          const prop = ref.slice(6)
          const value = this.caseData.get(prop)
          if (value !== undefined) return value
          this._lastCaseRef = prop
          return ''
        }
        if (ref.startsWith('#user/')) {
          const prop = ref.slice(6)
          const userDefaults: Record<string, string> = {
            username: 'demo_user',
            first_name: 'Demo',
            last_name: 'User',
            phone_number: '+1234567890',
          }
          return userDefaults[prop] ?? `[user:${prop}]`
        }
        return ''
      },
      contextPath: path,
      position,
      size,
    }
  }

  /** Find a question by its path in the merged tree. */
  private findQuestion(path: string, questions?: Question[], prefix = '/data'): Question | undefined {
    for (const q of (questions ?? this.mergedQuestions)) {
      const qPath = `${prefix}/${q.id}`
      // Strip repeat indices for comparison
      const normalizedPath = path.replace(/\[\d+\]/g, '[0]')
      const normalizedQPath = qPath.replace(/\[\d+\]/g, '[0]')
      if (normalizedPath === normalizedQPath) return q
      if (q.children) {
        const childPrefix = q.type === 'repeat' ? `${qPath}[0]` : qPath
        const found = this.findQuestion(path, q.children, childPrefix)
        if (found) return found
      }
    }
    return undefined
  }
}
