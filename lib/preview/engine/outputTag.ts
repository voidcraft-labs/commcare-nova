/**
 * Parses and resolves dynamic references in label/hint display text.
 *
 * Two reference formats:
 * 1. <output value="#type/path"/> tags (CommCare standard, from TipTap serialization)
 *    — parsed via htmlparser2 for robust XML handling.
 * 2. Bare hashtag refs (#form/x, #case/x, #user/x) — SA-generated labels use
 *    these directly. Parsed via HASHTAG_REF_PATTERN regex.
 *
 * `resolveLabel()` is the unified entry point for the form engine — chains both
 * resolution strategies, skipping the XML parser when no output tags are present.
 */
import { parseDocument } from 'htmlparser2'
import { findAll, replaceElement } from 'domutils'
import render from 'dom-serializer'
import { Text, type Element } from 'domhandler'
import { HASHTAG_REF_PATTERN } from '@/lib/references/config'

const PARSE_OPTS = { xmlMode: true } as const
const RENDER_OPTS = { xmlMode: true, selfClosingTags: true } as const

/** Find all <output> elements in parsed display text. */
function findOutputElements(text: string): { doc: ReturnType<typeof parseDocument>; outputs: Element[] } {
  const doc = parseDocument(text, PARSE_OPTS)
  const outputs = findAll(
    (node): node is Element => node.type === 'tag' && node.name === 'output',
    doc.children,
  )
  return { doc, outputs }
}

export interface OutputTag {
  /** The XPath expression from the value attribute */
  expr: string
}

/**
 * Extract all <output value="..."/> tags from a text string.
 * Returns an empty array if the text contains no output tags.
 */
export function parseOutputTags(text: string): OutputTag[] {
  if (!text) return []
  return findOutputElements(text).outputs
    .map(el => el.attribs.value)
    .filter(Boolean)
    .map(expr => ({ expr }))
}

/**
 * Replace all <output value="..."/> tags in the text with the results
 * of evaluating each tag's XPath expression via the provided evaluator.
 */
export function resolveOutputTags(
  text: string,
  evaluator: (expr: string) => string,
): string {
  if (!text) return text

  const { doc, outputs } = findOutputElements(text)
  if (outputs.length === 0) return text

  for (const el of outputs) {
    const expr = el.attribs.value
    replaceElement(el, new Text(expr ? evaluator(expr) : ''))
  }

  return render(doc, RENDER_OPTS)
}

/**
 * Rewrite the XPath expressions inside <output value="..."/> tags.
 *
 * Parses the text, walks output elements, applies the rewriter to each
 * value attribute in-place, then serializes back.
 * Returns the original text unchanged if no rewrites occurred.
 */
export function rewriteOutputTags(
  text: string,
  rewriter: (expr: string) => string,
): string {
  if (!text) return text

  const { doc, outputs } = findOutputElements(text)
  let changed = false

  for (const el of outputs) {
    const expr = el.attribs.value
    if (!expr) continue
    const rewritten = rewriter(expr)
    if (rewritten !== expr) {
      el.attribs.value = rewritten
      changed = true
    }
  }

  return changed ? render(doc, RENDER_OPTS) : text
}

/**
 * Resolve all dynamic references in label/hint text — both <output> tags and
 * bare hashtag refs. Single entry point for the form engine's 'output' expression
 * handler. Returns undefined if the text contains no resolvable references
 * (so callers can distinguish "no refs" from "refs resolved to empty").
 */
export function resolveLabel(
  text: string | undefined,
  evaluator: (expr: string) => string,
): string | undefined {
  if (!text) return undefined
  /* Only invoke the XML parser when the text actually contains output tags —
     bare-hashtag-only labels skip the htmlparser2 overhead entirely. */
  const afterOutput = text.includes('<output') ? resolveOutputTags(text, evaluator) : text
  const afterHashtags = resolveBareHashtags(afterOutput, evaluator)
  /* Return undefined when nothing was resolved — matches the engine's convention
     where resolvedLabel is only set when the label contains dynamic refs. */
  return afterHashtags !== text ? afterHashtags : undefined
}

// ── Bare hashtag refs in label text ────────────────────────────────────

/**
 * Extract bare hashtag references (#form/x, #case/x, #user/x) from label text.
 * These are XPath expressions the SA embeds directly in labels (without <output>
 * tag wrappers). Returns them in the same OutputTag shape as parseOutputTags so
 * the DAG can register dependencies identically.
 */
export function parseBareHashtags(text: string): OutputTag[] {
  if (!text) return []
  const tags: OutputTag[] = []
  const re = new RegExp(HASHTAG_REF_PATTERN, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    tags.push({ expr: match[0] })
  }
  return tags
}

/**
 * Replace bare hashtag references in label text with their evaluated values.
 * Companion to resolveOutputTags — handles the bare-hashtag format that the SA
 * generates instead of <output> tags. Returns the text unchanged if no bare
 * hashtags are present.
 */
export function resolveBareHashtags(
  text: string,
  evaluator: (expr: string) => string,
): string {
  if (!text) return text
  return text.replace(new RegExp(HASHTAG_REF_PATTERN, 'g'), match => evaluator(match))
}
