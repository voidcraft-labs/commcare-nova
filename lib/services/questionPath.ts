/** Slash-delimited path identifying a question's position in the tree. e.g. "group1/child_q" or "top_level_q" */
export type QuestionPath = string & { readonly __brand: 'QuestionPath' }

/** Build a path by appending a child ID to a parent path. */
export function qpath(id: string, parent?: QuestionPath): QuestionPath {
  return (parent ? `${parent}/${id}` : id) as QuestionPath
}

/** Extract the bare ID (last segment) from a path. */
export function qpathId(path: QuestionPath): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

/** Extract the parent path, or undefined for top-level. */
export function qpathParent(path: QuestionPath): QuestionPath | undefined {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? undefined : path.slice(0, idx) as QuestionPath
}
