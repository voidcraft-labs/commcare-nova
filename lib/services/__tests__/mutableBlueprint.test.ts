import { describe, it, expect } from 'vitest'
import { MutableBlueprint } from '../mutableBlueprint'
import type { AppBlueprint, Question } from '../../schemas/blueprint'

/** Minimal test blueprint with two modules, two forms each. */
function makeBlueprint(): AppBlueprint {
  return {
    app_name: 'Test App',
    modules: [
      {
        name: 'Client Management',
        case_type: 'client',
        case_list_columns: [
          { field: 'full_name', header: 'Name' },
          { field: 'email_address', header: 'Email' },
        ],
        forms: [
          {
            name: 'Register Client',
            type: 'registration',
            questions: [
              { id: 'client_name', type: 'text', label: 'Client Name', is_case_name: true, case_property: 'full_name', required: 'true()' },
              { id: 'client_email', type: 'text', label: 'Client Email', case_property: 'email_address', constraint: "regex(., '[^@]+@[^@]+\\.[^@]+')", constraint_msg: 'Please enter a valid email' },
              { id: 'client_phone', type: 'phone', label: 'Phone Number' },
            ],
          },
          {
            name: 'Update Client',
            type: 'followup',
            questions: [
              { id: 'edit_name', type: 'text', label: 'Client Name', is_case_name: true, case_property: 'full_name' },
              { id: 'edit_email', type: 'text', label: 'Email', case_property: 'email_address' },
              { id: 'risk_score', type: 'hidden', calculate: "#case/email_address", case_property: 'risk_level' },
            ],
          },
        ],
      },
      {
        name: 'Surveys',
        forms: [
          {
            name: 'Satisfaction Survey',
            type: 'survey',
            questions: [
              { id: 'rating', type: 'select1', label: 'How satisfied are you?', options: [{ value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }] },
            ],
          },
        ],
      },
    ],
    case_types: [{ name: 'client', case_name_property: 'full_name', properties: [{ name: 'full_name', label: 'Full Name' }, { name: 'email_address', label: 'Email Address' }] }],
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
      expect(mod?.name).toBe('Client Management')
    })

    it('getModule returns null for invalid index', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.getModule(99)).toBeNull()
    })

    it('getForm returns form', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const form = mb.getForm(0, 1)
      expect(form?.name).toBe('Update Client')
    })

    it('getQuestion returns question with path', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const result = mb.getQuestion(0, 0, 'client_email')
      expect(result?.question.label).toBe('Client Email')
      expect(result?.path).toBe('client_email')
    })
  })

  describe('updateQuestion', () => {
    it('updates constraint and constraint_msg', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, 'client_email', {
        constraint: "regex(., '^[a-zA-Z0-9._%+-]+@gmail\\.com$')",
        constraint_msg: 'Please enter a Gmail address',
      })
      expect(updated.constraint).toBe("regex(., '^[a-zA-Z0-9._%+-]+@gmail\\.com$')")
      expect(updated.constraint_msg).toBe('Please enter a Gmail address')
    })

    it('clears a field when set to null', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, 'client_email', { constraint: null })
      expect(updated.constraint).toBeUndefined()
    })

    it('updates case_property on a question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, 'client_email', { case_property: 'contact_email' })
      expect(updated.case_property).toBe('contact_email')
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.updateQuestion(0, 0, 'nonexistent', { label: 'X' })).toThrow()
    })
  })

  describe('addQuestion', () => {
    it('appends question at end', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addQuestion(0, 0, { id: 'new_q', type: 'text', label: 'New Question' })
      const form = mb.getForm(0, 0)!
      expect(form.questions[form.questions.length - 1].id).toBe('new_q')
    })

    it('inserts after specific question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addQuestion(0, 0, { id: 'inserted', type: 'text', label: 'Inserted' }, { afterId: 'client_name' })
      const form = mb.getForm(0, 0)!
      const ids = form.questions.map(q => q.id)
      expect(ids.indexOf('inserted')).toBe(ids.indexOf('client_name') + 1)
    })

    it('adds question with case_property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addQuestion(0, 0, { id: 'client_age', type: 'int', label: 'Age', case_property: 'age' })
      const form = mb.getForm(0, 0)!
      const q = form.questions.find(q => q.id === 'client_age')
      expect(q?.case_property).toBe('age')
    })
  })

  describe('removeQuestion', () => {
    it('removes a question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeQuestion(0, 0, 'client_phone')
      const form = mb.getForm(0, 0)!
      expect(form.questions.some(q => q.id === 'client_phone')).toBe(false)
    })

    it('removes question with case_property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeQuestion(0, 0, 'client_email')
      const form = mb.getForm(0, 0)!
      expect(form.questions.some(q => q.id === 'client_email')).toBe(false)
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.removeQuestion(0, 0, 'nonexistent')).toThrow()
    })
  })

  describe('structural mutations', () => {
    it('updateModule changes name', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.updateModule(0, { name: 'Patient Management' })
      expect(mb.getModule(0)?.name).toBe('Patient Management')
    })

    it('updateModule changes case_list_columns', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.updateModule(0, { case_list_columns: [{ field: 'full_name', header: 'Full Name' }] })
      expect(mb.getModule(0)?.case_list_columns?.length).toBe(1)
    })

    it('addForm adds a form', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addForm(0, { name: 'New Form', type: 'followup', questions: [] })
      expect(mb.getModule(0)?.forms.length).toBe(3)
    })

    it('removeForm removes a form', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeForm(0, 1)
      expect(mb.getModule(0)?.forms.length).toBe(1)
      expect(mb.getModule(0)?.forms[0].name).toBe('Register Client')
    })

    it('addModule adds a module', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.addModule({ name: 'New Module', forms: [] })
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

    it('does not affect modules with different case_type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.renameCaseProperty('client', 'email_address', 'contact_email')
      // Survey module should be unchanged
      const surveyModule = mb.getModule(1)!
      expect(surveyModule.name).toBe('Surveys')
    })

    it('returns empty results for nonexistent case type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const result = mb.renameCaseProperty('nonexistent', 'foo', 'bar')
      expect(result.formsChanged).toEqual([])
      expect(result.columnsChanged).toEqual([])
    })
  })

  describe('case type access', () => {
    it('getCaseType returns the case type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const ct = mb.getCaseType('client')
      expect(ct?.name).toBe('client')
      expect(ct?.properties.length).toBe(2)
    })

    it('getCaseType returns null for nonexistent case type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.getCaseType('nonexistent')).toBeNull()
    })

    it('getCaseProperty returns a property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const prop = mb.getCaseProperty('client', 'full_name')
      expect(prop?.label).toBe('Full Name')
    })

    it('getCaseProperty returns null for nonexistent property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.getCaseProperty('client', 'nonexistent')).toBeNull()
    })

    it('updateCaseProperty updates property metadata', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.updateCaseProperty('client', 'full_name', { label: 'Client Full Name', hint: 'Enter legal name' })
      const prop = mb.getCaseProperty('client', 'full_name')
      expect(prop?.label).toBe('Client Full Name')
      expect(prop?.hint).toBe('Enter legal name')
    })

    it('updateCaseProperty throws for nonexistent case type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.updateCaseProperty('bad', 'full_name', { label: 'X' })).toThrow()
    })

    it('updateCaseProperty throws for nonexistent property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.updateCaseProperty('client', 'bad', { label: 'X' })).toThrow()
    })
  })

  describe('renameCaseProperty propagates to case_types', () => {
    it('renames property in case_types definition', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.renameCaseProperty('client', 'email_address', 'contact_email')
      const ct = mb.getCaseType('client')
      expect(ct?.properties.some(p => p.name === 'contact_email')).toBe(true)
      expect(ct?.properties.some(p => p.name === 'email_address')).toBe(false)
    })

    it('renames case_name_property when it matches', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.renameCaseProperty('client', 'full_name', 'legal_name')
      const ct = mb.getCaseType('client')
      expect(ct?.case_name_property).toBe('legal_name')
    })
  })

  describe('deep clone isolation', () => {
    it('does not mutate original blueprint', () => {
      const original = makeBlueprint()
      const originalName = original.modules[0].forms[0].questions[0].label
      const mb = new MutableBlueprint(original)
      mb.updateQuestion(0, 0, 'client_name', { label: 'CHANGED' })
      expect(original.modules[0].forms[0].questions[0].label).toEqual(originalName)
    })
  })
})
