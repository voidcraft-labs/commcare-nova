import { describe, it, expect } from 'vitest'
import { extractBlueprint, extractQuestion } from '../useClaudeCode'

const COMPLETE_BP = {
  app_name: 'Test',
  modules: [{
    name: 'Patients',
    case_type: 'patient',
    forms: [{
      name: 'Register',
      type: 'registration',
      questions: [{ id: 'name', type: 'text', label: 'Name', is_case_name: true }],
    }],
  }],
  case_types: [{ name: 'patient', case_name_property: 'name', properties: [{ name: 'name', label: 'Name' }] }],
}

describe('extractBlueprint', () => {
  it('extracts a complete blueprint from json code block', () => {
    const text = 'Here is your app:\n```json\n' + JSON.stringify(COMPLETE_BP) + '\n```'
    const bp = extractBlueprint(text)
    expect(bp?.app_name).toBe('Test')
    expect(bp?.modules[0].forms[0].questions).toHaveLength(1)
  })

  it('returns null when no json block', () => {
    expect(extractBlueprint('just some text')).toBeNull()
  })

  it('returns null when json block has no app_name', () => {
    expect(extractBlueprint('```json\n{"foo":"bar"}\n```')).toBeNull()
  })

  it('returns null for empty modules (incomplete blueprint)', () => {
    const text = '```json\n{"app_name":"X","modules":[]}\n```'
    expect(extractBlueprint(text)).toBeNull()
  })

  it('returns null for modules without questions (schema example, not a blueprint)', () => {
    const text = '```json\n{"app_name":"X","modules":[{"name":"M","forms":[{"name":"F","type":"registration","questions":[]}]}]}\n```'
    expect(extractBlueprint(text)).toBeNull()
  })

  it('extracts from multiple blocks, picking the complete one', () => {
    const text = '```json\n{"bad":true}\n```\n```json\n' + JSON.stringify(COMPLETE_BP) + '\n```'
    expect(extractBlueprint(text)?.app_name).toBe('Test')
  })
})

describe('extractQuestion', () => {
  it('extracts a structured question from a question code block', () => {
    const text = 'Some context\n```question\n{"header":"About the app","question":"What type?","options":[{"label":"A"},{"label":"B"}]}\n```'
    const q = extractQuestion(text)
    expect(q?.header).toBe('About the app')
    expect(q?.question).toBe('What type?')
    expect(q?.options).toHaveLength(2)
  })

  it('returns null when no question block', () => {
    expect(extractQuestion('just text')).toBeNull()
  })

  it('returns null when options has fewer than 2 items', () => {
    const text = '```question\n{"question":"Q","options":[{"label":"A"}]}\n```'
    expect(extractQuestion(text)).toBeNull()
  })
})
