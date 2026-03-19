import { describe, it, expect } from 'vitest'
import { extractBlueprint } from '../useClaudeCode'

describe('extractBlueprint', () => {
  it('extracts valid blueprint from json code block', () => {
    const text = 'Here is your app:\n```json\n{"app_name":"Test","modules":[],"case_types":null}\n```'
    expect(extractBlueprint(text)).toEqual({ app_name: 'Test', modules: [], case_types: null })
  })
  it('returns null when no json block', () => {
    expect(extractBlueprint('just some text')).toBeNull()
  })
  it('returns null when json block has no app_name', () => {
    expect(extractBlueprint('```json\n{"foo":"bar"}\n```')).toBeNull()
  })
  it('picks first valid blueprint from multiple blocks', () => {
    const text = '```json\n{"bad":true}\n```\n```json\n{"app_name":"X","modules":[]}\n```'
    expect(extractBlueprint(text)?.app_name).toBe('X')
  })
})
