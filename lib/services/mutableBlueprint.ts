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

// ── Result types ────────────────────────────────────────────────────────

export interface SearchResult {
  type: 'module' | 'form' | 'question' | 'case_list_column'
  moduleIndex: number
  formIndex?: number
  questionId?: string
  field: string     // which field matched (e.g. 'label', 'case_property', 'id', 'name')
  value: string     // the matched value
  context: string   // human-readable location string
}

export interface RenameResult {
  formsChanged: string[]    // ["m0-f0", "m0-f1"]
  columnsChanged: string[]  // ["m0"]
}

// ── QuestionUpdate type ─────────────────────────────────────────────────

export interface QuestionUpdate {
  type: Question['type']
  label: string | null
  hint: string | null
  help: string | null
  required: string | null
  constraint: string | null
  constraint_msg: string | null
  relevant: string | null
  calculate: string | null
  default_value: string | null
  options: Array<{ value: string; label: string }> | null
  case_property: string | null
  is_case_name: boolean | null
}

// ── NewQuestion type ────────────────────────────────────────────────────

export interface NewQuestion {
  id: string
  type: Question['type']
  label?: string
  hint?: string
  help?: string
  required?: string
  constraint?: string
  constraint_msg?: string
  relevant?: string
  calculate?: string
  default_value?: string
  options?: Array<{ value: string; label: string }>
  case_property?: string
  is_case_name?: boolean
  children?: NewQuestion[]
}

// ── MutableBlueprint ────────────────────────────────────────────────────

export class MutableBlueprint {
  private blueprint: AppBlueprint

  constructor(blueprint: AppBlueprint) {
    this.blueprint = structuredClone(blueprint)
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

  getModule(mIdx: number): BlueprintModule | null {
    return this.blueprint.modules[mIdx] ?? null
  }

  getForm(mIdx: number, fIdx: number): BlueprintForm | null {
    return this.blueprint.modules[mIdx]?.forms[fIdx] ?? null
  }

  getQuestion(mIdx: number, fIdx: number, questionId: string): { question: Question; path: string } | null {
    const form = this.getForm(mIdx, fIdx)
    if (!form) return null
    return this.findQuestionWithPath(form.questions, questionId, '')
  }

  getCaseType(name: string): CaseType | null {
    return this.blueprint.case_types?.find(ct => ct.name === name) ?? null
  }

  getCaseProperty(caseTypeName: string, propertyName: string): CaseProperty | null {
    const ct = this.getCaseType(caseTypeName)
    return ct?.properties.find(p => p.name === propertyName) ?? null
  }

  updateCaseProperty(caseTypeName: string, propertyName: string, updates: Partial<Omit<CaseProperty, 'name'>>): void {
    const ct = this.blueprint.case_types?.find(c => c.name === caseTypeName)
    if (!ct) throw new Error(`Case type "${caseTypeName}" not found`)
    const prop = ct.properties.find(p => p.name === propertyName)
    if (!prop) throw new Error(`Property "${propertyName}" not found on case type "${caseTypeName}"`)
    Object.assign(prop, updates)
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
        this.searchQuestions(form.questions, q, mIdx, fIdx, results)
      }
    }

