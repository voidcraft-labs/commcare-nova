/**
 * Typed question tree traversal utilities.
 *
 * All functions operate directly on the recursive Question tree structure.
 * No string parsing — the tree IS the data, walk it structurally.
 */

import type { Question } from '@/lib/schemas/blueprint'

// ── Counting ──────────────────────────────────────────────────────────

/** Recursively count all questions in a tree (including nested children). */
export function countDeep(questions: Question[] | undefined): number {
  if (!questions) return 0
  let count = 0
  for (const q of questions) {
    count++
    if (q.children) count += countDeep(q.children)
  }
  return count
}

// ── Flat index computation ────────────────────────────────────────────

/**
 * Find the flat (depth-first) index of a question by its ID.
 *
 * Question IDs are unique within a form, so a bare ID search is
 * unambiguous. Walks the tree structurally — no string parsing.
 * Returns -1 if not found.
 */
export function flatIndexById(questions: Question[], id: string): number {
  let index = 0

  function walk(qs: Question[]): number {
    for (const q of qs) {
      if (q.id === id) return index
      index++
      if (q.children) {
        const found = walk(q.children)
        if (found >= 0) return found
      }
    }
    return -1
  }

  return walk(questions)
}
