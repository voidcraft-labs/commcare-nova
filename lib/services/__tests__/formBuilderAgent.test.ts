/**
 * Tests for the form builder agent's tool integration with MutableBlueprint.
 *
 * These are unit tests that exercise the tool executors directly (no LLM calls).
 * They verify that the form builder's addQuestion, setCloseCaseCondition, and
 * addChildCase tools correctly modify the MutableBlueprint shell.
 */
import { describe, it, expect } from 'vitest'
import { MutableBlueprint } from '../mutableBlueprint'
import { qpath } from '../questionPath'
import type { AppBlueprint, Question } from '../../schemas/blueprint'

/** Create a minimal shell blueprint for form builder testing. */
function makeShell(type: 'registration' | 'followup' | 'survey' = 'registration'): AppBlueprint {
  return {
    app_name: 'Test App',
    modules: [{
      name: 'Test Module',
      case_type: type !== 'survey' ? 'patient' : undefined,
      forms: [{ name: 'Test Form', type, questions: [] }],
    }],
    case_types: type !== 'survey'
      ? [{ name: 'patient', case_name_property: 'full_name', properties: [{ name: 'full_name', label: 'Full Name' }] }]
      : null,
  }
}

describe('Form Builder Agent Integration', () => {
  describe('addQuestion', () => {
    it('adds a simple text question', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, {
        id: 'patient_name',
        type: 'text',
        label: 'Patient Name',
        case_property: 'full_name',
        is_case_name: true,
      })

      const form = mb.getForm(0, 0)!
      expect(form.questions).toHaveLength(1)
      expect(form.questions[0].id).toBe('patient_name')
      expect(form.questions[0].type).toBe('text')
      expect(form.questions[0].case_property).toBe('full_name')
      expect(form.questions[0].is_case_name).toBe(true)
      // Only explicitly set fields are present
      expect(form.questions[0].hint).toBeUndefined()
      expect(form.questions[0].required).toBeUndefined()
      expect(form.questions[0].options).toBeUndefined()
    })

    it('adds questions in sequence', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'q1', type: 'text', label: 'Q1' })
      mb.addQuestion(0, 0, { id: 'q2', type: 'int', label: 'Q2' })
      mb.addQuestion(0, 0, { id: 'q3', type: 'date', label: 'Q3' })

      const form = mb.getForm(0, 0)!
      expect(form.questions.map(q => q.id)).toEqual(['q1', 'q2', 'q3'])
    })

    it('adds a single_select question with options', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, {
        id: 'gender',
        type: 'single_select',
        label: 'Gender',
        options: [
          { value: 'male', label: 'Male' },
          { value: 'female', label: 'Female' },
        ],
        case_property: 'gender',
      })

      const form = mb.getForm(0, 0)!
      const q = form.questions[0]
      expect(q.options).toHaveLength(2)
      expect(q.options![0].value).toBe('male')
    })

    it('adds a hidden calculated question', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'age', type: 'int', label: 'Age' })
      mb.addQuestion(0, 0, {
        id: 'age_group',
        type: 'hidden',
        calculate: "if(/data/age < 18, 'child', 'adult')",
        case_property: 'age_group',
      })

      const form = mb.getForm(0, 0)!
      const q = form.questions.find(q => q.id === 'age_group')!
      expect(q.type).toBe('hidden')
      expect(q.calculate).toBe("if(/data/age < 18, 'child', 'adult')")
      expect(q.label).toBeUndefined() // hidden questions have no label
    })

    it('nests questions inside a group', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'demographics', type: 'group', label: 'Demographics' })
      mb.addQuestion(0, 0, { id: 'first_name', type: 'text', label: 'First Name' }, { parentPath: qpath('demographics') })
      mb.addQuestion(0, 0, { id: 'last_name', type: 'text', label: 'Last Name' }, { parentPath: qpath('demographics') })

      const form = mb.getForm(0, 0)!
      expect(form.questions).toHaveLength(1)
      expect(form.questions[0].id).toBe('demographics')
      expect(form.questions[0].children).toHaveLength(2)
      expect(form.questions[0].children![0].id).toBe('first_name')
      expect(form.questions[0].children![1].id).toBe('last_name')
    })

    it('nests questions inside a repeat', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'household_members', type: 'repeat', label: 'Household Members' })
      mb.addQuestion(0, 0, { id: 'member_name', type: 'text', label: 'Member Name' }, { parentPath: qpath('household_members') })
      mb.addQuestion(0, 0, { id: 'member_age', type: 'int', label: 'Age' }, { parentPath: qpath('household_members') })

      const form = mb.getForm(0, 0)!
      const repeat = form.questions[0]
      expect(repeat.type).toBe('repeat')
      expect(repeat.children).toHaveLength(2)
    })

    it('inserts after a specific question', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'q1', type: 'text', label: 'Q1' })
      mb.addQuestion(0, 0, { id: 'q3', type: 'text', label: 'Q3' })
      mb.addQuestion(0, 0, { id: 'q2', type: 'text', label: 'Q2' }, { afterPath: qpath('q1') })

      const form = mb.getForm(0, 0)!
      expect(form.questions.map(q => q.id)).toEqual(['q1', 'q2', 'q3'])
    })

    it('adds a question with relevant condition', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'has_symptoms', type: 'single_select', label: 'Has Symptoms?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] })
      mb.addQuestion(0, 0, { id: 'symptom_details', type: 'text', label: 'Describe symptoms', relevant: "/data/has_symptoms = 'yes'" })

      const form = mb.getForm(0, 0)!
      const q = form.questions.find(q => q.id === 'symptom_details')!
      expect(q.relevant).toBe("/data/has_symptoms = 'yes'")
    })
  })

  describe('setCloseCaseCondition', () => {
    it('sets unconditional close_case', () => {
      const mb = new MutableBlueprint(makeShell('followup'))
      mb.updateForm(0, 0, { close_case: {} })

      const form = mb.getForm(0, 0)!
      expect(form.close_case).toEqual({})
    })

    it('sets conditional close_case', () => {
      const mb = new MutableBlueprint(makeShell('followup'))
      mb.addQuestion(0, 0, { id: 'discharge', type: 'single_select', label: 'Discharge?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] })
      mb.updateForm(0, 0, { close_case: { question: 'discharge', answer: 'yes' } })

      const form = mb.getForm(0, 0)!
      expect(form.close_case).toEqual({ question: 'discharge', answer: 'yes' })
    })
  })

  describe('addChildCase', () => {
    it('adds a child case', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'referral_name', type: 'text', label: 'Referral Name' })
      mb.addChildCase(0, 0, {
        case_type: 'referral',
        case_name_field: 'referral_name',
        case_properties: [{ case_property: 'referral_reason', question_id: 'referral_name' }],
      })

      const form = mb.getForm(0, 0)!
      expect(form.child_cases).toHaveLength(1)
      expect(form.child_cases![0].case_type).toBe('referral')
      expect(form.child_cases![0].case_name_field).toBe('referral_name')
    })

    it('adds multiple child cases', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, { id: 'name1', type: 'text', label: 'Name 1' })
      mb.addQuestion(0, 0, { id: 'name2', type: 'text', label: 'Name 2' })
      mb.addChildCase(0, 0, { case_type: 'child_a', case_name_field: 'name1' })
      mb.addChildCase(0, 0, { case_type: 'child_b', case_name_field: 'name2' })

      const form = mb.getForm(0, 0)!
      expect(form.child_cases).toHaveLength(2)
    })

    it('throws for nonexistent form', () => {
      const mb = new MutableBlueprint(makeShell())
      expect(() => mb.addChildCase(0, 5, { case_type: 'x', case_name_field: 'y' })).toThrow()
    })
  })

  describe('complete form shape', () => {
    it('produces a valid BlueprintForm-shaped result', () => {
      const mb = new MutableBlueprint(makeShell())
      mb.addQuestion(0, 0, {
        id: 'patient_name',
        type: 'text',
        label: 'Patient Name',
        required: 'true()',
        case_property: 'full_name',
        is_case_name: true,
      })
      mb.addQuestion(0, 0, {
        id: 'patient_age',
        type: 'int',
        label: 'Age',
        validation: '. > 0 and . < 150',
        validation_msg: 'Age must be between 1 and 149',
        case_property: 'age',
      })
      mb.addQuestion(0, 0, {
        id: 'vitals',
        type: 'group',
        label: 'Vital Signs',
      })
      mb.addQuestion(0, 0, {
        id: 'temperature',
        type: 'decimal',
        label: 'Temperature (°C)',
        case_property: 'temperature',
      }, { parentPath: qpath('vitals') })

      const form = mb.getForm(0, 0)!
      expect(form.name).toBe('Test Form')
      expect(form.type).toBe('registration')
      expect(form.questions).toHaveLength(3) // patient_name, patient_age, vitals (with child)
      expect(form.questions[2].children).toHaveLength(1)

      // Verify required fields are always present, optional fields only when set
      for (const q of form.questions) {
        expect(q).toHaveProperty('id')
        expect(q).toHaveProperty('type')
        // label is set on all these questions
        expect(q).toHaveProperty('label')
      }
    })
  })
})
