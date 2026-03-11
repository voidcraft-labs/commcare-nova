/**
 * Knowledge loader — reads distilled CommCare platform knowledge files
 * and returns them as formatted strings for injection into system prompts.
 *
 * Server-side only (uses fs). All files are cached in memory after first read.
 */
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const KNOWLEDGE_DIR = dirname(fileURLToPath(import.meta.url))

const cache = new Map<string, string>()

/**
 * Load one or more knowledge files by name (without .md extension).
 * Returns a single string with file-name headers suitable for embedding
 * in a system prompt `<knowledge>` block.
 *
 * Throws if a file doesn't exist — means the mapping is wrong.
 */
export async function loadKnowledge(...names: string[]): Promise<string> {
  const sections = await Promise.all(
    names.map(async (name) => {
      let content = cache.get(name)
      if (content === undefined) {
        content = await readFile(join(KNOWLEDGE_DIR, `${name}.md`), 'utf-8')
        cache.set(name, content)
      }
      return content
    }),
  )
  return sections.join('\n\n')
}

// ── Phase-to-knowledge mappings ──────────────────────────────────────

export const SCAFFOLD_KNOWLEDGE = [
  'case-types-and-properties',
  'parent-child-cases',
  'case-design-patterns',
  'case-sharing-ownership',
  'module-configuration',
  'app-design-soft-limits',
  'form-navigation-end-of-form',
] as const

export const MODULE_KNOWLEDGE = [
  'case-list-configuration',
  'case-search-claim',
  'xpath-function-reference',
  'xpath-performance-optimization',
  'multimedia-icons-formatting',
] as const

export const FORM_KNOWLEDGE = [
  'question-types-reference',
  'form-logic-expressions',
  'instance-declarations-reference',
  'lookup-tables-fixtures',
  'repeat-groups',
  'save-to-case',
  'form-submission-validation',
  'user-properties-session-data',
  'gps-distance-patterns',
  'xpath-function-reference',
  'xpath-performance-optimization',
] as const

// ── Knowledge index for edit mode ────────────────────────────────────

export const KNOWLEDGE_INDEX = `case-types-and-properties — Case property naming, data types, reserved properties, save/load wiring
parent-child-cases — Parent-child and extension case hierarchies, XPath traversal patterns
case-design-patterns — Common case architectures: tasking, referrals, dedup, rolling history, counters
case-sharing-ownership — Case ownership, sharing groups, location-based sharing, owner_id assignment
case-list-configuration — Case list columns, display formats, calculated properties, filtering, sorting
case-search-claim — Server-side case search, CSQL syntax, search properties, default filters
case-closure-and-automation — Case closure patterns, automatic case update rules
save-to-case — Save to Case questions, creating/updating arbitrary cases, repeat group patterns
module-configuration — Module types, navigation, case tags, advanced module form-level case actions
form-navigation-end-of-form — End-of-form navigation, form linking, display conditions, session endpoints
question-types-reference — All question types, data storage, appearance attributes, platform differences
form-logic-expressions — XPath patterns for display/validation/calculate/default conditions
instance-declarations-reference — All named instances (casedb, ledgerdb, fixtures, etc.), URIs, access patterns
lookup-tables-fixtures — Lookup tables, instance declarations, cascading selects, multilingual tables
repeat-groups — Repeat group types, XPath inside/outside repeats, position(), current(), pitfalls
form-submission-validation — Build-time validation errors, reserved names, runtime validation
user-properties-session-data — Custom user data, XPath access, built-in user properties, user case
gps-distance-patterns — GPS data format, distance(), auto-capture, map display
xpath-function-reference — All XPath functions: string, date, math, nodeset, CommCare-specific
xpath-performance-optimization — Indexed property ordering, casedb query patterns, calculation trees
app-design-soft-limits — Soft/hard limits for app structure, data volumes, case counts
multilingual-apps — Multiple languages, translation architecture, language switching
multimedia-icons-formatting — Static multimedia, icon badges, custom icons, markdown, accessibility
conditional-alerts-messaging — Conditional alerts, schedule types, SMS surveys, required case properties
data-security-encryption — encrypt-string(), AES-GCM, security design patterns
visit-scheduler-advanced-modules — Visit scheduler, phase-based scheduling, model iteration
custom-app-properties — App-level key-value properties controlling GPS, sync, navigation, security
feature-flags-reference — Feature flag categories, key flags for specific features
data-registry — Cross-project-space case search, registry data access constraints
mobile-ucr-reports — Mobile UCR fixtures, XPath access, chart config, sync delay
location-fixture-xpath — Locations fixture, ancestor lookups, location-based owner assignment`
