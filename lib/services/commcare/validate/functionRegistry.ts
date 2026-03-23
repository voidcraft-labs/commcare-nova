/**
 * CommCare XPath function registry — argument counts, return types, parameter types.
 *
 * Source of truth for arities: commcare-core's ASTNodeFunctionCall.java
 * Source of truth for types: XPath 1.0 spec + CommCare runtime behavior
 *
 * -1 for maxArgs means variadic (no upper limit).
 */

/** XPath 1.0 types + 'any' for unknowable/polymorphic contexts. */
export type XPathType = 'string' | 'number' | 'boolean' | 'nodeset' | 'any'

export interface FunctionSpec {
  minArgs: number
  maxArgs: number
  returnType: XPathType
  /** Positional parameter types. Omit for variadic or all-any functions. */
  paramTypes?: XPathType[]
  /** Optional custom arity validation. Return error string or undefined. */
  validate?: (argCount: number) => string | undefined
}

// Shorthand constructors for common patterns
const num = (minArgs: number, maxArgs: number, paramTypes?: XPathType[]): FunctionSpec =>
  ({ minArgs, maxArgs, returnType: 'number', paramTypes })
const str = (minArgs: number, maxArgs: number, paramTypes?: XPathType[]): FunctionSpec =>
  ({ minArgs, maxArgs, returnType: 'string', paramTypes })
const bool = (minArgs: number, maxArgs: number, paramTypes?: XPathType[]): FunctionSpec =>
  ({ minArgs, maxArgs, returnType: 'boolean', paramTypes })
const any = (minArgs: number, maxArgs: number, paramTypes?: XPathType[]): FunctionSpec =>
  ({ minArgs, maxArgs, returnType: 'any', paramTypes })

