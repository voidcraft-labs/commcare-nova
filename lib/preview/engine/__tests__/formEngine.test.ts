import { describe, it, expect } from 'vitest'
import { FormEngine } from '../formEngine'
import type { BlueprintForm, CaseType } from '@/lib/schemas/blueprint'

function makeForm(questions: BlueprintForm['questions'], type: BlueprintForm['type'] = 'registration'): BlueprintForm {
  return { name: 'Test Form', type, questions }
}

const sampleCaseTypes: CaseType[] = [{
  name: 'patient',
  properties: [
    { name: 'case_name', label: 'Full Name' },
    { name: 'age', label: 'Age', data_type: 'int' },
    { name: 'risk_level', label: 'Risk Level', data_type: 'single_select', options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ]},
  ],
}]

describe('FormEngine', () => {
  it('initializes with question states', () => {
    const form = makeForm([
      { id: 'name', type: 'text', label: 'Name' },
      { id: 'age', type: 'int', label: 'Age' },
    ])
    const engine = new FormEngine(form, null)

    expect(engine.getState('/data/name').visible).toBe(true)
    expect(engine.getState('/data/name').value).toBe('')
    expect(engine.getState('/data/age').visible).toBe(true)
  })

  it('sets and gets values', () => {
    const form = makeForm([
      { id: 'name', type: 'text', label: 'Name' },
    ])
    const engine = new FormEngine(form, null)

    engine.setValue('/data/name', 'Alice')
    expect(engine.getState('/data/name').value).toBe('Alice')
  })

  describe('relevant (visibility)', () => {
    it('hides questions when relevant evaluates to false', () => {
      const form = makeForm([
        { id: 'has_children', type: 'single_select', label: 'Has children?', options: [
          { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' },
        ]},
        { id: 'num_children', type: 'int', label: 'How many?', relevant: '/data/has_children = "yes"' },
      ])
      const engine = new FormEngine(form, null)

      // Initially visible (relevant evaluates with empty value → false for comparison)
      expect(engine.getState('/data/num_children').visible).toBe(false)

      engine.setValue('/data/has_children', 'yes')
      expect(engine.getState('/data/num_children').visible).toBe(true)

      engine.setValue('/data/has_children', 'no')
      expect(engine.getState('/data/num_children').visible).toBe(false)
    })
  })

  describe('calculate', () => {
    it('computes calculated values', () => {
      const form = makeForm([
        { id: 'weight', type: 'decimal', label: 'Weight (kg)' },
        { id: 'height', type: 'decimal', label: 'Height (m)' },
        { id: 'bmi', type: 'hidden', calculate: '/data/weight div (/data/height * /data/height)' },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/weight', '70')
      engine.setValue('/data/height', '1.75')

      const bmi = parseFloat(engine.getState('/data/bmi').value)
      expect(bmi).toBeCloseTo(22.86, 1)
    })
  })

  describe('validation', () => {
    it('validates on value change', () => {
      const form = makeForm([
        { id: 'age', type: 'int', label: 'Age', validation: '. > 0 and . < 150', validation_msg: 'Must be 1-149' },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/age', '25')
      expect(engine.getState('/data/age').valid).toBe(true)

      engine.setValue('/data/age', '-1')
      expect(engine.getState('/data/age').valid).toBe(false)
      expect(engine.getState('/data/age').errorMessage).toBe('Must be 1-149')
    })
  })

  describe('required', () => {
    it('marks statically required questions', () => {
      const form = makeForm([
        { id: 'name', type: 'text', label: 'Name', required: 'true()' },
        { id: 'notes', type: 'text', label: 'Notes' },
      ])
      const engine = new FormEngine(form, null)

      expect(engine.getState('/data/name').required).toBe(true)
      expect(engine.getState('/data/notes').required).toBe(false)
    })
  })

  describe('questions are self-contained', () => {
    it('uses question labels directly without case_types merge', () => {
      const form = makeForm([
        { id: 'case_name', type: 'text', label: 'Patient Name', case_property_on: 'patient' },
        { id: 'age', type: 'int', label: 'Age', case_property_on: 'patient' },
      ])
      const engine = new FormEngine(form, sampleCaseTypes, 'patient')
      const questions = engine.getQuestions()

      expect(questions[0].label).toBe('Patient Name')
      expect(questions[1].label).toBe('Age')
    })
  })

  describe('followup form preloading', () => {
    it('pre-populates case data into the instance', () => {
      const form = makeForm([
        { id: 'case_name', type: 'text', case_property_on: 'patient' },
        { id: 'age', type: 'int', case_property_on: 'patient' },
      ], 'followup')

      const caseData = new Map([['case_name', 'Alice'], ['age', '30']])
      const engine = new FormEngine(form, sampleCaseTypes, 'patient', caseData)

      expect(engine.getState('/data/case_name').value).toBe('Alice')
      expect(engine.getState('/data/age').value).toBe('30')
    })
  })

  describe('default_value', () => {
    it('applies default values on init', () => {
      const form = makeForm([
        { id: 'visit_date', type: 'date', label: 'Visit Date', default_value: 'today()' },
      ])
      const engine = new FormEngine(form, null)

      expect(engine.getState('/data/visit_date').value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('overrides preloaded case data with default_value on followup forms', () => {
      const form = makeForm([
        { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient', default_value: "concat(#case/age, ' - ', #case/case_name)" },
      ], 'followup')
      const caseData = new Map([['case_name', 'Alice'], ['age', '30']])
      const engine = new FormEngine(form, sampleCaseTypes, 'patient', caseData)

      // default_value should win over case preload
      expect(engine.getState('/data/case_name').value).toBe('30 - Alice')
    })

    it('overrides preloaded case data after reset()', () => {
      const form = makeForm([
        { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient', default_value: "concat(#case/age, ' - ', #case/case_name)" },
      ], 'followup')
      const caseData = new Map([['case_name', 'Alice'], ['age', '30']])
      const engine = new FormEngine(form, sampleCaseTypes, 'patient', caseData)

      engine.setValue('/data/case_name', 'user typed this')
      engine.reset()
      expect(engine.getState('/data/case_name').value).toBe('30 - Alice')
    })
  })

  describe('restoreValues', () => {
    it('restores only user-touched values, preserving new defaults', () => {
      // Simulate engine recreation: old engine had a default, user touched a different field
      const form = makeForm([
        { id: 'greeting', type: 'text', label: 'Greeting', default_value: "'hello'" },
        { id: 'name', type: 'text', label: 'Name' },
      ])
      const engine = new FormEngine(form, null)
      expect(engine.getState('/data/greeting').value).toBe('hello')

      // User types in the name field (touched), doesn't touch greeting
      engine.setValue('/data/name', 'Alice')
      engine.touch('/data/name')
      const snapshot = engine.getValueSnapshot()

      // Simulate engine recreation with updated default
      const updatedForm = makeForm([
        { id: 'greeting', type: 'text', label: 'Greeting', default_value: "'goodbye'" },
        { id: 'name', type: 'text', label: 'Name' },
      ])
      const newEngine = new FormEngine(updatedForm, null)
      expect(newEngine.getState('/data/greeting').value).toBe('goodbye')

      // Restore snapshot — only touched values restored, new default kept
      newEngine.restoreValues(snapshot)
      expect(newEngine.getState('/data/name').value).toBe('Alice')
      expect(newEngine.getState('/data/greeting').value).toBe('goodbye')
    })

    it('does not overwrite new defaults with stale untouched values', () => {
      const form = makeForm([
        { id: 'status', type: 'text', label: 'Status', default_value: "'active'" },
      ])
      const engine = new FormEngine(form, null)
      expect(engine.getState('/data/status').value).toBe('active')

      // Snapshot includes the default-computed value but field was never touched
      const snapshot = engine.getValueSnapshot()
      expect(snapshot.values.get('/data/status')).toBe('active')
      expect(snapshot.touched.has('/data/status')).toBe(false)

      // New engine with different default
      const updatedForm = makeForm([
        { id: 'status', type: 'text', label: 'Status', default_value: "'archived'" },
      ])
      const newEngine = new FormEngine(updatedForm, null)
      newEngine.restoreValues(snapshot)

      // New default should win — stale 'active' should not overwrite 'archived'
      expect(newEngine.getState('/data/status').value).toBe('archived')
    })
  })

  describe('groups', () => {
    it('handles nested group questions', () => {
      const form = makeForm([
        {
          id: 'demographics', type: 'group', label: 'Demographics',
          children: [
            { id: 'name', type: 'text', label: 'Name' },
            { id: 'age', type: 'int', label: 'Age' },
          ],
        },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/demographics/name', 'Bob')
      expect(engine.getState('/data/demographics/name').value).toBe('Bob')
    })
  })

  describe('touch (blur validation)', () => {
    it('marks field as touched — required validation deferred to submit', () => {
      const form = makeForm([
        { id: 'name', type: 'text', label: 'Name', required: 'true()' },
      ])
      const engine = new FormEngine(form, null)

      // Not touched yet — valid despite being empty
      expect(engine.getState('/data/name').touched).toBe(false)
      expect(engine.getState('/data/name').valid).toBe(true)

      // Touch marks as touched but does NOT run required validation (deferred to submit)
      engine.touch('/data/name')
      expect(engine.getState('/data/name').touched).toBe(true)
      expect(engine.getState('/data/name').valid).toBe(true)

      // Submit triggers required validation
      expect(engine.validateAll()).toBe(false)
      expect(engine.getState('/data/name').valid).toBe(false)
      expect(engine.getState('/data/name').errorMessage).toBe('This field is required')

      // Filling the value clears the error
      engine.setValue('/data/name', 'Alice')
      expect(engine.validateAll()).toBe(true)
      expect(engine.getState('/data/name').valid).toBe(true)
    })

    it('runs validation on touch when field has a value', () => {
      const form = makeForm([
        { id: 'age', type: 'int', label: 'Age', validation: '. > 0', validation_msg: 'Must be positive' },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/age', '-5')
      // setValue runs validation, so it's already invalid
      expect(engine.getState('/data/age').valid).toBe(false)

      // But touch also runs it
      engine.touch('/data/age')
      expect(engine.getState('/data/age').touched).toBe(true)
      expect(engine.getState('/data/age').valid).toBe(false)
      expect(engine.getState('/data/age').errorMessage).toBe('Must be positive')
    })
  })

  describe('validateAll (submit validation)', () => {
    it('marks all visible required empty fields as invalid', () => {
      const form = makeForm([
        { id: 'name', type: 'text', label: 'Name', required: 'true()' },
        { id: 'email', type: 'text', label: 'Email', required: 'true()' },
        { id: 'notes', type: 'text', label: 'Notes' },
      ])
      const engine = new FormEngine(form, null)

      const valid = engine.validateAll()
      expect(valid).toBe(false)
      expect(engine.getState('/data/name').valid).toBe(false)
      expect(engine.getState('/data/name').touched).toBe(true)
      expect(engine.getState('/data/email').valid).toBe(false)
      expect(engine.getState('/data/notes').valid).toBe(true)
    })

    it('returns true when all required fields are filled', () => {
      const form = makeForm([
        { id: 'name', type: 'text', label: 'Name', required: 'true()' },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/name', 'Alice')
      expect(engine.validateAll()).toBe(true)
    })

    it('skips hidden (not visible) fields', () => {
      const form = makeForm([
        { id: 'toggle', type: 'single_select', label: 'Show?', options: [
          { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' },
        ]},
        { id: 'conditional', type: 'text', label: 'Details', required: 'true()', relevant: '/data/toggle = "yes"' },
      ])
      const engine = new FormEngine(form, null)

      // conditional is not visible (toggle is empty) so it should not cause validation failure
      engine.setValue('/data/toggle', 'no')
      expect(engine.validateAll()).toBe(true)
    })
  })

  describe('subscription', () => {
    it('notifies subscribers on value change', () => {
      const form = makeForm([{ id: 'name', type: 'text', label: 'Name' }])
      const engine = new FormEngine(form, null)

      let called = false
      engine.subscribe(() => { called = true })

      engine.setValue('/data/name', 'Test')
      expect(called).toBe(true)
    })

    it('allows unsubscribing', () => {
      const form = makeForm([{ id: 'name', type: 'text', label: 'Name' }])
      const engine = new FormEngine(form, null)

      let callCount = 0
      const unsub = engine.subscribe(() => { callCount++ })

      engine.setValue('/data/name', 'A')
      expect(callCount).toBe(1)

      unsub()
      engine.setValue('/data/name', 'B')
      expect(callCount).toBe(1)
    })
  })

  describe('output tags', () => {
    it('resolves output tags in labels with #case refs', () => {
      const form = makeForm([
        { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient' },
        { id: 'greeting', type: 'label', label: 'Hello, <output value="#case/case_name"/>!' },
      ], 'followup')
      const caseData = new Map([['case_name', 'John Smith']])
      const engine = new FormEngine(form, sampleCaseTypes, 'patient', caseData)

      expect(engine.getState('/data/greeting').resolvedLabel).toBe('Hello, John Smith!')
    })

    it('resolves output tags referencing form fields', () => {
      const form = makeForm([
        { id: 'name', type: 'text', label: 'Name' },
        { id: 'summary', type: 'label', label: 'You entered: <output value="#form/name"/>' },
      ])
      const engine = new FormEngine(form, null)

      // Initially empty
      expect(engine.getState('/data/summary').resolvedLabel).toBe('You entered: ')

      // After setting a value, the label updates reactively
      engine.setValue('/data/name', 'Alice')
      expect(engine.getState('/data/summary').resolvedLabel).toBe('You entered: Alice')
    })

    it('resolves multiple output tags in one label', () => {
      const form = makeForm([
        { id: 'first', type: 'text', label: 'First' },
        { id: 'last', type: 'text', label: 'Last' },
        { id: 'display', type: 'label', label: '<output value="#form/first"/> <output value="#form/last"/>' },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/first', 'Jane')
      engine.setValue('/data/last', 'Doe')
      expect(engine.getState('/data/display').resolvedLabel).toBe('Jane Doe')
    })

    it('resolves output tags in hints', () => {
      const form = makeForm([
        { id: 'name', type: 'text', label: 'Name' },
        { id: 'age', type: 'int', label: 'Age', hint: 'Age for <output value="#form/name"/>' },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/name', 'Bob')
      expect(engine.getState('/data/age').resolvedHint).toBe('Age for Bob')
    })

    it('cascades through calculated fields into output tags', () => {
      const form = makeForm([
        { id: 'age', type: 'int', label: 'Age' },
        { id: 'status', type: 'hidden', calculate: "if(/data/age > 18, 'Adult', 'Minor')" },
        { id: 'info', type: 'label', label: 'Status: <output value="#form/status"/>' },
      ])
      const engine = new FormEngine(form, null)

      engine.setValue('/data/age', '25')
      expect(engine.getState('/data/info').resolvedLabel).toBe('Status: Adult')

      engine.setValue('/data/age', '10')
      expect(engine.getState('/data/info').resolvedLabel).toBe('Status: Minor')
    })

    it('does not set resolvedLabel when no output tags present', () => {
      const form = makeForm([
        { id: 'name', type: 'text', label: 'Plain label' },
      ])
      const engine = new FormEngine(form, null)

      expect(engine.getState('/data/name').resolvedLabel).toBeUndefined()
    })
  })
})
