/** Minimal question shape for navigation — works with both Question and leaf schemas. */
interface QuestionLike {
  id: string
  type: string
  children?: QuestionLike[]
}

/**
 * Walk a question tree depth-first, returning an ordered list of IDs
 * matching the visual render order (skipping hidden questions).
 */
export function flattenQuestionIds(questions: QuestionLike[]): string[] {
  const ids: string[] = []
  for (const q of questions) {
    if (q.type === 'hidden') continue
    ids.push(q.id)
    if (q.children) {
      ids.push(...flattenQuestionIds(q.children))
    }
  }
  return ids
}
