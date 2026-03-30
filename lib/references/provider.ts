/**
 * ReferenceProvider — unified API for searching and resolving hashtag references.
 *
 * Wraps the existing blueprint resolution functions into a single interface
 * consumed by both CodeMirror chip decorations and TipTap suggestion/autocomplete.
 *
 * Uses the same `getContext` getter pattern as the XPath linter and autocomplete
 * so it always reads from the live blueprint state without triggering re-renders.
 */

import type { XPathLintContext } from '@/lib/codemirror/xpath-lint'
import type { Question } from '@/lib/schemas/blueprint'
import { collectCaseProperties } from '@/lib/services/commcare/validate/index'
import { questionTypeIcons } from '@/lib/questionTypeIcons'
import { qpath, type QuestionPath } from '@/lib/services/questionPath'
import { REFERENCE_TYPES } from './config'
import type { Reference, ReferenceType } from './types'

/** User properties with human-readable labels — single source of truth. */
export const USER_PROPERTIES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'username', label: 'Username' },
  { name: 'first_name', label: 'First Name' },
  { name: 'last_name', label: 'Last Name' },
  { name: 'phone_number', label: 'Phone Number' },
]

const VALID_TYPES = new Set<ReferenceType>(REFERENCE_TYPES)

/**
 * Recursively collect question entries (path + label) from a question tree.
 * Exported so the CM6 autocomplete can reuse the same tree walk.
 */
export function collectQuestionEntries(
  questions: Question[],
  parent?: QuestionPath,
): Array<{ path: QuestionPath; label: string; questionType: string }> {
  const entries: Array<{ path: QuestionPath; label: string; questionType: string }> = []
  for (const q of questions) {
    const path = qpath(q.id, parent)
    entries.push({ path, label: q.label ?? path, questionType: q.type })
    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      entries.push(...collectQuestionEntries(q.children, path))
    }
  }
  return entries
}

export class ReferenceProvider {
  /**
   * Cached case property set + labels. Avoids repeated full blueprint traversals
   * when MatchDecorator calls resolve() per viewport match. Callers must call
   * invalidate() when the blueprint changes.
   */
  private caseCache: {
    props: Set<string> | undefined
    labels: Map<string, string>
  } | null = null

  /**
   * Cached form question entries + path lookup. Avoids repeated recursive tree
   * walks in both search() (per keystroke in autocomplete) and resolve() (per
   * MatchDecorator hit in the viewport).
   */
  private formCache: {
    entries: Array<{ path: QuestionPath; label: string; questionType: string }>
    byPath: Map<string, { label: string; questionType: string }>
  } | null = null

  constructor(private getContext: () => XPathLintContext | undefined) {}

  /** Clear cached data. Call when the blueprint or selection changes. */
  invalidate(): void {
    this.caseCache = null
    this.formCache = null
  }

  /**
   * Search references by type, filtered by a partial path query.
   * Powers autocomplete in both CodeMirror and TipTap surfaces.
   */
  search(type: ReferenceType, query: string): Reference[] {
    const lowerQuery = query.toLowerCase()

    if (type === 'user') {
      return USER_PROPERTIES
        .filter(p => p.name.includes(lowerQuery) || p.label.toLowerCase().includes(lowerQuery))
        .map(p => ({ type: 'user', path: p.name, label: p.label, raw: `#user/${p.name}` }))
    }

    const ctx = this.getContext()
    if (!ctx) return []

    if (type === 'form') {
      const cache = this.ensureFormCache(ctx)
      return cache.entries
        .filter(e => e.path.includes(lowerQuery) || e.label.toLowerCase().includes(lowerQuery))
        .map(e => ({
          type: 'form' as const, path: e.path, label: e.label, raw: `#form/${e.path}`,
          icon: questionTypeIcons[e.questionType],
        }))
    }

    if (type === 'case') {
      return this.searchCaseProperties(ctx, lowerQuery)
    }

    return []
  }

  /**
   * Resolve a canonical "#type/path" string to a Reference with label.
   * Returns null if the format doesn't match or the reference doesn't
   * exist in the current blueprint context.
   */
  resolve(raw: string): Reference | null {
    const parsed = ReferenceProvider.parse(raw)
    if (!parsed) return null

    const { type, path } = parsed

    if (type === 'user') {
      const prop = USER_PROPERTIES.find(p => p.name === path)
      if (!prop) return null
      return { type, path, label: prop.label, raw }
    }

    const ctx = this.getContext()
    if (!ctx) return null

    if (type === 'form') {
      /* Parsing boundary: path from "#form/group1/age" is a QuestionPath. */
      const questionPath = path as QuestionPath
      const cache = this.ensureFormCache(ctx)
      const found = cache.byPath.get(path)
      if (!found) return null
      return {
        type, path: questionPath, raw,
        label: found.label ?? path,
        icon: questionTypeIcons[found.questionType],
      }
    }

    if (type === 'case') {
      const cache = this.ensureCaseCache(ctx)
      if (!cache.props?.has(path)) return null
      const label = cache.labels.get(path) ?? path
      return { type, path, label, raw }
    }

    return null
  }

  /**
   * Parse a raw "#type/path" string into its namespace and path components.
   * Pure string parsing — no blueprint lookup. The path is a plain string;
   * callers construct the appropriate Reference variant with the correct
   * path type (QuestionPath for form, string for case/user).
   */
  static parse(raw: string): { type: ReferenceType; path: string } | null {
    if (!raw.startsWith('#')) return null
    const slashIdx = raw.indexOf('/')
    if (slashIdx < 0) return null
    const type = raw.slice(1, slashIdx)
    if (!VALID_TYPES.has(type as ReferenceType)) return null
    const path = raw.slice(slashIdx + 1)
    if (!path) return null
    return { type: type as ReferenceType, path }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /** Build the form question cache if not already populated. One tree walk
   *  serves both search() (needs entries array) and resolve() (needs path lookup). */
  private ensureFormCache(ctx: XPathLintContext) {
    if (this.formCache) return this.formCache
    const entries = collectQuestionEntries(ctx.form.questions ?? [])
    const byPath = new Map<string, { label: string; questionType: string }>()
    for (const e of entries) {
      byPath.set(e.path, { label: e.label, questionType: e.questionType })
    }
    this.formCache = { entries, byPath }
    return this.formCache
  }

  /** Build the case property cache if not already populated. */
  private ensureCaseCache(ctx: XPathLintContext) {
    if (this.caseCache) return this.caseCache

    const props = collectCaseProperties(ctx.blueprint, ctx.moduleCaseType)
    const labels = new Map<string, string>()

    if (ctx.moduleCaseType && props) {
      const caseType = ctx.blueprint.case_types?.find(ct => ct.name === ctx.moduleCaseType)
      if (caseType?.properties) {
        for (const p of caseType.properties) {
          if (props.has(p.name) && p.label) labels.set(p.name, p.label)
        }
      }
    }

    this.caseCache = { props, labels }
    return this.caseCache
  }

  private searchCaseProperties(ctx: XPathLintContext, query: string): Reference[] {
    const cache = this.ensureCaseCache(ctx)
    if (!cache.props) return []

    const results: Reference[] = []
    for (const name of cache.props) {
      if (name.includes(query)) {
        const label = cache.labels.get(name) ?? name
        results.push({ type: 'case', path: name, label, raw: `#case/${name}` })
      }
    }
    return results
  }
}

