/**
 * MutableBlueprint — wraps an AppBlueprint for in-place search, read, and mutation.
 *
 * Used by the Solutions Architect agent as the single state container throughout
 * the entire lifecycle: progressive population during generation and surgical
 * edits during editing.
 */
import {
  type AppBlueprint, type BlueprintModule, type BlueprintForm, type Question,
  type BlueprintChildCase, type CaseType, type CaseProperty,
} from '../schemas/blueprint'
import { rewriteXPathRefs, rewriteHashtagRefs } from '../preview/xpath/rewrite'
import { rewriteOutputTags } from '../preview/engine/outputTag'
import { type QuestionPath, qpath, qpathId, qpathParent } from './questionPath'

// ── Result types ────────────────────────────────────────────────────────

export interface SearchResult {
  type: 'module' | 'form' | 'question' | 'case_list_column'
  moduleIndex: number
  formIndex?: number
  questionPath?: QuestionPath
  field: string     // which field matched (e.g. 'label', 'case_property', 'id', 'name')
  value: string     // the matched value
  context: string   // human-readable location string
}

export interface RenameResult {
  formsChanged: string[]    // ["m0-f0", "m0-f1"]
  columnsChanged: string[]  // ["m0"]
}

export interface QuestionRenameResult {
  newPath: QuestionPath
  xpathFieldsRewritten: number
}

// ── QuestionUpdate type ─────────────────────────────────────────────────

export interface QuestionUpdate {
  type: Question['type']
  label: string | null
  hint: string | null
  help: string | null
  required: string | null
  validation: string | null
  validation_msg: string | null
  relevant: string | null
  calculate: string | null
  default_value: string | null
  options: Array<{ value: string; label: string }> | null
  is_case_property: boolean | null
}

// ── NewQuestion type ────────────────────────────────────────────────────

export interface NewQuestion {
  id: string
  type: Question['type']
  label?: string
  hint?: string
  help?: string
  required?: string
  validation?: string
  validation_msg?: string
  relevant?: string
  calculate?: string
  default_value?: string
  options?: Array<{ value: string; label: string }>
  is_case_property?: boolean
  children?: NewQuestion[]
}

// ── MutableBlueprint ────────────────────────────────────────────────────

export class MutableBlueprint {
  private blueprint: AppBlueprint

  constructor(blueprint: AppBlueprint) {
    this.blueprint = structuredClone(blueprint)
  }

  /** Create from an already-isolated blueprint, skipping the defensive clone.
   *  Caller MUST guarantee no other reference to `blueprint` is retained. */
  static fromOwned(blueprint: AppBlueprint): MutableBlueprint {
    const mb = Object.create(MutableBlueprint.prototype) as MutableBlueprint
    mb.blueprint = blueprint
    return mb
  }

  // ── Progressive population (used by generation tools) ──────────────

  /** Set the data model (case types). Used by generateSchema. */
  setCaseTypes(caseTypes: CaseType[]): void {
    this.blueprint.case_types = caseTypes
  }

  /** Set app structure from scaffold output. Preserves case_types. */
  setScaffold(scaffold: { app_name: string; description?: string; modules: Array<{ name: string; case_type?: string | null; purpose?: string; forms: Array<{ name: string; type: string; purpose?: string; formDesign?: string }> }> }): void {
    this.blueprint.app_name = scaffold.app_name
    this.blueprint.modules = scaffold.modules.map(sm => ({
      name: sm.name,
      ...(sm.case_type != null && { case_type: sm.case_type }),
      forms: sm.forms.map(sf => ({
        name: sf.name,
        type: sf.type as 'registration' | 'followup' | 'survey',
        questions: [],
      })),
    }))
  }

  // ── Read ────────────────────────────────────────────────────────────

  getBlueprint(): AppBlueprint {
    return this.blueprint
  }

  getModule(mIdx: number): BlueprintModule | undefined {
    return this.blueprint.modules[mIdx]
  }

  getForm(mIdx: number, fIdx: number): BlueprintForm | undefined {
    return this.blueprint.modules[mIdx]?.forms[fIdx]
  }

  getQuestion(mIdx: number, fIdx: number, questionPath: QuestionPath): Question | undefined {
    const form = this.getForm(mIdx, fIdx)
    if (!form) return undefined
    return this.findByPath(form.questions, questionPath)?.question
  }

