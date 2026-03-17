import type { XPathValue } from './types'

/** XPath 1.0 type coercion: value → number */
export function toNumber(v: XPathValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const trimmed = (v as string).trim()
  if (trimmed === '') return NaN
  const n = Number(trimmed)
  return n
}

/** XPath 1.0 type coercion: value → string */
export function toString(v: XPathValue): string {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Number.isNaN(v)) return 'NaN'
  // Integers display without decimals
  if (Number.isInteger(v)) return String(v)
  return String(v)
}

/** XPath 1.0 type coercion: value → boolean */
export function toBoolean(v: XPathValue): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  return (v as string).length > 0
}

/**
 * XPath 1.0 equality comparison.
 * If either operand is boolean → compare as booleans.
 * If either operand is number → compare as numbers.
 * Otherwise compare as strings.
 */
export function compareEqual(a: XPathValue, b: XPathValue): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return toBoolean(a) === toBoolean(b)
  if (typeof a === 'number' || typeof b === 'number') return toNumber(a) === toNumber(b)
  return toString(a) === toString(b)
}

/**
 * XPath 1.0 relational comparison (for <, <=, >, >=).
 * Compares as numbers.
 */
export function compareRelational(a: XPathValue, b: XPathValue, op: '<' | '<=' | '>' | '>='): boolean {
  const na = toNumber(a)
  const nb = toNumber(b)
  switch (op) {
    case '<': return na < nb
    case '<=': return na <= nb
    case '>': return na > nb
    case '>=': return na >= nb
  }
}
