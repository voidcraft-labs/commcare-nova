/**
 * Label and expression parsing utilities for the chip reference system.
 *
 * Provides segment parsing (splitting text into plain text + reference matches)
 * and reference resolution for building React component trees with ReferenceChip
 * nodes. Used by ExpressionContent, RefLabelInput, and LabelContent.
 */

import { HASHTAG_REF_PATTERN } from './config'
import { ReferenceProvider } from './provider'
import type { Reference } from './types'
import type { QuestionPath } from '@/lib/services/questionPath'

/** Matches <output value="#type/path"/> tags in label text. */
export const OUTPUT_TAG_RE = /<output\s+value="(#(?:form|user|case)\/[\w.\/]+)"\/>/

/**
 * Unified pattern matching both <output value="#type/path"/> tags and bare
 * #type/path hashtags. Composed from OUTPUT_TAG_RE and HASHTAG_REF_PATTERN
 * so the path syntax stays in sync. Group 1 captures the ref from an output
 * tag, group 2 captures a bare hashtag. Without `g` flag — consumers create
 * global copies.
 */
export const LABEL_REF_RE = new RegExp(
  `(?:${OUTPUT_TAG_RE.source})|(${HASHTAG_REF_PATTERN.source})`,
)

/**
 * Normalize `<output value="#type/path"/>` tags to bare `#type/path` hashtags.
 * Used by rendering surfaces (LabelContent, InlineTextEditor) to convert the
 * CommCare serialization format back to the canonical hashtag format before
 * display or editing. markdown-to-jsx would parse `<output>` as an HTML element
 * (bypassing the text-node chip renderRule), and tiptap-markdown delegates
 * ref hydration to `hydrateHashtagRefs()` which operates on bare hashtags.
 */
export function outputTagsToHashtags(text: string): string {
  return text.replace(new RegExp(OUTPUT_TAG_RE.source, 'g'), '$1')
}

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
 * Parse a label string into segments of plain text and reference matches.
 * Handles both <output value="#type/path"/> tags (from TipTap serialization)
 * and bare #type/path hashtags (from SA-generated labels). The extracted
 * value is always the canonical #type/path string regardless of source format.
 * Used by RefLabelInput for TipTap document hydration.
 */
export function parseLabelSegments(label: string): LabelSegment[] {
  return splitOnPattern(label, LABEL_REF_RE, m => m[1] ?? m[2])
}

/**
 * Parse an XPath expression into segments of plain text and hashtag references.
 * Used by ExpressionContent for rendering chips in calculate/default expressions.
 */
export function parseExpressionSegments(expr: string): LabelSegment[] {
  return splitOnPattern(expr, HASHTAG_REF_PATTERN, m => m[0])
}

/**
 * Resolve a parsed expression string to a Reference. When a provider is
 * available, only returns a Reference if it actually resolves — unresolvable
 * hashtags (typos, partial edits, stale refs) return null so they render as
 * plain text instead of misleading chips. Falls back to pattern-based parsing
 * only when no provider is available (e.g. during initial load before the
 * provider context is ready).
 */
export function resolveRefFromExpr(expr: string, provider: ReferenceProvider | null): Reference | null {
  if (provider) {
    return provider.resolve(expr)
  }
  const parsed = ReferenceProvider.parse(expr)
  if (!parsed) return null
  return parsed.type === 'form'
    ? { type: 'form', path: parsed.path as QuestionPath, label: parsed.path, raw: expr }
    : { type: parsed.type, path: parsed.path, label: parsed.path, raw: expr }
}