  getCaseType(name: string): CaseType | undefined {
    return this.blueprint.case_types?.find(ct => ct.name === name)
  }

  getCaseProperty(caseTypeName: string, propertyName: string): CaseProperty | undefined {
    const ct = this.getCaseType(caseTypeName)
    return ct?.properties.find(p => p.name === propertyName)
  }

  updateCaseProperty(caseTypeName: string, propertyName: string, updates: Partial<Omit<CaseProperty, 'name'>>): void {
    const ct = this.blueprint.case_types?.find(c => c.name === caseTypeName)
    if (!ct) throw new Error(`Case type "${caseTypeName}" not found`)
    const prop = ct.properties.find(p => p.name === propertyName)
    if (!prop) throw new Error(`Property "${propertyName}" not found on case type "${caseTypeName}"`)
    Object.assign(prop, updates)
  }

  /** Resolve a bare question ID to its full QuestionPath via recursive search. For SA tool boundary. */
  resolveQuestionId(mIdx: number, fIdx: number, bareId: string): QuestionPath | undefined {
    const form = this.getForm(mIdx, fIdx)
    if (!form) return undefined
    return this.findQuestionPath(form.questions, bareId, undefined)
  }

  // ── Search ──────────────────────────────────────────────────────────

  search(query: string): SearchResult[] {
    const results: SearchResult[] = []
    const q = query.toLowerCase()

    for (let mIdx = 0; mIdx < this.blueprint.modules.length; mIdx++) {
      const mod = this.blueprint.modules[mIdx]

      // Module name
      if (mod.name.toLowerCase().includes(q)) {
        results.push({ type: 'module', moduleIndex: mIdx, field: 'name', value: mod.name, context: `Module ${mIdx} "${mod.name}"` })
      }
      // Case type
      if (mod.case_type?.toLowerCase().includes(q)) {
        results.push({ type: 'module', moduleIndex: mIdx, field: 'case_type', value: mod.case_type, context: `Module ${mIdx} "${mod.name}" case_type` })
      }
      // Case list columns
      const allColumns = [...(mod.case_list_columns || []), ...(mod.case_detail_columns || [])]
      for (const col of allColumns) {
        if (col.field.toLowerCase().includes(q) || col.header.toLowerCase().includes(q)) {
          results.push({ type: 'case_list_column', moduleIndex: mIdx, field: 'column', value: `${col.field} (${col.header})`, context: `Module ${mIdx} "${mod.name}" column "${col.header}"` })
        }
      }

      // Forms
      for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
        const form = mod.forms[fIdx]

        // Form name
        if (form.name.toLowerCase().includes(q)) {
          results.push({ type: 'form', moduleIndex: mIdx, formIndex: fIdx, field: 'name', value: form.name, context: `m${mIdx}-f${fIdx} "${form.name}" (${form.type})` })
        }

        // Questions (recursive)
        this.searchQuestions(form.questions, q, mIdx, fIdx, results, undefined)
      }
    }

