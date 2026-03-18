import { describe, it, expect } from 'vitest'
import { flattenQuestionIds } from '../questionNavigation'

// Use plain objects — the function only reads id, type, and children
type Q = { id: string; type: string; children?: Q[] }

describe('flattenQuestionIds', () => {
  it('returns flat list for simple questions', () => {
    const questions: Q[] = [
      { id: 'q1', type: 'text' },
      { id: 'q2', type: 'int' },
      { id: 'q3', type: 'date' },
    ]
    expect(flattenQuestionIds(questions)).toEqual(['q1', 'q2', 'q3'])
  })

  it('skips hidden questions', () => {
    const questions: Q[] = [
      { id: 'q1', type: 'text' },
      { id: 'h1', type: 'hidden' },
      { id: 'q2', type: 'text' },
    ]
    expect(flattenQuestionIds(questions)).toEqual(['q1', 'q2'])
  })

  it('includes group/repeat IDs and recurses into children', () => {
    const questions: Q[] = [
      { id: 'q1', type: 'text' },
      {
        id: 'grp', type: 'group', children: [
          { id: 'child1', type: 'text' },
          { id: 'child2', type: 'int' },
        ],
      },
      { id: 'q2', type: 'text' },
    ]
    expect(flattenQuestionIds(questions)).toEqual(['q1', 'grp', 'child1', 'child2', 'q2'])
  })

  it('handles nested groups', () => {
    const questions: Q[] = [
      {
        id: 'outer', type: 'group', children: [
          {
            id: 'inner', type: 'repeat', children: [
              { id: 'deep', type: 'text' },
            ],
          },
        ],
      },
    ]
    expect(flattenQuestionIds(questions)).toEqual(['outer', 'inner', 'deep'])
  })

  it('returns empty array for empty questions', () => {
    expect(flattenQuestionIds([])).toEqual([])
  })
})