    return results
  }

  private searchQuestions(questions: Question[], query: string, mIdx: number, fIdx: number, results: SearchResult[]): void {
    for (const q of questions) {
      const formRef = `m${mIdx}-f${fIdx}`
      const matchFields: Array<{ field: string; value: string }> = []

      if (q.id.toLowerCase().includes(query)) matchFields.push({ field: 'id', value: q.id })
      if (q.label && q.label.toLowerCase().includes(query)) matchFields.push({ field: 'label', value: q.label })
      if (q.case_property?.toLowerCase().includes(query)) matchFields.push({ field: 'case_property', value: q.case_property })
      if (q.constraint?.toLowerCase().includes(query)) matchFields.push({ field: 'constraint', value: q.constraint })
      if (q.relevant?.toLowerCase().includes(query)) matchFields.push({ field: 'relevant', value: q.relevant })
      if (q.calculate?.toLowerCase().includes(query)) matchFields.push({ field: 'calculate', value: q.calculate })
      if (q.default_value?.toLowerCase().includes(query)) matchFields.push({ field: 'default_value', value: q.default_value })
      if (q.constraint_msg && q.constraint_msg.toLowerCase().includes(query)) matchFields.push({ field: 'constraint_msg', value: q.constraint_msg })
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
          questionId: q.id,
          field: match.field,
          value: match.value,
          context: `${formRef} question "${q.id}" (${q.type}${q.case_property ? `, case_property: ${q.case_property}` : ''})`,
        })
      }

      if (q.children) {
        this.searchQuestions(q.children, query, mIdx, fIdx, results)
      }
    }
  }

  // ── Question mutations ──────────────────────────────────────────────

  updateQuestion(mIdx: number, fIdx: number, questionId: string, updates: Partial<QuestionUpdate>): Question {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const found = this.findQuestion(form.questions, questionId)
    if (!found) throw new Error(`Question "${questionId}" not found in m${mIdx}-f${fIdx}`)

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

  addQuestion(mIdx: number, fIdx: number, question: NewQuestion, opts?: { afterId?: string; parentId?: string }): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const newQ: Question = this.newQuestionToBlueprint(question)

    if (opts?.parentId) {
      const parent = this.findQuestion(form.questions, opts.parentId)
      if (!parent) throw new Error(`Parent question "${opts.parentId}" not found`)
      if (!parent.question.children) parent.question.children = []
      this.insertIntoArray(parent.question.children, newQ, opts.afterId)
    } else {
      this.insertIntoArray(form.questions, newQ, opts?.afterId)
    }
  }

  removeQuestion(mIdx: number, fIdx: number, questionId: string): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const removed = this.removeFromTree(form.questions, questionId)
    if (!removed) throw new Error(`Question "${questionId}" not found in m${mIdx}-f${fIdx}`)

    // Clean up close_case reference
    if (form.close_case?.question === questionId) {
      delete form.close_case
    }

    // Clean up child_cases references
    if (form.child_cases) {
      form.child_cases = form.child_cases.filter(cc => {
        if (cc.case_name_field === questionId) return false
        if (cc.repeat_context === questionId) return false
        if (cc.case_properties) {
          cc.case_properties = cc.case_properties.filter(cp => cp.question_id !== questionId)
        }
        return true
      })
      if (form.child_cases.length === 0) delete form.child_cases
    }
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

  updateForm(mIdx: number, fIdx: number, updates: { name?: string; close_case?: { question?: string; answer?: string } | null }): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    if (updates.name !== undefined) form.name = updates.name
    if (updates.close_case !== undefined) {
      if (updates.close_case === null) {
        delete form.close_case
      } else {
        form.close_case = updates.close_case
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

    // Rename in case_types definition
    if (this.blueprint.case_types) {
      const ct = this.blueprint.case_types.find(c => c.name === caseType)
      if (ct) {
        const prop = ct.properties.find(p => p.name === oldName)
        if (prop) prop.name = newName
        if (ct.case_name_property === oldName) ct.case_name_property = newName
      }
    }

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

        // Questions
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

  // ── Private helpers ─────────────────────────────────────────────────

  private findQuestion(questions: Question[], id: string): { question: Question; parent: Question[] } | null {
    for (const q of questions) {
      if (q.id === id) return { question: q, parent: questions }
      if (q.children) {
        const found = this.findQuestion(q.children, id)
        if (found) return found
      }
    }
    return null
  }

  private findQuestionWithPath(questions: Question[], id: string, prefix: string): { question: Question; path: string } | null {
    for (const q of questions) {
      const path = prefix ? `${prefix}/${q.id}` : q.id
      if (q.id === id) return { question: q, path }
      if (q.children) {
        const found = this.findQuestionWithPath(q.children, id, path)
        if (found) return found
      }
    }
    return null
  }

  private insertIntoArray(arr: Question[], item: Question, afterId?: string): void {
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

  private removeFromTree(questions: Question[], id: string): boolean {
    const idx = questions.findIndex(q => q.id === id)
    if (idx !== -1) {
      questions.splice(idx, 1)
      return true
    }
    for (const q of questions) {
      if (q.children && this.removeFromTree(q.children, id)) return true
    }
    return false
  }

  private newQuestionToBlueprint(nq: NewQuestion): Question {
    return {
      id: nq.id,
      type: nq.type,
      ...(nq.label != null && { label: nq.label }),
      ...(nq.hint != null && { hint: nq.hint }),
      ...(nq.help != null && { help: nq.help }),
      ...(nq.required != null && { required: nq.required }),

      ...(nq.constraint != null && { constraint: nq.constraint }),
      ...(nq.constraint_msg != null && { constraint_msg: nq.constraint_msg }),
      ...(nq.relevant != null && { relevant: nq.relevant }),
      ...(nq.calculate != null && { calculate: nq.calculate }),
      ...(nq.default_value != null && { default_value: nq.default_value }),
      ...(nq.options != null && { options: nq.options }),
      ...(nq.case_property != null && { case_property: nq.case_property }),
      ...(nq.is_case_name != null && { is_case_name: nq.is_case_name }),
      ...(nq.children && { children: nq.children.map(c => this.newQuestionToBlueprint(c)) }),
    }
  }

  private renamePropertyInQuestions(questions: Question[], oldName: string, newName: string): boolean {
    let changed = false
    for (const q of questions) {
      if (q.case_property === oldName) {
        q.case_property = newName
        changed = true
      }
      // Update XPath references: #case/oldName → #case/newName
      const xpathFields = ['relevant', 'calculate', 'default_value', 'constraint'] as const
      for (const field of xpathFields) {
        const val = q[field]
        if (val && val.includes(`#case/${oldName}`)) {
          ;(q as any)[field] = val.replaceAll(`#case/${oldName}`, `#case/${newName}`)
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
