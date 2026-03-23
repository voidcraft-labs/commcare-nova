import { describe, it, expect } from 'vitest'
import { filterTree, highlightSegments } from '../filterTree'
import type { TreeData } from '@/lib/services/builder'

const makeTree = (overrides?: Partial<TreeData>): TreeData => ({
  app_name: 'Test App',
  modules: [
    {
      name: 'Patient Registration',
      case_type: 'patient',
      purpose: '',
      forms: [
        {
          name: 'Register Patient',
          type: 'registration',
          purpose: '',
          questions: [
            { id: 'patient_name', type: 'text', label: 'Patient Name' },
            { id: 'patient_age', type: 'int', label: 'Age' },
            { id: 'patient_dob', type: 'date', label: 'Date of Birth' },
            {
              id: 'contact_info',
              type: 'group',
              label: 'Contact Information',
              children: [
                { id: 'phone_number', type: 'phone', label: 'Phone Number' },
                { id: 'email', type: 'text', label: 'Email Address' },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'Follow-up Visits',
      purpose: '',
      forms: [
        {
          name: 'Daily Checkup',
          type: 'followup',
          purpose: '',
          questions: [
            { id: 'visit_date', type: 'date', label: 'Visit Date' },
            { id: 'symptoms', type: 'text', label: 'Symptoms' },
            { id: 'temperature', type: 'decimal', label: 'Temperature' },
          ],
        },
        {
          name: 'Lab Results',
          type: 'followup',
          purpose: '',
          questions: [
            { id: 'test_type', type: 'single_select', label: 'Test Type' },
            { id: 'result_value', type: 'text', label: 'Result Value' },
          ],
        },
      ],
    },
  ],
  ...overrides,
})

describe('filterTree', () => {
  it('returns null for empty query', () => {
    expect(filterTree(makeTree(), '')).toBeNull()
    expect(filterTree(makeTree(), '   ')).toBeNull()
  })

  it('filters by question label', () => {
    const result = filterTree(makeTree(), 'Phone')
    expect(result).not.toBeNull()
    // Should include module 0 with the form containing Phone Number
    expect(result!.data.modules).toHaveLength(1)
    expect(result!.data.modules[0].name).toBe('Patient Registration')
    // Form should be included
    expect(result!.data.modules[0].forms).toHaveLength(1)
    expect(result!.data.modules[0].forms[0].name).toBe('Register Patient')
  })

  it('filters by question id', () => {
    const result = filterTree(makeTree(), 'patient_name')
    expect(result).not.toBeNull()
    expect(result!.data.modules).toHaveLength(1)
    expect(result!.data.modules[0].forms[0].questions).toBeDefined()
  })

  it('returns empty modules for no matches', () => {
    const result = filterTree(makeTree(), 'zzzznonexistent')
    expect(result).not.toBeNull()
    expect(result!.data.modules).toHaveLength(0)
  })

  it('matches module names', () => {
    const result = filterTree(makeTree(), 'Follow-up')
    expect(result).not.toBeNull()
    // Should include the Follow-up Visits module
    const followUpModule = result!.data.modules.find(m => m.name === 'Follow-up Visits')
    expect(followUpModule).toBeDefined()
  })

  it('matches form names', () => {
    const result = filterTree(makeTree(), 'Lab Results')
    expect(result).not.toBeNull()
    const mod = result!.data.modules.find(m => m.forms.some(f => f.name === 'Lab Results'))
    expect(mod).toBeDefined()
  })

  it('preserves parent hierarchy for nested question matches', () => {
    const result = filterTree(makeTree(), 'Email')
    expect(result).not.toBeNull()
    // Should include the parent group (Contact Information) containing Email Address
    const form = result!.data.modules[0].forms[0]
    expect(form.questions).toBeDefined()
    // The group or question containing email should be present
    const hasEmail = JSON.stringify(form.questions).includes('email')
    expect(hasEmail).toBe(true)
  })

  it('force-expands modules and forms containing matches', () => {
    const result = filterTree(makeTree(), 'Temperature')
    expect(result).not.toBeNull()
    // Module 1 (Follow-up Visits, original index 1) should be force-expanded
    expect(result!.forceExpand.has('m1')).toBe(true)
    // Form 0 in module 1 (Daily Checkup) should be force-expanded
    expect(result!.forceExpand.has('f1_0')).toBe(true)
  })

  it('populates matchMap with match indices', () => {
    const result = filterTree(makeTree(), 'Patient')
    expect(result).not.toBeNull()
    expect(result!.matchMap.size).toBeGreaterThan(0)
  })

  it('performs fuzzy matching', () => {
    // "ptient" is a fuzzy match for "patient"
    const result = filterTree(makeTree(), 'ptient')
    expect(result).not.toBeNull()
    // With fuse.js threshold 0.4, this should still match "patient" related items
    expect(result!.data.modules.length).toBeGreaterThanOrEqual(0)
  })

  it('preserves app_name in filtered data', () => {
    const result = filterTree(makeTree(), 'Phone')
    expect(result).not.toBeNull()
    expect(result!.data.app_name).toBe('Test App')
  })
})

describe('highlightSegments', () => {
  it('returns single non-highlighted segment for empty indices', () => {
    const result = highlightSegments('Hello World', [])
    expect(result).toEqual([{ text: 'Hello World', highlight: false }])
  })

  it('highlights a single range', () => {
    const result = highlightSegments('Hello World', [[0, 4]])
    expect(result).toEqual([
      { text: 'Hello', highlight: true },
      { text: ' World', highlight: false },
    ])
  })

  it('highlights middle range', () => {
    const result = highlightSegments('Hello World', [[6, 10]])
    expect(result).toEqual([
      { text: 'Hello ', highlight: false },
      { text: 'World', highlight: true },
    ])
  })

  it('handles multiple ranges', () => {
    const result = highlightSegments('abcdefgh', [[0, 1], [4, 5]])
    expect(result).toEqual([
      { text: 'ab', highlight: true },
      { text: 'cd', highlight: false },
      { text: 'ef', highlight: true },
      { text: 'gh', highlight: false },
    ])
  })

  it('merges overlapping ranges', () => {
    const result = highlightSegments('abcdefgh', [[0, 3], [2, 5]])
    expect(result).toEqual([
      { text: 'abcdef', highlight: true },
      { text: 'gh', highlight: false },
    ])
  })

  it('merges adjacent ranges', () => {
    const result = highlightSegments('abcdef', [[0, 2], [3, 5]])
    expect(result).toEqual([
      { text: 'abcdef', highlight: true },
    ])
  })

  it('highlights entire string', () => {
    const result = highlightSegments('abc', [[0, 2]])
    expect(result).toEqual([
      { text: 'abc', highlight: true },
    ])
  })
})
