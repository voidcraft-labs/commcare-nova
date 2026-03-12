import { describe, it, expect } from 'vitest'
import { MutableBlueprint } from '../mutableBlueprint'
import type { AppBlueprint } from '../../schemas/blueprint'

/** Helper to create a localized string from plain text. */
function L(text: string): Array<{ lang: string; text: string }> {
  return [{ lang: 'en', text }]
}

/** Minimal test blueprint with two modules, two forms each. */
function makeBlueprint(): AppBlueprint {
  return {
    app_name: 'Test App',
    modules: [
      {
        name: L('Client Management'),
        case_type: 'client',
        case_list_columns: [
          { field: 'full_name', header: L('Name') },
          { field: 'email_address', header: L('Email') },
        ],
        forms: [
          {
            name: L('Register Client'),
            type: 'registration',
            case_name_field: 'client_name',
            case_properties: [
              { case_property: 'full_name', question_id: 'client_name' },
              { case_property: 'email_address', question_id: 'client_email' },
            ],
            questions: [
              { id: 'client_name', type: 'text' as const, label: L('Client Name'), is_case_name: true, case_property: 'full_name', required: 'true()' },
              { id: 'client_email', type: 'text' as const, label: L('Client Email'), case_property: 'email_address', constraint: "regex(., '[^@]+@[^@]+\\.[^@]+')", constraint_msg: L('Please enter a valid email') },
              { id: 'client_phone', type: 'phone' as const, label: L('Phone Number') },
            ],
          },
          {
            name: L('Update Client'),
            type: 'followup',
            case_name_field: 'edit_name',
            case_properties: [
              { case_property: 'full_name', question_id: 'edit_name' },
              { case_property: 'email_address', question_id: 'edit_email' },
            ],
            case_preload: [
              { case_property: 'full_name', question_id: 'edit_name' },
              { case_property: 'email_address', question_id: 'edit_email' },
            ],
            questions: [
              { id: 'edit_name', type: 'text' as const, label: L('Client Name'), is_case_name: true, case_property: 'full_name' },
              { id: 'edit_email', type: 'text' as const, label: L('Email'), case_property: 'email_address' },
              { id: 'risk_score', type: 'hidden' as const, calculate: "#case/email_address", case_property: 'risk_level' },
            ],
          },
        ],
      },
      {
        name: L('Surveys'),
        forms: [
          {
            name: L('Satisfaction Survey'),
            type: 'survey',
            questions: [
              { id: 'rating', type: 'select1' as const, label: L('How satisfied are you?'), options: [{ value: 'good', label: L('Good') }, { value: 'bad', label: L('Bad') }] },
            ],
          },
        ],
      },
    ],
  }
}

