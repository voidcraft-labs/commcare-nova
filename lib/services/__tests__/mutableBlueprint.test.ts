import { describe, it, expect } from 'vitest'
import { MutableBlueprint } from '../mutableBlueprint'
import { qpath } from '../questionPath'
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
              { id: 'rating', type: 'single_select', label: 'How satisfied are you?', options: [{ value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }] },
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
      expect(results.some(r => r.questionPath === 'client_email')).toBe(true)
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

    it('getModule returns undefined for invalid index', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.getModule(99)).toBeUndefined()
    })

    it('getForm returns form', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const form = mb.getForm(0, 1)
      expect(form?.name).toBe('Update Client')
    })

    it('getQuestion returns question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const result = mb.getQuestion(0, 0, qpath('client_email'))
      expect(result?.label).toBe('Client Email')
    })
  })

  describe('updateQuestion', () => {
    it('updates constraint and constraint_msg', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, qpath('client_email'), {
        constraint: "regex(., '^[a-zA-Z0-9._%+-]+@gmail\\.com$')",
        constraint_msg: 'Please enter a Gmail address',
      })
      expect(updated.constraint).toBe("regex(., '^[a-zA-Z0-9._%+-]+@gmail\\.com$')")
      expect(updated.constraint_msg).toBe('Please enter a Gmail address')
    })

    it('clears a field when set to null', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, qpath('client_email'), { constraint: null })
      expect(updated.constraint).toBeUndefined()
    })

    it('updates case_property on a question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const updated = mb.updateQuestion(0, 0, qpath('client_email'), { case_property: 'contact_email' })
      expect(updated.case_property).toBe('contact_email')
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.updateQuestion(0, 0, qpath('nonexistent'), { label: 'X' })).toThrow()
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
      mb.addQuestion(0, 0, { id: 'inserted', type: 'text', label: 'Inserted' }, { afterPath: qpath('client_name') })
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
      mb.removeQuestion(0, 0, qpath('client_phone'))
      const form = mb.getForm(0, 0)!
      expect(form.questions.some(q => q.id === 'client_phone')).toBe(false)
    })

    it('removes question with case_property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.removeQuestion(0, 0, qpath('client_email'))
      const form = mb.getForm(0, 0)!
      expect(form.questions.some(q => q.id === 'client_email')).toBe(false)
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.removeQuestion(0, 0, qpath('nonexistent'))).toThrow()
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

    it('rewrites #case/ refs in output tags in labels', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[1].questions.push({
        id: 'display_label',
        type: 'label',
        label: 'Updating record for: <output value="#case/email_address"/>',
      })
      const mb = new MutableBlueprint(bp)
      mb.renameCaseProperty('client', 'email_address', 'contact_email')
      const q = mb.getQuestion(0, 1, qpath('display_label'))
      expect(q!.label).toBe('Updating record for: <output value="#case/contact_email"/>')
    })

    it('rewrites #case/ refs in output tags in hints', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[1].questions.push({
        id: 'hint_q',
        type: 'text',
        label: 'Update',
        hint: 'Current: <output value="#case/full_name"/>',
      })
      const mb = new MutableBlueprint(bp)
      mb.renameCaseProperty('client', 'full_name', 'legal_name')
      const q = mb.getQuestion(0, 1, qpath('hint_q'))
      expect(q!.hint).toBe('Current: <output value="#case/legal_name"/>')
    })

    it('rewrites multiple output tags in one label', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[1].questions.push({
        id: 'multi_label',
        type: 'label',
        label: '<output value="#case/full_name"/> (<output value="#case/full_name"/>)',
      })
      const mb = new MutableBlueprint(bp)
      mb.renameCaseProperty('client', 'full_name', 'legal_name')
      const q = mb.getQuestion(0, 1, qpath('multi_label'))
      expect(q!.label).toBe('<output value="#case/legal_name"/> (<output value="#case/legal_name"/>)')
    })
  })

  describe('case type access', () => {
    it('getCaseType returns the case type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const ct = mb.getCaseType('client')
      expect(ct?.name).toBe('client')
      expect(ct?.properties.length).toBe(2)
    })

    it('getCaseType returns undefined for nonexistent case type', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.getCaseType('nonexistent')).toBeUndefined()
    })

    it('getCaseProperty returns a property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const prop = mb.getCaseProperty('client', 'full_name')
      expect(prop?.label).toBe('Full Name')
    })

    it('getCaseProperty returns undefined for nonexistent property', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(mb.getCaseProperty('client', 'nonexistent')).toBeUndefined()
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
      mb.updateQuestion(0, 0, qpath('client_name'), { label: 'CHANGED' })
      expect(original.modules[0].forms[0].questions[0].label).toEqual(originalName)
    })
  })

  describe('renameQuestion', () => {
    it('renames the question ID', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.renameQuestion(0, 0, qpath('client_name'), 'full_name_q')
      const q = mb.getQuestion(0, 0, qpath('full_name_q'))
      expect(q).toBeDefined()
      expect(q!.id).toBe('full_name_q')
    })

    it('rewrites XPath references in sibling questions', () => {
      const bp = makeBlueprint()
      // Add a question that references client_name in its relevant
      bp.modules[0].forms[0].questions.push({
        id: 'followup_q',
        type: 'text',
        label: 'Followup',
        relevant: '/data/client_name != ""',
      })
      const mb = new MutableBlueprint(bp)
      mb.renameQuestion(0, 0, qpath('client_name'), 'full_name_q')
      const q = mb.getQuestion(0, 0, qpath('followup_q'))
      expect(q!.relevant).toBe('/data/full_name_q != ""')
    })

    it('rewrites #form/ hashtag references', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[0].questions.push({
        id: 'calc_q',
        type: 'hidden',
        calculate: '#form/client_name',
      })
      const mb = new MutableBlueprint(bp)
      mb.renameQuestion(0, 0, qpath('client_name'), 'full_name_q')
      const q = mb.getQuestion(0, 0, qpath('calc_q'))
      expect(q!.calculate).toBe('#form/full_name_q')
    })

    it('updates close_case.question reference', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[1].close_case = { question: 'edit_name', answer: 'close' }
      const mb = new MutableBlueprint(bp)
      mb.renameQuestion(0, 1, qpath('edit_name'), 'renamed_name')
      const form = mb.getForm(0, 1)
      expect(form!.close_case!.question).toBe('renamed_name')
    })

    it('updates child_cases references', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[0].child_cases = [{
        case_type: 'sub',
        case_name_field: 'client_name',
        case_properties: [{ case_property: 'name', question_id: 'client_name' }],
      }]
      const mb = new MutableBlueprint(bp)
      mb.renameQuestion(0, 0, qpath('client_name'), 'full_name_q')
      const form = mb.getForm(0, 0)
      expect(form!.child_cases![0].case_name_field).toBe('full_name_q')
      expect(form!.child_cases![0].case_properties![0].question_id).toBe('full_name_q')
    })

    it('returns count of rewritten XPath fields', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[0].questions.push(
        { id: 'q1', type: 'text', relevant: '/data/client_name != ""' },
        { id: 'q2', type: 'text', calculate: '/data/client_name' },
      )
      const mb = new MutableBlueprint(bp)
      const result = mb.renameQuestion(0, 0, qpath('client_name'), 'renamed')
      expect(result.xpathFieldsRewritten).toBe(2)
    })

    it('rewrites XPath inside output tags in label', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[0].questions.push({
        id: 'summary',
        type: 'label',
        label: 'Name: <output value="#form/client_name"/>',
      })
      const mb = new MutableBlueprint(bp)
      mb.renameQuestion(0, 0, qpath('client_name'), 'full_name_q')
      const q = mb.getQuestion(0, 0, qpath('summary'))
      expect(q!.label).toBe('Name: <output value="#form/full_name_q"/>')
    })

    it('rewrites XPath inside output tags in hint', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[0].questions.push({
        id: 'age_q',
        type: 'int',
        label: 'Age',
        hint: 'Age for <output value="/data/client_name"/>',
      })
      const mb = new MutableBlueprint(bp)
      mb.renameQuestion(0, 0, qpath('client_name'), 'full_name_q')
      const q = mb.getQuestion(0, 0, qpath('age_q'))
      expect(q!.hint).toBe('Age for <output value="/data/full_name_q"/>')
    })

    it('handles nested group questions', () => {
      const bp = makeBlueprint()
      bp.modules[0].forms[0].questions = [
        {
          id: 'grp', type: 'group', children: [
            { id: 'inner_q', type: 'text', label: 'Inner' },
          ],
        },
        { id: 'outer_q', type: 'text', relevant: '/data/grp/inner_q != ""' },
      ]
      const mb = new MutableBlueprint(bp)
      mb.renameQuestion(0, 0, qpath('inner_q', qpath('grp')), 'renamed_inner')
      const q = mb.getQuestion(0, 0, qpath('outer_q'))
      expect(q!.relevant).toBe('/data/grp/renamed_inner != ""')
    })
  })

  describe('moveQuestion', () => {
    it('moves a question after another', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      // Move client_name after client_phone (currently: name, email, phone → email, phone, name)
      mb.moveQuestion(0, 0, qpath('client_name'), { afterPath: qpath('client_phone') })
      const ids = mb.getForm(0, 0)!.questions.map(q => q.id)
      expect(ids).toEqual(['client_email', 'client_phone', 'client_name'])
    })

    it('moves a question before another', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      // Move client_phone before client_name (currently: name, email, phone → phone, name, email)
      mb.moveQuestion(0, 0, qpath('client_phone'), { beforePath: qpath('client_name') })
      const ids = mb.getForm(0, 0)!.questions.map(q => q.id)
      expect(ids).toEqual(['client_phone', 'client_name', 'client_email'])
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.moveQuestion(0, 0, qpath('nonexistent'), { afterPath: qpath('client_name') })).toThrow()
    })

    it('no-ops when moving after itself', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const idsBefore = mb.getForm(0, 0)!.questions.map(q => q.id)
      mb.moveQuestion(0, 0, qpath('client_email'), { afterPath: qpath('client_email') })
      const idsAfter = mb.getForm(0, 0)!.questions.map(q => q.id)
      expect(idsAfter).toEqual(idsBefore)
    })
  })

  describe('duplicateQuestion', () => {
    it('duplicates a question with _copy suffix', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const newId = mb.duplicateQuestion(0, 0, qpath('client_name'))
      expect(newId).toBe('client_name_copy')
      const form = mb.getForm(0, 0)!
      const ids = form.questions.map(q => q.id)
      expect(ids).toContain('client_name_copy')
      // Should be right after original
      expect(ids.indexOf('client_name_copy')).toBe(ids.indexOf('client_name') + 1)
    })

    it('clears case_property on the clone', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const newId = mb.duplicateQuestion(0, 0, qpath('client_name'))
      const q = mb.getQuestion(0, 0, newId)
      expect(q!.case_property).toBeUndefined()
    })

    it('clears is_case_name on the clone', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      const newId = mb.duplicateQuestion(0, 0, qpath('client_name'))
      const q = mb.getQuestion(0, 0, newId)
      expect((q! as any).is_case_name).toBeUndefined()
    })

    it('uses numeric suffix when _copy exists', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      mb.duplicateQuestion(0, 0, qpath('client_name')) // creates client_name_copy
      const newId2 = mb.duplicateQuestion(0, 0, qpath('client_name')) // should be client_name_2
      expect(newId2).toBe('client_name_2')
    })

    it('throws for nonexistent question', () => {
      const mb = new MutableBlueprint(makeBlueprint())
      expect(() => mb.duplicateQuestion(0, 0, qpath('nonexistent'))).toThrow()
    })
  })
})