/** All known CommCare + XPath 1.0 functions. */
export const FUNCTION_REGISTRY: ReadonlyMap<string, FunctionSpec> = new Map<string, FunctionSpec>([
  // ── Constants ─────────────────────────────────────────────────────
  ['true',   bool(0, 0)],
  ['false',  bool(0, 0)],
  ['pi',     num(0, 0)],

  // ── Date/Time (dates are numbers internally — days since epoch) ──
  ['today',  num(0, 0)],
  ['now',    num(0, 0)],
  ['date',   num(1, 1)],  // string → date-as-number
  ['format-date', str(2, 2, ['number', 'string'])],
  ['format-date-for-calendar', str(2, 3, ['number', 'string'])],

  // ── Type conversion ───────────────────────────────────────────────
  ['boolean',             bool(1, 1)],   // any → boolean (explicit cast)
  ['number',              num(1, 1)],    // any → number (explicit cast)
  ['int',                 num(1, 1)],    // any → integer
  ['double',              num(1, 1)],    // any → double
  ['string',              str(1, 1)],    // any → string (explicit cast)
  ['boolean-from-string', bool(1, 1)],   // string → boolean

  // ── Boolean / Logic ───────────────────────────────────────────────
  ['not', bool(1, 1, ['boolean'])],

  // ── Numeric (1 arg) ───────────────────────────────────────────────
  ['abs',     num(1, 1, ['number'])],
  ['ceiling', num(1, 1, ['number'])],
  ['floor',   num(1, 1, ['number'])],
  ['round',   num(1, 1, ['number'])],
  ['log',     num(1, 1, ['number'])],
  ['log10',   num(1, 1, ['number'])],
  ['sqrt',    num(1, 1, ['number'])],
  ['exp',     num(1, 1, ['number'])],
  ['sin',     num(1, 1, ['number'])],
  ['cos',     num(1, 1, ['number'])],
  ['tan',     num(1, 1, ['number'])],
  ['asin',    num(1, 1, ['number'])],
  ['acos',    num(1, 1, ['number'])],
  ['atan',    num(1, 1, ['number'])],

  // ── Numeric (2 args) ──────────────────────────────────────────────
  ['pow',   num(2, 2, ['number', 'number'])],
  ['atan2', num(2, 2, ['number', 'number'])],

  // ── String functions ──────────────────────────────────────────────
  ['string-length',   num(1, 1, ['string'])],
  ['upper-case',      str(1, 1, ['string'])],
  ['lower-case',      str(1, 1, ['string'])],
  ['normalize-space',  str(1, 1, ['string'])],
  ['contains',        bool(2, 2, ['string', 'string'])],
  ['starts-with',     bool(2, 2, ['string', 'string'])],
  ['ends-with',       bool(2, 2, ['string', 'string'])],
  ['substring-before', str(2, 2, ['string', 'string'])],
  ['substring-after',  str(2, 2, ['string', 'string'])],
  ['translate',       str(3, 3, ['string', 'string', 'string'])],
  ['replace',         str(3, 3, ['string', 'string', 'string'])],
  ['substr',          str(2, 3, ['string', 'number'])],
  ['substring',       str(2, 3, ['string', 'number'])],
  ['regex',           bool(2, 2, ['string', 'string'])],

  // ── Nodeset / Aggregation ─────────────────────────────────────────
  ['count',     num(1, 1)],
  ['sum',       num(1, 1)],
  ['position',  num(0, 1)],
  ['last',      num(0, 0)],

  // ── Multi-select helpers ──────────────────────────────────────────
  ['selected',       bool(2, 2, ['string', 'string'])],
  ['is-selected',    bool(2, 2, ['string', 'string'])],
  ['count-selected', num(1, 1, ['string'])],
  ['selected-at',    str(2, 2, ['string', 'number'])],

  // ── Variadic (all-any params) ─────────────────────────────────────
  ['concat',   str(0, -1)],
  ['join',     str(1, -1)],
  ['join-chunked', str(3, -1)],
  ['coalesce', any(1, -1)],
  ['depend',   any(1, -1)],
  ['min',      num(1, -1)],
  ['max',      num(1, -1)],

  // ── Conditionals (polymorphic return) ─────────────────────────────
  ['if', { ...any(3, 3, ['boolean']), returnType: 'any' }],
  ['cond', {
    ...any(3, -1),
    validate: (n) => n % 2 !== 1 ? 'cond() requires an odd number of arguments (test1, val1, ..., default)' : undefined,
  }],

  // ── Volatile ──────────────────────────────────────────────────────
  ['random', num(0, 0)],
  ['uuid',   str(0, 1)],
  ['here',   str(0, 0)],

  // ── Geo ───────────────────────────────────────────────────────────
  ['distance',                  num(2, 2, ['string', 'string'])],
  ['closest-point-on-polygon',  str(2, 2, ['string', 'string'])],
  ['is-point-inside-polygon',   bool(2, 2, ['string', 'string'])],

  // ── Sort / Collection ─────────────────────────────────────────────
  ['sort',            str(1, 2)],
  ['sort-by',         str(2, 3)],
  ['distinct-values', str(1, 1)],
  ['index-of',        num(2, 2, ['string', 'string'])],

  // ── Checklist ─────────────────────────────────────────────────────
  ['checklist', bool(2, -1)],
  ['weighted-checklist', {
    ...bool(2, -1),
    validate: (n) => n < 2 || n % 2 !== 0 ? 'weighted-checklist() requires an even number of arguments (min, max, bool1, weight1, ...)' : undefined,
  }],

  // ── Crypto / Utility ──────────────────────────────────────────────
  ['checksum',       str(2, 2, ['string', 'string'])],
  ['encrypt-string', str(3, 3, ['string', 'string', 'string'])],
  ['decrypt-string', str(3, 3, ['string', 'string', 'string'])],
  ['json-property',  str(2, 2, ['string', 'string'])],
  ['id-compress',    str(5, 5)],
  ['sleep',          any(2, 2, ['number', 'number'])],
])

/** Case-insensitive lookup for suggesting corrections (e.g. "Today" → "today"). */
export function findCaseInsensitiveMatch(name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of FUNCTION_REGISTRY.keys()) {
    if (key.toLowerCase() === lower) return key
  }
  return undefined
}
