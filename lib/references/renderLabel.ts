/**
 * Label and expression parsing utilities for the chip reference system.
 *
 * Provides segment parsing (splitting text into plain text + reference matches)
 * and reference resolution for building React component trees with ReferenceChip
 * nodes. Used by ExpressionContent, RefLabelInput, LabelContent, and AppTree.
 *
 * All internal label text uses bare `#type/path` hashtags as the canonical
 * format.
 */

import { HASHTAG_REF_PATTERN } from './config'
import { ReferenceProvider } from './provider'
import type { Reference } from './types'
import type { QuestionPath } from '@/lib/services/questionPath'

/** A segment from splitting text on a reference-matching pattern. */
export type LabelSegment = { kind: 'text'; text: string } | { kind: 'ref'; value: string }

/**
 * Split text into alternating text and reference segments based on a regex.
 * The pattern must not have the `g` flag — a global copy is created internally
 * to avoid shared mutable `lastIndex` state. `extractValue` maps each regex
 * match to the string stored in the ref segment.
 */
export function splitOnPattern(
  text: string,
  pattern: RegExp,
  extractValue: (match: RegExpExecArray) => string,
): LabelSegment[] {
  const segments: LabelSegment[] = []
  const globalPattern = new RegExp(pattern, 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = globalPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
    }
    segments.push({ kind: 'ref', value: extractValue(match) })
    lastIndex = globalPattern.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) })
  }

  return segments
}

/**
 * Parse text into segments of plain text and `#type/path` hashtag references.
 * Used by RefLabelInput (TipTap hydration), LabelContent (markdown chip rule),
 * ExpressionContent (calculate/default chips), and AppTree (sidebar chips).
 */
export function parseLabelSegments(text: string): LabelSegment[] {
  return splitOnPattern(text, HASHTAG_REF_PATTERN, m => m[0])
}

/**
 * Resolve a parsed expression string to a Reference. Tries the provider first
 * for a rich resolution (with question label, icon, etc.). Falls back to
 * pattern-based parsing when the provider can't resolve — this happens when no
 * form is selected (structure sidebar on initial load), or when the ref targets
 * a different form than the currently selected one. The fallback produces a
 * valid Reference with the path as the label, which is enough to render a chip.
 */
export function resolveRefFromExpr(expr: string, provider: ReferenceProvider | null): Reference | null {
  if (provider) {
    const resolved = provider.resolve(expr)
    if (resolved) return resolved
  }
  const parsed = ReferenceProvider.parse(expr)
  if (!parsed) return null
  return parsed.type === 'form'
    ? { type: 'form', path: parsed.path as QuestionPath, label: parsed.path, raw: expr }
    : { type: parsed.type, path: parsed.path, label: parsed.path, raw: expr }
}
