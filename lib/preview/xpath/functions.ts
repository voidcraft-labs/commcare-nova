import type { XPathValue } from './types'
import { toNumber, toString, toBoolean } from './coerce'

type XPathFn = (args: XPathValue[]) => XPathValue

/** Registry of supported XPath/CommCare functions. */
const registry = new Map<string, XPathFn>()

function register(name: string, fn: XPathFn) {
  registry.set(name, fn)
}

export function getFunction(name: string): XPathFn | undefined {
  return registry.get(name)
}

// ── Boolean / Logic ──────────────────────────────────────────────────

register('true', () => true)
register('false', () => false)
register('not', (args) => !toBoolean(args[0] ?? ''))
register('boolean', (args) => toBoolean(args[0] ?? ''))

// ── CommCare if() — if(cond, then, else) ────────────────────────────

register('if', (args) => {
  const cond = toBoolean(args[0] ?? '')
  return cond ? (args[1] ?? '') : (args[2] ?? '')
})

// ── Type conversion ─────────────────────────────────────────────────

register('string', (args) => toString(args[0] ?? ''))
register('number', (args) => toNumber(args[0] ?? ''))
register('int', (args) => {
  const n = toNumber(args[0] ?? '')
  return Number.isNaN(n) ? NaN : Math.trunc(n)
})
register('round', (args) => {
  const n = toNumber(args[0] ?? '')
  const decimals = args.length > 1 ? toNumber(args[1]!) : 0
  if (Number.isNaN(n)) return NaN
  const factor = Math.pow(10, decimals)
  return Math.round(n * factor) / factor
})

// ── String functions ────────────────────────────────────────────────

register('concat', (args) => args.map(a => toString(a)).join(''))
register('string-length', (args) => toString(args[0] ?? '').length)
register('contains', (args) => toString(args[0] ?? '').includes(toString(args[1] ?? '')))
register('starts-with', (args) => toString(args[0] ?? '').startsWith(toString(args[1] ?? '')))
register('normalize-space', (args) => toString(args[0] ?? '').trim().replace(/\s+/g, ' '))
register('translate', (args) => {
  const str = toString(args[0] ?? '')
  const from = toString(args[1] ?? '')
  const to = toString(args[2] ?? '')
  let result = ''
  for (const ch of str) {
    const idx = from.indexOf(ch)
    if (idx === -1) result += ch
    else if (idx < to.length) result += to[idx]
    // else: character is removed (no replacement)
  }
  return result
})
register('substr', (args) => {
  const str = toString(args[0] ?? '')
  // CommCare substr is 0-based: substr(string, start, end?)
  const start = Math.max(0, toNumber(args[1] ?? 0))
  if (args.length > 2) {
    const end = toNumber(args[2]!)
    return str.substring(start, end)
  }
  return str.substring(start)
})
register('join', (args) => {
  // join(separator, ...items)
  const sep = toString(args[0] ?? '')
  return args.slice(1).map(a => toString(a)).join(sep)
})

// ── CommCare selected() — multi-select check ────────────────────────

register('selected', (args) => {
  const value = toString(args[0] ?? '')
  const option = toString(args[1] ?? '')
  return value.split(' ').includes(option)
})
register('count-selected', (args) => {
  const value = toString(args[0] ?? '').trim()
  if (value === '') return 0
  return value.split(' ').length
})

// ── Coalesce ────────────────────────────────────────────────────────

register('coalesce', (args) => {
  for (const a of args) {
    const s = toString(a)
    if (s !== '') return s
  }
  return ''
})

// ── Math ────────────────────────────────────────────────────────────

register('ceiling', (args) => Math.ceil(toNumber(args[0] ?? '')))
register('floor', (args) => Math.floor(toNumber(args[0] ?? '')))
register('abs', (args) => Math.abs(toNumber(args[0] ?? '')))
register('pow', (args) => Math.pow(toNumber(args[0] ?? 0), toNumber(args[1] ?? 0)))
register('min', (args) => Math.min(...args.map(a => toNumber(a))))
register('max', (args) => Math.max(...args.map(a => toNumber(a))))

// ── Aggregate (count, sum — operate on nodeset approximation) ───────

register('count', (args) => {
  // In preview, count() of a path returns the repeat count or 0/1
  // This is handled as a number pass-through from the evaluator
  return toNumber(args[0] ?? 0)
})
register('sum', (args) => {
  // Simple pass-through — sum of scalar
  return toNumber(args[0] ?? 0)
})

// ── Position / Size ─────────────────────────────────────────────────
// These are handled directly by the evaluator via context.position/size
// but we register stubs so they don't error when called as functions.
register('position', () => 1)
register('last', () => 1)

// ── Date / Time ─────────────────────────────────────────────────────

register('today', () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})
register('now', () => new Date().toISOString())
register('date', (args) => {
  // date(days) → date string from epoch, or date(string) → passthrough
  const v = args[0] ?? ''
  if (typeof v === 'number' || !Number.isNaN(Number(v))) {
    const days = toNumber(v)
    const ms = days * 86400000
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return toString(v)
})
register('format-date', (args) => {
  // format-date(date, format) — simplified implementation
  const dateStr = toString(args[0] ?? '')
  const format = toString(args[1] ?? '%Y-%m-%d')
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return format
    .replace('%Y', String(d.getFullYear()))
    .replace('%m', String(d.getMonth() + 1).padStart(2, '0'))
    .replace('%d', String(d.getDate()).padStart(2, '0'))
    .replace('%H', String(d.getHours()).padStart(2, '0'))
    .replace('%M', String(d.getMinutes()).padStart(2, '0'))
    .replace('%S', String(d.getSeconds()).padStart(2, '0'))
    .replace('%e', String(d.getDate()))
})

// ── Misc ────────────────────────────────────────────────────────────

register('uuid', () => crypto.randomUUID())
register('regex', (args) => {
  try {
    const str = toString(args[0] ?? '')
    const pattern = toString(args[1] ?? '')
    return new RegExp(pattern).test(str)
  } catch {
    return false
  }
})
register('instance', () => '')
