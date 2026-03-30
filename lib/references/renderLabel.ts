/**
 * Label and expression parsing utilities for the chip reference system.
 *
 * Provides segment parsing (splitting text into plain text + reference matches)
 * and reference resolution for building React component trees with ReferenceChip
 * nodes. Used by LabelContent, ExpressionContent, and RefLabelInput.
 */

import { HASHTAG_REF_PATTERN } from './config'
import { ReferenceProvider } from './provider'
import type { Reference } from './types'
import type { QuestionPath } from '@/lib/services/questionPath'

/** Matches <output value="#type/path"/> tags in label text. */
export const OUTPUT_TAG_RE = /<output\s+value="(#(?:form|user|case)\/[\w.\/]+)"\/>/

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
 * Parse a label string into segments of plain text and <output> tag references.
 * Used by LabelContent (chip display) and RefLabelInput (TipTap hydration).
 */
export function parseLabelSegments(label: string): LabelSegment[] {
  return splitOnPattern(label, OUTPUT_TAG_RE, m => m[1])
}

/**
 * Parse an XPath expression into segments of plain text and hashtag references.
 * Used by ExpressionContent for rendering chips in calculate/default expressions.
 */
export function parseExpressionSegments(expr: string): LabelSegment[] {
  return splitOnPattern(expr, HASHTAG_REF_PATTERN, m => m[0])
}

/**
 * Resolve a parsed expression string to a Reference. Tries the provider first
 * for full resolution (with question type icon), falls back to a minimal
 * Reference from parse() when the provider is unavailable or the ref is stale.
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
