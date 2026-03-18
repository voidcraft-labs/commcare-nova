/**
 * Parses and resolves <output value="..."/> tags in display text.
 *
 * CommCare output tags embed XPath expressions in labels and hints:
 *   "Updating record for: <output value="#case/client_name"/>"
 *
 * Uses htmlparser2 for typed XML node traversal — works server and client side.
 */
import { parseDocument } from 'htmlparser2'
import { findAll, replaceElement } from 'domutils'
import render from 'dom-serializer'
import { Text, Element as HtmlElement, type Element } from 'domhandler'

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

/** Evaluator return: plain string, or a styled element with text + CSS class. */
export type ResolvedOutput = string | { text: string; className: string }

/**
 * Replace all <output value="..."/> tags in the text with the results
 * of evaluating each tag's XPath expression via the provided evaluator.
 *
 * When the evaluator returns `{ text, className }`, a styled `<span>` is
 * created instead of a plain text node — used for unresolved case ref badges.
 */
export function resolveOutputTags(
  text: string,
  evaluator: (expr: string) => ResolvedOutput,
): string {
  if (!text) return text

  const { doc, outputs } = findOutputElements(text)
  if (outputs.length === 0) return text

  for (const el of outputs) {
    const expr = el.attribs.value
    const result = expr ? evaluator(expr) : ''
    if (typeof result === 'string') {
      replaceElement(el, new Text(result))
    } else {
      replaceElement(el, new HtmlElement('span', { class: result.className }, [new Text(result.text)]))
    }
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
