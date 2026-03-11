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

// Full form knowledge set — used by regenerateForm (edit mode) where
// correctness matters more than token savings.
export const FORM_KNOWLEDGE_ALL = [
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

// ── Core/conditional knowledge sets ─────────────────────────────────

type Phase = 'scaffold' | 'module' | 'form'

const CORE: Record<Phase, string[]> = {
  scaffold: ['case-types-and-properties', 'module-configuration'],
  module: ['case-list-configuration'],
  form: ['question-types-reference', 'form-logic-expressions', 'form-submission-validation'],
}

interface ConditionalEntry {
  files: string[]
  keywords: string[]
}

const CONDITIONAL: Record<Phase, Record<string, ConditionalEntry>> = {
  scaffold: {
    hierarchy: {
      files: ['parent-child-cases', 'case-design-patterns'],
      keywords: ['parent', 'child', 'subcase', 'household', 'hierarchy', 'referral', 'supervisor'],
    },
    sharing: {
      files: ['case-sharing-ownership'],
      keywords: ['shar', 'ownership', 'team', 'group', 'assign', 'transfer'],
    },
    formLinking: {
      files: ['form-navigation-end-of-form'],
      keywords: ['navigation', 'form link', 'end of form', 'redirect', 'workflow', 'menu'],
    },
    scale: {
      files: ['app-design-soft-limits'],
      keywords: ['scale', 'large', 'performance', 'limit', 'thousand', 'million', 'volume', 'many'],
    },
  },
  module: {
    caseSearch: {
      files: ['case-search-claim'],
      keywords: ['search', 'claim', 'lookup', 'find case', 'deduplicate', 'dedup', 'registry'],
    },
    calculatedColumns: {
      files: ['xpath-function-reference'],
      keywords: ['calculat', 'formula', 'xpath', 'expression', 'computed', 'derived', 'days since', 'age'],
    },
    icons: {
      files: ['multimedia-icons-formatting'],
      keywords: ['icon', 'badge', 'image', 'multimedia', 'color', 'format', 'emoji'],
    },
  },
  form: {
    instances: {
      files: ['instance-declarations-reference', 'lookup-tables-fixtures'],
      keywords: ['lookup', 'fixture', 'instance', 'reference', 'table', 'cascad', 'dropdown', 'list of'],
    },
    repeats: {
      files: ['repeat-groups'],
      keywords: ['repeat', 'multiple', 'add more', 'list of items', 'dynamic list', 'loop'],
    },
    saveToCase: {
      files: ['save-to-case'],
      keywords: ['save to case', 'create case', 'subcase', 'child case', 'open case', 'new case from'],
    },
    userProperties: {
      files: ['user-properties-session-data'],
      keywords: ['user property', 'user data', 'role-based', 'supervisor visibility', 'user role', 'custom user'],
    },
    gps: {
      files: ['gps-distance-patterns'],
      keywords: ['gps', 'coordinate', 'distance', 'geolocation', 'map pin', 'track location', 'latitude', 'longitude', 'lat/lon'],
    },
    xpathRef: {
      files: ['xpath-function-reference', 'xpath-performance-optimization'],
      keywords: ['xpath', 'calculat', 'formula', 'expression', 'if(', 'selected(', 'date(', 'index', 'sum(', 'count('],
    },
  },
}

// ── Resolver ────────────────────────────────────────────────────────

export interface ResolverContext {
  specification: string
  formPurpose?: string
}

/**
 * Resolve which knowledge files to load for a generation phase.
 * Starts with core files, then adds conditional files when keyword
 * triggers match against the specification + form purpose.
 *
 * Errs on the side of inclusion — false positives cost tokens,
 * false negatives cost output quality.
 */
export function resolveConditionalKnowledge(phase: Phase, context: ResolverContext): string[] {
  const files = new Set(CORE[phase])
  const conditionals = CONDITIONAL[phase]

  // Combine spec + form purpose for keyword matching
  const haystack = `${context.specification} ${context.formPurpose ?? ''}`.toLowerCase()

  for (const entry of Object.values(conditionals)) {
    if (entry.keywords.some(kw => haystack.includes(kw))) {
      for (const f of entry.files) files.add(f)
    }
  }

  return [...files]
}

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