    return results
  }

  private searchQuestions(questions: Question[], query: string, mIdx: number, fIdx: number, results: SearchResult[], parent: QuestionPath | undefined): void {
    for (const q of questions) {
      const questionPath = qpath(q.id, parent)
      const formRef = `m${mIdx}-f${fIdx}`
      const matchFields: Array<{ field: string; value: string }> = []

      if (q.id.toLowerCase().includes(query)) matchFields.push({ field: 'id', value: q.id })
      if (q.label && q.label.toLowerCase().includes(query)) matchFields.push({ field: 'label', value: q.label })
      if (q.is_case_property && q.id.toLowerCase().includes(query)) matchFields.push({ field: 'case_property', value: q.id })
      if (q.validation?.toLowerCase().includes(query)) matchFields.push({ field: 'validation', value: q.validation })
      if (q.relevant?.toLowerCase().includes(query)) matchFields.push({ field: 'relevant', value: q.relevant })
      if (q.calculate?.toLowerCase().includes(query)) matchFields.push({ field: 'calculate', value: q.calculate })
      if (q.default_value?.toLowerCase().includes(query)) matchFields.push({ field: 'default_value', value: q.default_value })
      if (q.validation_msg && q.validation_msg.toLowerCase().includes(query)) matchFields.push({ field: 'validation_msg', value: q.validation_msg })
      if (q.hint && q.hint.toLowerCase().includes(query)) matchFields.push({ field: 'hint', value: q.hint })
      if (q.help && q.help.toLowerCase().includes(query)) matchFields.push({ field: 'help', value: q.help })

      // Search options
      if (q.options && q.options.length > 0) {
        for (const opt of q.options) {
          if (opt.value.toLowerCase().includes(query) || opt.label.toLowerCase().includes(query)) {
            matchFields.push({ field: 'option', value: `${opt.value}: ${opt.label}` })
            break // one match per question is enough for options
          }
        }
      }

      for (const match of matchFields) {
        results.push({
          type: 'question',
          moduleIndex: mIdx,
          formIndex: fIdx,
          questionPath,
          field: match.field,
          value: match.value,
          context: `${formRef} question "${q.id}" (${q.type}${q.is_case_property ? ', case_property' : ''})`,
        })
      }

      if (q.children) {
        this.searchQuestions(q.children, query, mIdx, fIdx, results, questionPath)
      }
    }
  }

  // ── Question mutations ──────────────────────────────────────────────

  updateQuestion(mIdx: number, fIdx: number, questionPath: QuestionPath, updates: Partial<QuestionUpdate>): Question {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const found = this.findByPath(form.questions, questionPath)
    if (!found) throw new Error(`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`)

    const question = found.question

    // Apply updates — null deletes the field, value sets it
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue
      if (value === null) {
        delete (question as any)[key]
      } else {
        ;(question as any)[key] = value
      }
    }

    return question
  }

  addQuestion(mIdx: number, fIdx: number, question: NewQuestion, opts?: { afterPath?: QuestionPath; beforePath?: QuestionPath; atIndex?: number; parentPath?: QuestionPath }): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const newQ: Question = this.newQuestionToBlueprint(question)

    let arr: Question[]
    if (opts?.parentPath) {
      const parent = this.findByPath(form.questions, opts.parentPath)
      if (!parent) throw new Error(`Parent question "${opts.parentPath}" not found`)
      if (!parent.question.children) parent.question.children = []
      arr = parent.question.children
    } else {
      arr = form.questions
    }

    if (opts?.atIndex !== undefined) {
      arr.splice(opts.atIndex, 0, newQ)
    } else {
      const afterId = opts?.afterPath ? qpathId(opts.afterPath) : undefined
      const beforeId = opts?.beforePath ? qpathId(opts.beforePath) : undefined
      this.insertIntoArray(arr, newQ, afterId, beforeId)
    }
  }

  removeQuestion(mIdx: number, fIdx: number, questionPath: QuestionPath): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const found = this.findByPath(form.questions, questionPath)
    if (!found) throw new Error(`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`)

    const idx = found.parent.indexOf(found.question)
    if (idx !== -1) found.parent.splice(idx, 1)

    const bareId = qpathId(questionPath)

    // Clean up close_case reference
    if (form.close_case?.question === bareId) {
      delete form.close_case
    }

    // Clean up child_cases references
    if (form.child_cases) {
      form.child_cases = form.child_cases.filter(cc => {
        if (cc.case_name_field === bareId) return false
        if (cc.repeat_context === bareId) return false
        if (cc.case_properties) {
          cc.case_properties = cc.case_properties.filter(cp => cp.question_id !== bareId)
        }
        return true
      })
      if (form.child_cases.length === 0) delete form.child_cases
    }
  }

  moveQuestion(mIdx: number, fIdx: number, questionPath: QuestionPath, opts: { afterPath?: QuestionPath; beforePath?: QuestionPath; targetParentPath?: QuestionPath }): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    // No-op if moving relative to itself
    if (opts.afterPath === questionPath || opts.beforePath === questionPath) return

    const isCrossLevel = 'targetParentPath' in opts

    // Prevent circular nesting — can't move a group into itself or its descendants
    if (isCrossLevel && opts.targetParentPath !== undefined) {
      const targetStr = opts.targetParentPath as string
      const draggedStr = questionPath as string
      if (targetStr === draggedStr || targetStr.startsWith(draggedStr + '/')) return
    }

    const found = this.findByPath(form.questions, questionPath)
    if (!found) throw new Error(`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`)

    // Remove from current position
    const idx = found.parent.indexOf(found.question)
    if (idx !== -1) found.parent.splice(idx, 1)

    // Determine target array — cross-level uses targetParentPath, otherwise same parent
    const targetArray = isCrossLevel
      ? this.getParentArray(form.questions, opts.targetParentPath)
      : found.parent

    const afterId = opts.afterPath ? qpathId(opts.afterPath) : undefined
    const beforeId = opts.beforePath ? qpathId(opts.beforePath) : undefined
    this.insertIntoArray(targetArray, found.question, afterId, beforeId)
  }

  duplicateQuestion(mIdx: number, fIdx: number, questionPath: QuestionPath): QuestionPath {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const found = this.findByPath(form.questions, questionPath)
    if (!found) throw new Error(`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`)

    // Deep-clone and generate new ID
    const clone: Question = structuredClone(found.question)
    let newId = `${clone.id}_copy`
    const allIds = this.collectAllIds(form.questions)
    if (allIds.has(newId)) {
      let counter = 2
      while (allIds.has(`${clone.id}_${counter}`)) counter++
      newId = `${clone.id}_${counter}`
    }
    clone.id = newId

    // Clear case mapping on the clone to avoid duplicate mappings
    delete clone.is_case_property

    // Insert after original in same parent array
    this.insertIntoArray(found.parent, clone, qpathId(questionPath))
    return qpath(newId, qpathParent(questionPath))
  }

  private collectAllIds(questions: Question[]): Set<string> {
    const ids = new Set<string>()
    for (const q of questions) {
      ids.add(q.id)
      if (q.children) {
        for (const id of this.collectAllIds(q.children)) ids.add(id)
      }
    }
    return ids
  }

  // ── Structural mutations ────────────────────────────────────────────

  updateModule(mIdx: number, updates: {
    name?: string
    case_list_columns?: Array<{ field: string; header: string }>
    case_detail_columns?: Array<{ field: string; header: string }> | null
  }): void {
    const mod = this.blueprint.modules[mIdx]
    if (!mod) throw new Error(`Module ${mIdx} not found`)

    if (updates.name !== undefined) mod.name = updates.name
    if (updates.case_list_columns !== undefined) {
      mod.case_list_columns = updates.case_list_columns
    }
    if (updates.case_detail_columns !== undefined) {
      if (updates.case_detail_columns === null) {
        delete mod.case_detail_columns
      } else {
        mod.case_detail_columns = updates.case_detail_columns
      }
    }
  }

  updateForm(mIdx: number, fIdx: number, updates: { name?: string; type?: 'registration' | 'followup' | 'survey'; close_case?: { question?: string; answer?: string } | null; child_cases?: BlueprintChildCase[] | null }): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    if (updates.name !== undefined) form.name = updates.name
    if (updates.type !== undefined) form.type = updates.type
    if (updates.close_case !== undefined) {
      if (updates.close_case === null) {
        delete form.close_case
      } else {
        form.close_case = updates.close_case
      }
    }
    if (updates.child_cases !== undefined) {
      if (updates.child_cases === null) {
        delete form.child_cases
      } else {
        form.child_cases = updates.child_cases
      }
    }
  }

  addChildCase(mIdx: number, fIdx: number, childCase: BlueprintChildCase): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)
    if (!form.child_cases) form.child_cases = []
    form.child_cases.push(childCase)
  }

  replaceForm(mIdx: number, fIdx: number, form: BlueprintForm): void {
    const mod = this.blueprint.modules[mIdx]
    if (!mod) throw new Error(`Module ${mIdx} not found`)
    if (fIdx < 0 || fIdx >= mod.forms.length) throw new Error(`Form index ${fIdx} out of range`)
    mod.forms[fIdx] = form
  }

  addForm(mIdx: number, form: BlueprintForm): void {
    const mod = this.blueprint.modules[mIdx]
    if (!mod) throw new Error(`Module ${mIdx} not found`)
    mod.forms.push(form)
  }

  removeForm(mIdx: number, fIdx: number): void {
    const mod = this.blueprint.modules[mIdx]
    if (!mod) throw new Error(`Module ${mIdx} not found`)
    if (fIdx < 0 || fIdx >= mod.forms.length) throw new Error(`Form index ${fIdx} out of range`)
    mod.forms.splice(fIdx, 1)
  }

  addModule(module: BlueprintModule): void {
    this.blueprint.modules.push(module)
  }

  removeModule(mIdx: number): void {
    if (mIdx < 0 || mIdx >= this.blueprint.modules.length) throw new Error(`Module ${mIdx} out of range`)
    this.blueprint.modules.splice(mIdx, 1)
  }

  // ── Dependency propagation ──────────────────────────────────────────

  renameCaseProperty(caseType: string, oldName: string, newName: string): RenameResult {
    const formsChanged: string[] = []
    const columnsChanged: string[] = []

    // case_types is frozen after generation — not updated during edits

    for (let mIdx = 0; mIdx < this.blueprint.modules.length; mIdx++) {
      const mod = this.blueprint.modules[mIdx]
      if (mod.case_type !== caseType) continue

      // Case list columns and case detail columns
      for (const columns of [mod.case_list_columns, mod.case_detail_columns]) {
        if (columns) {
          for (const col of columns) {
            if (col.field === oldName) {
              col.field = newName
              if (!columnsChanged.includes(`m${mIdx}`)) columnsChanged.push(`m${mIdx}`)
            }
          }
        }
      }

      // Forms
      for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
        const form = mod.forms[fIdx]
        let formChanged = false

        // Rename question IDs and rewrite XPath refs
        formChanged = this.renamePropertyInQuestions(form.questions, oldName, newName) || formChanged

        // Child cases
        if (form.child_cases) {
          for (const cc of form.child_cases) {
            if (cc.case_properties) {
              for (const cp of cc.case_properties) {
                if (cp.case_property === oldName) {
                  cp.case_property = newName
                  formChanged = true
                }
              }
            }
          }
        }

        if (formChanged) {
          formsChanged.push(`m${mIdx}-f${fIdx}`)
        }
      }
    }

    return { formsChanged, columnsChanged }
  }

  renameQuestion(mIdx: number, fIdx: number, questionPath: QuestionPath, newId: string): QuestionRenameResult {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const found = this.findByPath(form.questions, questionPath)
    if (!found) throw new Error(`Question "${questionPath}" not found in m${mIdx}-f${fIdx}`)

    const oldId = found.question.id
    // The path string is used for XPath rewriting (matches /data/... structure)
    const oldXPathPath = questionPath as string
    found.question.id = newId

    // Rewrite XPath references in all questions within the same form
    let xpathFieldsRewritten = 0
    xpathFieldsRewritten += this.rewriteXPathInQuestions(form.questions, oldXPathPath, newId)

    // Update close_case reference
    if (form.close_case?.question === oldId) {
      form.close_case.question = newId
    }

    // Update child_cases references
    if (form.child_cases) {
      for (const cc of form.child_cases) {
        if (cc.case_name_field === oldId) cc.case_name_field = newId
        if (cc.repeat_context === oldId) cc.repeat_context = newId
        if (cc.case_properties) {
          for (const cp of cc.case_properties) {
            if (cp.question_id === oldId) cp.question_id = newId
          }
        }
      }
    }

    const newPath = qpath(newId, qpathParent(questionPath))
    return { newPath, xpathFieldsRewritten }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Get the children array for a given parent path, or root questions if no parent. */
  private getParentArray(questions: Question[], parentPath?: QuestionPath): Question[] {
    if (!parentPath) return questions
    const segments = (parentPath as string).split('/')
    let current = questions
    for (const seg of segments) {
      const parent = current.find(q => q.id === seg)
      if (!parent) throw new Error(`Parent "${seg}" not found`)
      if (!parent.children) parent.children = []
      current = parent.children
    }
    return current
  }

  /** Walk the tree matching path segments to find a question and its parent array. */
  private findByPath(questions: Question[], path: QuestionPath): { question: Question; parent: Question[] } | undefined {
    const segments = (path as string).split('/')
    let current = questions
    for (let i = 0; i < segments.length - 1; i++) {
      const parent = current.find(q => q.id === segments[i])
      if (!parent?.children) return undefined
      current = parent.children
    }
    const lastId = segments[segments.length - 1]
    const question = current.find(q => q.id === lastId)
    if (!question) return undefined
    return { question, parent: current }
  }

  /** Recursive bare-ID search, returns full QuestionPath. Used by resolveQuestionId. */
  private findQuestionPath(questions: Question[], id: string, parent: QuestionPath | undefined): QuestionPath | undefined {
    for (const q of questions) {
      const path = qpath(q.id, parent)
      if (q.id === id) return path
      if (q.children) {
        const found = this.findQuestionPath(q.children, id, path)
        if (found) return found
      }
    }
    return undefined
  }

  private insertIntoArray(arr: Question[], item: Question, afterId?: string, beforeId?: string): void {
    if (beforeId) {
      const idx = arr.findIndex(q => q.id === beforeId)
      if (idx === -1) {
        arr.push(item)
      } else {
        arr.splice(idx, 0, item)
      }
      return
    }
    if (!afterId) {
      arr.push(item)
      return
    }
    const idx = arr.findIndex(q => q.id === afterId)
    if (idx === -1) {
      arr.push(item)
    } else {
      arr.splice(idx + 1, 0, item)
    }
  }

  private newQuestionToBlueprint(nq: NewQuestion): Question {
    return {
      id: nq.id,
      type: nq.type,
      ...(nq.label != null && { label: nq.label }),
      ...(nq.hint != null && { hint: nq.hint }),
      ...(nq.help != null && { help: nq.help }),
      ...(nq.required != null && { required: nq.required }),

      ...(nq.validation != null && { validation: nq.validation }),
      ...(nq.validation_msg != null && { validation_msg: nq.validation_msg }),
      ...(nq.relevant != null && { relevant: nq.relevant }),
      ...(nq.calculate != null && { calculate: nq.calculate }),
      ...(nq.default_value != null && { default_value: nq.default_value }),
      ...(nq.options != null && { options: nq.options }),
      ...(nq.is_case_property != null && { is_case_property: nq.is_case_property }),
      ...((nq.type === 'group' || nq.type === 'repeat') && {
        children: (nq.children ?? []).map(c => this.newQuestionToBlueprint(c)),
      }),
    }
  }

  private rewriteXPathInQuestions(questions: Question[], oldPath: string, newId: string): number {
    const xpathFields = ['relevant', 'calculate', 'default_value', 'validation'] as const
    const displayFields = ['label', 'hint'] as const
    const rewriter = (expr: string) => rewriteXPathRefs(expr, oldPath, newId)
    let count = 0
    for (const q of questions) {
      for (const field of xpathFields) {
        const val = q[field]
        if (!val) continue
        const rewritten = rewriter(val)
        if (rewritten !== val) {
          ;(q as any)[field] = rewritten
          count++
        }
      }
      for (const field of displayFields) {
        const text = q[field]
        if (!text) continue
        const rewritten = rewriteOutputTags(text, rewriter)
        if (rewritten !== text) {
          ;(q as any)[field] = rewritten
          count++
        }
      }
      if (q.children) {
        count += this.rewriteXPathInQuestions(q.children, oldPath, newId)
      }
    }
    return count
  }

  private renamePropertyInQuestions(questions: Question[], oldName: string, newName: string): boolean {
    const xpathFields = ['relevant', 'calculate', 'default_value', 'validation'] as const
    const displayFields = ['label', 'hint'] as const
    const hashtagRewriter = (expr: string) => rewriteHashtagRefs(expr, '#case/', oldName, newName)
    const pathRewriter = (expr: string) => rewriteXPathRefs(expr, oldName, newName)
    let changed = false
    for (const q of questions) {
      // Rename question ID (since question ID = property name)
      if (q.id === oldName && q.is_case_property) {
        q.id = newName
        changed = true
      }
      for (const field of xpathFields) {
        const val = q[field]
        if (!val) continue
        // Rewrite both #case/old → #case/new and /data/old → /data/new
        let rewritten = hashtagRewriter(val)
        rewritten = pathRewriter(rewritten)
        if (rewritten !== val) {
          ;(q as any)[field] = rewritten
          changed = true
        }
      }
      for (const field of displayFields) {
        const text = q[field]
        if (!text) continue
        const rewritten = rewriteOutputTags(text, (expr) => pathRewriter(hashtagRewriter(expr)))
        if (rewritten !== text) {
          ;(q as any)[field] = rewritten
          changed = true
        }
      }
      if (q.children) {
        changed = this.renamePropertyInQuestions(q.children, oldName, newName) || changed
      }
    }
    return changed
  }
}