describe('MutableBlueprint', () => {
  describe('search', () => {
    it('finds questions by id', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('client_email')
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some(r => r.questionId === 'client_email')).toBe(true)
    })

    it('finds questions by label', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('Client Name')
      expect(results.some(r => r.field === 'label')).toBe(true)
    })

    it('finds questions by case_property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('email_address')
      // Should find questions in both forms + case_list_column
      expect(results.length).toBeGreaterThanOrEqual(3)
    })

    it('finds modules by name', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('Client Management')
      expect(results.some(r => r.type === 'module' && r.field === 'name')).toBe(true)
    })

    it('finds forms by name', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('Register')
      expect(results.some(r => r.type === 'form')).toBe(true)
    })

    it('finds case list columns', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('full_name')
      expect(results.some(r => r.type === 'case_list_column')).toBe(true)
    })

    it('finds options by value', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('good')
      expect(results.some(r => r.field === 'option')).toBe(true)
    })

    it('is case-insensitive', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const results = mb.search('CLIENT EMAIL')
      expect(results.length).toBeGreaterThan(0)
    })

    it('returns empty for no matches', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.search('xyznonexistent')).toEqual([])
    })
  })

  describe('read', () => {
    it('getModule returns module', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const mod = mb.getModule(0)
      expect(mod?.name).toEqual(L('Client Management'))
    })

    it('getModule returns null for invalid index', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.getModule(99)).toBeNull()
    })

    it('getForm returns form', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const form = mb.getForm(0, 1)
      expect(form?.name).toEqual(L('Update Client'))
    })

    it('getQuestion returns question with path', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const result = mb.getQuestion(0, 0, 'client_email')
      expect(result?.question.label).toEqual(L('Client Email'))
      expect(result?.path).toBe('client_email')
    })
  })

  describe('updateQuestion', () => {
    it('updates constraint and constraint_msg', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, 'client_email', {
        constraint: "regex(., '^[a-zA-Z0-9._%+-]+@gmail\\.com$')",
        constraint_msg: L('Please enter a Gmail address'),
      })
      expect(updated.constraint).toBe("regex(., '^[a-zA-Z0-9._%+-]+@gmail\\.com$')")
      expect(updated.constraint_msg).toEqual(L('Please enter a Gmail address'))
    })

    it('clears a field when set to null', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, 'client_email', { constraint: null })
      expect(updated.constraint).toBeUndefined()
    })

    it('re-derives case config after updating case_property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.updateQuestion(0, 0, 'client_email', { case_property: 'contact_email' })
      const form = mb.getForm(0, 0)!
      expect(form.case_properties?.some(cp => cp.case_property === 'contact_email')).toBe(true)
      expect(form.case_properties?.some(cp => cp.case_property === 'email_address')).toBe(false)
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.updateQuestion(0, 0, 'nonexistent', { label: L('X') })).toThrow()
    })
  })

  describe('addQuestion', () => {
    it('appends question at end', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addQuestion(0, 0, { id: 'new_q', type: 'text', label: L('New Question') })
      const form = mb.getForm(0, 0)!
      expect(form.questions[form.questions.length - 1].id).toBe('new_q')
    })

    it('inserts after specific question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addQuestion(0, 0, { id: 'inserted', type: 'text', label: L('Inserted') }, { afterId: 'client_name' })
      const form = mb.getForm(0, 0)!
      const ids = form.questions.map(q => q.id)
      expect(ids.indexOf('inserted')).toBe(ids.indexOf('client_name') + 1)
    })

    it('adds question with case_property and re-derives config', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addQuestion(0, 0, { id: 'client_age', type: 'int', label: L('Age'), case_property: 'age' })
      const form = mb.getForm(0, 0)!
      expect(form.case_properties?.some(cp => cp.case_property === 'age')).toBe(true)
    })
  })

  describe('removeQuestion', () => {
    it('removes a question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeQuestion(0, 0, 'client_phone')
      const form = mb.getForm(0, 0)!
      expect(form.questions.some(q => q.id === 'client_phone')).toBe(false)
    })

    it('re-derives case config after removing question with case_property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeQuestion(0, 0, 'client_email')
      const form = mb.getForm(0, 0)!
      expect(form.case_properties?.some(cp => cp.case_property === 'email_address')).toBeFalsy()
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.removeQuestion(0, 0, 'nonexistent')).toThrow()
    })
  })

  describe('structural mutations', () => {
    it('updateModule changes name', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.updateModule(0, { name: L('Patient Management') })
      expect(mb.getModule(0)?.name).toEqual(L('Patient Management'))
    })

    it('updateModule changes case_list_columns', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.updateModule(0, { case_list_columns: [{ field: 'full_name', header: L('Full Name') }] })
      expect(mb.getModule(0)?.case_list_columns?.length).toBe(1)
    })

    it('addForm adds a form', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addForm(0, { name: L('New Form'), type: 'followup', questions: [] })
      expect(mb.getModule(0)?.forms.length).toBe(3)
    })

    it('removeForm removes a form', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeForm(0, 1)
      expect(mb.getModule(0)?.forms.length).toBe(1)
      expect(mb.getModule(0)?.forms[0].name).toEqual(L('Register Client'))
    })

    it('addModule adds a module', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addModule({ name: L('New Module'), forms: [] })
      expect(mb.getBlueprint().modules.length).toBe(3)
    })

    it('removeModule removes a module', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeModule(1)
      expect(mb.getBlueprint().modules.length).toBe(1)
    })
  })

  describe('renameCaseProperty', () => {
    it('renames case_property in questions across forms', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const result = mb.renameCaseProperty('client', 'email_address', 'contact_email')

      // Check registration form
      const regForm = mb.getForm(0, 0)!
      const regEmail = regForm.questions.find(q => q.id === 'client_email')!
      expect(regEmail.case_property).toBe('contact_email')

      // Check followup form
      const followForm = mb.getForm(0, 1)!
      const followEmail = followForm.questions.find(q => q.id === 'edit_email')!
      expect(followEmail.case_property).toBe('contact_email')

      expect(result.formsChanged).toContain('m0-f0')
      expect(result.formsChanged).toContain('m0-f1')
    })

    it('renames field in case_list_columns', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const result = mb.renameCaseProperty('client', 'email_address', 'contact_email')
      const mod = mb.getModule(0)!
      expect(mod.case_list_columns?.some(c => c.field === 'contact_email')).toBe(true)
      expect(mod.case_list_columns?.some(c => c.field === 'email_address')).toBe(false)
      expect(result.columnsChanged).toContain('m0')
    })

    it('updates XPath expressions with #case/ references', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.renameCaseProperty('client', 'email_address', 'contact_email')
      const followForm = mb.getForm(0, 1)!
      const riskScore = followForm.questions.find(q => q.id === 'risk_score')!
      expect(riskScore.calculate).toBe('#case/contact_email')
    })

    it('re-derives case config after rename', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.renameCaseProperty('client', 'email_address', 'contact_email')

      const regForm = mb.getForm(0, 0)!
      expect(regForm.case_properties?.some(cp => cp.case_property === 'contact_email')).toBe(true)

      const followForm = mb.getForm(0, 1)!
      expect(followForm.case_preload?.some(cp => cp.case_property === 'contact_email')).toBe(true)
    })

    it('does not affect modules with different case_type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.renameCaseProperty('client', 'email_address', 'contact_email')
      // Survey module should be unchanged
      const surveyModule = mb.getModule(1)!
      expect(surveyModule.name).toEqual(L('Surveys'))
    })

    it('returns empty results for nonexistent case type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const result = mb.renameCaseProperty('nonexistent', 'foo', 'bar')
      expect(result.formsChanged).toEqual([])
      expect(result.columnsChanged).toEqual([])
    })
  })

  describe('deep clone isolation', () => {
    it('does not mutate original blueprint', () => {
      const original = makeBlueprint()
      const originalName = original.modules[0].forms[0].questions[0].label
      const mb = new MutableBlueprint(original)
      mb.updateQuestion(0, 0, 'client_name', { label: L('CHANGED') })
      expect(original.modules[0].forms[0].questions[0].label).toEqual(originalName)
    })
  })
})
