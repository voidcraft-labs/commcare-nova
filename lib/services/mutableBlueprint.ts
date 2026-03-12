/**
 * MutableBlueprint — wraps an AppBlueprint for in-place search, read, and mutation.
 *
 * Used by the edit-mode Solutions Architect agent to surgically modify an existing
 * blueprint without regenerating from scratch.
 */
import {
  type AppBlueprint, type BlueprintModule, type BlueprintForm, type BlueprintQuestion,
  type CasePropertyMapping, type LocalizedString, flattenQuestions, unflattenQuestions, deriveCaseConfig, displayText,
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
  label: LocalizedString
  type: BlueprintQuestion['type']
  hint: LocalizedString
  help: LocalizedString
  required: string
  readonly: boolean
  constraint: string | null
  constraint_msg: LocalizedString
  relevant: string | null
  calculate: string | null
  default_value: string | null
  options: Array<{ value: string; label: LocalizedString }> | null
  case_property: string | null
  is_case_name: boolean
}

// ── NewQuestion type ────────────────────────────────────────────────────

export interface NewQuestion {
  id: string
  type: BlueprintQuestion['type']
  label?: LocalizedString
  hint?: LocalizedString
  help?: LocalizedString
  required?: string
  readonly?: boolean
  constraint?: string
  constraint_msg?: LocalizedString
  relevant?: string
  calculate?: string
  default_value?: string
  options?: Array<{ value: string; label: LocalizedString }>
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

  getQuestion(mIdx: number, fIdx: number, questionId: string): { question: BlueprintQuestion; path: string } | null {
    const form = this.getForm(mIdx, fIdx)
    if (!form) return null
    return this.findQuestionWithPath(form.questions, questionId, '')
  }

  // ── Search ──────────────────────────────────────────────────────────

  search(query: string): SearchResult[] {
    const results: SearchResult[] = []
    const q = query.toLowerCase()

    const str = displayText

    for (let mIdx = 0; mIdx < this.blueprint.modules.length; mIdx++) {
      const mod = this.blueprint.modules[mIdx]
      const modName = str(mod.name)

      // Module name
      if (modName.toLowerCase().includes(q)) {
        results.push({ type: 'module', moduleIndex: mIdx, field: 'name', value: modName, context: `Module ${mIdx} "${modName}"` })
      }
      // Case type
      if (mod.case_type?.toLowerCase().includes(q)) {
        results.push({ type: 'module', moduleIndex: mIdx, field: 'case_type', value: mod.case_type, context: `Module ${mIdx} "${modName}" case_type` })
      }
      // Case list columns
      const allColumns = [...(mod.case_list_columns || []), ...(mod.case_detail_columns || [])]
      for (const col of allColumns) {
        const headerStr = displayText(col.header)
        if (col.field.toLowerCase().includes(q) || headerStr.toLowerCase().includes(q)) {
          results.push({ type: 'case_list_column', moduleIndex: mIdx, field: 'column', value: `${col.field} (${headerStr})`, context: `Module ${mIdx} "${modName}" column "${headerStr}"` })
        }
      }

      // Forms
      for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
        const form = mod.forms[fIdx]

        // Form name
        const formName = str(form.name)
        if (formName.toLowerCase().includes(q)) {
          results.push({ type: 'form', moduleIndex: mIdx, formIndex: fIdx, field: 'name', value: formName, context: `m${mIdx}-f${fIdx} "${formName}" (${form.type})` })
        }

        // Questions (recursive)
        this.searchQuestions(form.questions, q, mIdx, fIdx, results)
      }
    }

