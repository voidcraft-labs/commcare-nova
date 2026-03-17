/**
 * Parses and resolves <output value="..."/> tags in display text.
 *
 * CommCare output tags embed XPath expressions in labels and hints:
 *   "Updating record for: <output value="#case/client_name"/>"
 * The tag is replaced with the evaluated result of the XPath expression.
 */

const OUTPUT_TAG_RE = /<output\s+value=["']([^"']*)["']\s*\/>/g

export interface OutputTag {
  /** The entire <output .../> tag text */
  fullMatch: string
  /** The XPath expression from the value attribute */
  expr: string
}

/**
 * Extract all <output value="..."/> tags from a text string.
 * Returns an empty array if the text contains no output tags.
 */
export function parseOutputTags(text: string): OutputTag[] {
  if (!text) return []
  return [...text.matchAll(OUTPUT_TAG_RE)].map(m => ({
    fullMatch: m[0],
    expr: m[1],
  }))
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
  return text.replace(OUTPUT_TAG_RE, (_, expr: string) => evaluator(expr))
}
