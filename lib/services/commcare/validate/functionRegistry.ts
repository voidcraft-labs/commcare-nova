/**
 * CommCare XPath function name → argument count table.
 *
 * Source of truth: commcare-core's ASTNodeFunctionCall.java switch statement
 * and each function class's expectedArgCount / validateArgCount().
 *
 * -1 for maxArgs means variadic (no upper limit).
 * Special validation (e.g. cond requires odd count) is encoded via the
 * optional `validate` callback.
 */

interface FunctionSpec {
  minArgs: number
  maxArgs: number // -1 = variadic
  /** Optional custom validation. Return error string or undefined. */
  validate?: (argCount: number) => string | undefined
}

/** All known CommCare + XPath 1.0 functions with their argument constraints. */
export const FUNCTION_REGISTRY: ReadonlyMap<string, FunctionSpec> = new Map<string, FunctionSpec>([
  // ── Zero args ─────────────────────────────────────────────────────
  ['true', { minArgs: 0, maxArgs: 0 }],
  ['false', { minArgs: 0, maxArgs: 0 }],
  ['today', { minArgs: 0, maxArgs: 0 }],
  ['now', { minArgs: 0, maxArgs: 0 }],
  ['random', { minArgs: 0, maxArgs: 0 }],
  ['pi', { minArgs: 0, maxArgs: 0 }],
  ['here', { minArgs: 0, maxArgs: 0 }],
  ['last', { minArgs: 0, maxArgs: 0 }],

  // ── 0–1 args ──────────────────────────────────────────────────────
  ['uuid', { minArgs: 0, maxArgs: 1 }],
  ['position', { minArgs: 0, maxArgs: 1 }],

  // ── 0+ args (variadic) ───────────────────────────────────────────
  ['concat', { minArgs: 0, maxArgs: -1 }],

  // ── Exactly 1 arg ────────────────────────────────────────────────
  ['not', { minArgs: 1, maxArgs: 1 }],
  ['boolean', { minArgs: 1, maxArgs: 1 }],
  ['number', { minArgs: 1, maxArgs: 1 }],
  ['int', { minArgs: 1, maxArgs: 1 }],
  ['double', { minArgs: 1, maxArgs: 1 }],
  ['string', { minArgs: 1, maxArgs: 1 }],
  ['date', { minArgs: 1, maxArgs: 1 }],
  ['boolean-from-string', { minArgs: 1, maxArgs: 1 }],
  ['count', { minArgs: 1, maxArgs: 1 }],
  ['sum', { minArgs: 1, maxArgs: 1 }],
  ['count-selected', { minArgs: 1, maxArgs: 1 }],
  ['string-length', { minArgs: 1, maxArgs: 1 }],
  ['upper-case', { minArgs: 1, maxArgs: 1 }],
  ['lower-case', { minArgs: 1, maxArgs: 1 }],
  ['abs', { minArgs: 1, maxArgs: 1 }],
  ['ceiling', { minArgs: 1, maxArgs: 1 }],
  ['floor', { minArgs: 1, maxArgs: 1 }],
  ['round', { minArgs: 1, maxArgs: 1 }],
  ['log', { minArgs: 1, maxArgs: 1 }],
  ['log10', { minArgs: 1, maxArgs: 1 }],
  ['sqrt', { minArgs: 1, maxArgs: 1 }],
  ['exp', { minArgs: 1, maxArgs: 1 }],
  ['sin', { minArgs: 1, maxArgs: 1 }],
  ['cos', { minArgs: 1, maxArgs: 1 }],
  ['tan', { minArgs: 1, maxArgs: 1 }],
  ['asin', { minArgs: 1, maxArgs: 1 }],
  ['acos', { minArgs: 1, maxArgs: 1 }],
  ['atan', { minArgs: 1, maxArgs: 1 }],
  ['distinct-values', { minArgs: 1, maxArgs: 1 }],
  ['normalize-space', { minArgs: 1, maxArgs: 1 }],

  // ── 1+ args (variadic) ───────────────────────────────────────────
  ['coalesce', { minArgs: 1, maxArgs: -1 }],
  ['depend', { minArgs: 1, maxArgs: -1 }],
  ['join', { minArgs: 1, maxArgs: -1 }],
  ['min', { minArgs: 1, maxArgs: -1 }],
  ['max', { minArgs: 1, maxArgs: -1 }],

  // ── 1–2 args ──────────────────────────────────────────────────────
  ['sort', { minArgs: 1, maxArgs: 2 }],

  // ── Exactly 2 args ───────────────────────────────────────────────
  ['format-date', { minArgs: 2, maxArgs: 2 }],
  ['selected', { minArgs: 2, maxArgs: 2 }],
  ['is-selected', { minArgs: 2, maxArgs: 2 }],
  ['selected-at', { minArgs: 2, maxArgs: 2 }],
  ['substring-before', { minArgs: 2, maxArgs: 2 }],
  ['substring-after', { minArgs: 2, maxArgs: 2 }],
  ['contains', { minArgs: 2, maxArgs: 2 }],
  ['starts-with', { minArgs: 2, maxArgs: 2 }],
  ['ends-with', { minArgs: 2, maxArgs: 2 }],
  ['regex', { minArgs: 2, maxArgs: 2 }],
  ['pow', { minArgs: 2, maxArgs: 2 }],
  ['atan2', { minArgs: 2, maxArgs: 2 }],
  ['distance', { minArgs: 2, maxArgs: 2 }],
  ['checksum', { minArgs: 2, maxArgs: 2 }],
  ['index-of', { minArgs: 2, maxArgs: 2 }],
  ['sleep', { minArgs: 2, maxArgs: 2 }],
  ['json-property', { minArgs: 2, maxArgs: 2 }],
  ['closest-point-on-polygon', { minArgs: 2, maxArgs: 2 }],
  ['is-point-inside-polygon', { minArgs: 2, maxArgs: 2 }],

  // ── 2+ args (variadic) ───────────────────────────────────────────
  ['checklist', { minArgs: 2, maxArgs: -1 }],

  // ── 2–3 args ──────────────────────────────────────────────────────
  ['substr', { minArgs: 2, maxArgs: 3 }],
  ['substring', { minArgs: 2, maxArgs: 3 }],
  ['sort-by', { minArgs: 2, maxArgs: 3 }],
  ['format-date-for-calendar', { minArgs: 2, maxArgs: 3 }],

  // ── Exactly 3 args ───────────────────────────────────────────────
  ['if', { minArgs: 3, maxArgs: 3 }],
  ['translate', { minArgs: 3, maxArgs: 3 }],
  ['replace', { minArgs: 3, maxArgs: 3 }],
  ['encrypt-string', { minArgs: 3, maxArgs: 3 }],
  ['decrypt-string', { minArgs: 3, maxArgs: 3 }],

  // ── 3+ args (variadic with special rules) ─────────────────────────
  ['cond', {
    minArgs: 3,
    maxArgs: -1,
    validate: (n) => n % 2 !== 1 ? 'cond() requires an odd number of arguments (test1, val1, ..., default)' : undefined,
  }],
  ['join-chunked', { minArgs: 3, maxArgs: -1 }],

  // ── Special arg counts ────────────────────────────────────────────
  ['id-compress', { minArgs: 5, maxArgs: 5 }],
  ['weighted-checklist', {
    minArgs: 2,
    maxArgs: -1,
    validate: (n) => n < 2 || n % 2 !== 0 ? 'weighted-checklist() requires an even number of arguments (min, max, bool1, weight1, ...)' : undefined,
  }],
])

/** Case-insensitive lookup for suggesting corrections (e.g. "Today" → "today"). */
export function findCaseInsensitiveMatch(name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of FUNCTION_REGISTRY.keys()) {
    if (key.toLowerCase() === lower) return key
  }
  return undefined
}
