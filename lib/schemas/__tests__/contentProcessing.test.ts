import { describe, it, expect } from 'vitest'
import { applyDefaults } from '../contentProcessing'
import type { CaseType } from '../blueprint'

const testCaseType: CaseType = {
  name: 'patient',
  properties: [
    { name: 'case_name', label: 'Full Name' },
    { name: 'age', label: 'Patient Age', data_type: 'int', required: 'true()', validation: '. > 0 and . < 150', validation_msg: 'Age must be between 1 and 149' },
    { name: 'gender', label: 'Gender', data_type: 'single_select', options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }] },
    { name: 'phone', label: 'Phone Number', data_type: 'phone', hint: 'Include country code' },
  ],
}

describe('applyDefaults', () => {
  it('fills in label from case type for sparse question', () => {
    const result = applyDefaults({ id: 'case_name', type: 'text', is_case_property: true }, testCaseType)
    expect(result.label).toBe('Full Name')
  })

  it('preserves explicit label when provided', () => {
    const result = applyDefaults({ id: 'case_name', type: 'text', label: 'Custom Label', is_case_property: true }, testCaseType)
    expect(result.label).toBe('Custom Label')
  })

  it('fills in validation, required, and validation_msg', () => {
    const result = applyDefaults({ id: 'age', type: 'int', is_case_property: true }, testCaseType)
    expect(result.required).toBe('true()')
    expect(result.validation).toBe('. > 0 and . < 150')
    expect(result.validation_msg).toBe('Age must be between 1 and 149')
  })

  it('fills in options for select properties', () => {
    const result = applyDefaults({ id: 'gender', type: 'single_select', is_case_property: true }, testCaseType)
    expect(result.options).toEqual([{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }])
  })

  it('fills in hint from case type', () => {
    const result = applyDefaults({ id: 'phone', type: 'phone', is_case_property: true }, testCaseType)
    expect(result.hint).toBe('Include country code')
  })

  it('derives type from case type data_type', () => {
    const result = applyDefaults({ id: 'age', is_case_property: true }, testCaseType)
    expect(result.type).toBe('int')
  })

  it('returns question unchanged when no is_case_property', () => {
    const result = applyDefaults({ id: 'notes', type: 'text', label: 'Notes' }, testCaseType)
    expect(result.label).toBe('Notes')
    expect(result.hint).toBeUndefined()
  })

  it('returns question unchanged when case type is null', () => {
    const result = applyDefaults({ id: 'case_name', type: 'text', is_case_property: true }, null)
    expect(result.label).toBeUndefined()
  })

  it('returns question unchanged when property not found in case type', () => {
    const result = applyDefaults({ id: 'nonexistent', type: 'text', is_case_property: true }, testCaseType)
    expect(result.label).toBeUndefined()
  })

  it('unescapes HTML entities in XPath fields', () => {
    const result = applyDefaults({ id: 'x', type: 'text', validation: '. &gt; 0 &amp;&amp; . &lt; 10' }, null)
    expect(result.validation).toBe('. > 0 && . < 10')
  })
})
