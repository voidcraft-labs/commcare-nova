import { type QuestionPath, qpath } from './questionPath'

/** Minimal question shape for navigation — works with both Question and leaf schemas. */
interface QuestionLike {
  id: string
  type: string
  children?: QuestionLike[]
}

/**
 * Walk a question tree depth-first, returning an ordered list of QuestionPaths
 * matching the visual render order (skipping hidden questions).
 */
export function flattenQuestionPaths(questions: QuestionLike[], parent?: QuestionPath): QuestionPath[] {
  const paths: QuestionPath[] = []
  for (const q of questions) {
    if (q.type === 'hidden') continue
    const path = qpath(q.id, parent)
    paths.push(path)
    if (q.children) {
      paths.push(...flattenQuestionPaths(q.children, path))
    }
  }
  return paths
}