    return results
  }

  private searchQuestions(questions: BlueprintQuestion[], query: string, mIdx: number, fIdx: number, results: SearchResult[]): void {
    for (const q of questions) {
      const formRef = `m${mIdx}-f${fIdx}`
      const matchFields: Array<{ field: string; value: string }> = []

      if (q.id.toLowerCase().includes(query)) matchFields.push({ field: 'id', value: q.id })
      const labelStr = displayText(q.label)
      if (labelStr && labelStr.toLowerCase().includes(query)) matchFields.push({ field: 'label', value: labelStr })
      if (q.case_property?.toLowerCase().includes(query)) matchFields.push({ field: 'case_property', value: q.case_property })
      if (q.constraint?.toLowerCase().includes(query)) matchFields.push({ field: 'constraint', value: q.constraint })
      if (q.relevant?.toLowerCase().includes(query)) matchFields.push({ field: 'relevant', value: q.relevant })
      if (q.calculate?.toLowerCase().includes(query)) matchFields.push({ field: 'calculate', value: q.calculate })
      if (q.default_value?.toLowerCase().includes(query)) matchFields.push({ field: 'default_value', value: q.default_value })
      const cmStr = displayText(q.constraint_msg)
      if (cmStr && cmStr.toLowerCase().includes(query)) matchFields.push({ field: 'constraint_msg', value: cmStr })
      const hintStr = displayText(q.hint)
      if (hintStr && hintStr.toLowerCase().includes(query)) matchFields.push({ field: 'hint', value: hintStr })
      const helpStr = displayText(q.help)
      if (helpStr && helpStr.toLowerCase().includes(query)) matchFields.push({ field: 'help', value: helpStr })

      // Search options
      if (q.options) {
        for (const opt of q.options) {
          const optLabel = displayText(opt.label)
          if (opt.value.toLowerCase().includes(query) || optLabel.toLowerCase().includes(query)) {
            matchFields.push({ field: 'option', value: `${opt.value}: ${optLabel}` })
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

  updateQuestion(mIdx: number, fIdx: number, questionId: string, updates: Partial<QuestionUpdate>): BlueprintQuestion {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const found = this.findQuestion(form.questions, questionId)
    if (!found) throw new Error(`Question "${questionId}" not found in m${mIdx}-f${fIdx}`)

    const question = found.question

    // Apply updates — use null to clear optional fields, undefined means "don't change"
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue
      if (value === null) {
        delete (question as any)[key]
      } else {
        ;(question as any)[key] = value
      }
    }

    this.rederiveCaseConfig(mIdx, fIdx)
    return question
  }

  addQuestion(mIdx: number, fIdx: number, question: NewQuestion, opts?: { afterId?: string; parentId?: string }): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) throw new Error(`Form m${mIdx}-f${fIdx} not found`)

    const newQ: BlueprintQuestion = this.newQuestionToBlueprint(question)

    if (opts?.parentId) {
      const parent = this.findQuestion(form.questions, opts.parentId)
      if (!parent) throw new Error(`Parent question "${opts.parentId}" not found`)
      if (!parent.question.children) parent.question.children = []
      this.insertIntoArray(parent.question.children, newQ, opts.afterId)
    } else {
      this.insertIntoArray(form.questions, newQ, opts?.afterId)
    }

    this.rederiveCaseConfig(mIdx, fIdx)
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

    this.rederiveCaseConfig(mIdx, fIdx)
  }

  // ── Structural mutations ────────────────────────────────────────────

  updateModule(mIdx: number, updates: {
    name?: LocalizedString
    case_list_columns?: Array<{ field: string; header: LocalizedString }>
    case_detail_columns?: Array<{ field: string; header: LocalizedString }> | null
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

  updateForm(mIdx: number, fIdx: number, updates: { name?: LocalizedString; close_case?: { question?: string; answer?: string } | null }): void {
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
          this.rederiveCaseConfig(mIdx, fIdx)
          formsChanged.push(`m${mIdx}-f${fIdx}`)
        }
      }
    }

    return { formsChanged, columnsChanged }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private rederiveCaseConfig(mIdx: number, fIdx: number): void {
    const form = this.blueprint.modules[mIdx]?.forms[fIdx]
    if (!form) return

    const flat = flattenQuestions(form.questions)
    const { case_name_field, case_properties, case_preload } = deriveCaseConfig(flat, form.type)

    // Update or delete form-level fields
    if (case_name_field) form.case_name_field = case_name_field
    else delete form.case_name_field

    if (case_properties) form.case_properties = case_properties
    else delete form.case_properties

    if (case_preload) form.case_preload = case_preload
    else delete form.case_preload
  }

  private findQuestion(questions: BlueprintQuestion[], id: string): { question: BlueprintQuestion; parent: BlueprintQuestion[] } | null {
    for (const q of questions) {
      if (q.id === id) return { question: q, parent: questions }
      if (q.children) {
        const found = this.findQuestion(q.children, id)
        if (found) return found
      }
    }
    return null
  }

  private findQuestionWithPath(questions: BlueprintQuestion[], id: string, prefix: string): { question: BlueprintQuestion; path: string } | null {
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

  private insertIntoArray(arr: BlueprintQuestion[], item: BlueprintQuestion, afterId?: string): void {
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

  private removeFromTree(questions: BlueprintQuestion[], id: string): boolean {
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

  private newQuestionToBlueprint(nq: NewQuestion): BlueprintQuestion {
    return {
      id: nq.id,
      type: nq.type,
      ...(nq.label != null && { label: nq.label }),
      ...(nq.hint != null && { hint: nq.hint }),
      ...(nq.help != null && { help: nq.help }),
      ...(nq.required && { required: nq.required }),
      ...(nq.readonly && { readonly: nq.readonly }),
      ...(nq.constraint != null && { constraint: nq.constraint }),
      ...(nq.constraint_msg != null && { constraint_msg: nq.constraint_msg }),
      ...(nq.relevant != null && { relevant: nq.relevant }),
      ...(nq.calculate != null && { calculate: nq.calculate }),
      ...(nq.default_value != null && { default_value: nq.default_value }),
      ...(nq.options != null && { options: nq.options }),
      ...(nq.case_property != null && { case_property: nq.case_property }),
      ...(nq.is_case_name && { is_case_name: nq.is_case_name }),
      ...(nq.children && { children: nq.children.map(c => this.newQuestionToBlueprint(c)) }),
    }
  }

  private renamePropertyInQuestions(questions: BlueprintQuestion[], oldName: string, newName: string): boolean {
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
