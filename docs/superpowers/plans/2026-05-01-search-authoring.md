# Search Authoring Implementation Plan (Plan 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 4 of 5. Depends on Plan 1 (Foundation), Plan 2 (Case data layer), and Plan 3 (Case list authoring). Plan 5 (Running-app search execution) depends on this.

**Goal:** Ship the case-search authoring experience end-to-end. Module schema for default filters + claim condition + display labels (search inputs already shipped in Plan 3 because they're shared between the case-list inline-search experience and the search-config experience). Search-config builder UI: Default Filters section (typed Predicate AST) + Claim section + Display section. SA tools accept typed AST. Platform-aware compilation logic (split-screen / skip-to-results / search-first fallback). Wire emission for `<remote-request>` + `<query>` + `<post>` (claim) + `<datum>` (case-id selection) + `<stack>`.

**Architecture summary:** Search config is module-level data. Authors compose it through a typed UI; the platform-aware compiler picks emission based on author content + deploy feature flags (split-screen availability). The compiler is one function with a pure decision tree; deciding-on-emit is testable in isolation. The wire emitter follows `commcare-hq/.../tests/data/suite/remote_request.xml` as the canonical reference.

**Tech Stack:** Plan 1's AST + emitters, Plan 2's CaseStore (preview), Plan 3's editor primitives reused.

---

## File Structure

```
lib/domain/modules.ts                                    # extended with caseSearchConfig

components/builder/case-search-config/
├── CaseSearchConfigPanel.tsx                            # the multi-section UI shell
├── DefaultFiltersSection.tsx                            # default filters (typed Predicate)
├── ClaimSection.tsx                                     # claim condition + don't-claim-already-owned
├── DisplaySection.tsx                                   # title, subtitle, empty-list text, search button label
├── PlatformDivergencePanel.tsx                          # surfaces what each platform will do
└── __tests__/

lib/agent/tools/case-search-config/
├── setDefaultFilters.ts
├── setClaimSettings.ts
├── setDisplayLabels.ts
└── __tests__/

lib/commcare/validator/rules/case-search/
├── searchInputReferences.ts
├── defaultFilterTypeCheck.ts
├── claimConditionTypeCheck.ts
├── inputDefaultFilterConflict.ts                        # the cache-file-line-180 footgun
├── representability.ts                                  # per-platform divergence
└── __tests__/

lib/commcare/suite/case-search/
├── compileForPlatform.ts                                # decision tree: AST + flags → wire shape
├── remoteRequest.ts                                     # AST → <remote-request> emission
├── searchPrompts.ts                                     # AST → <prompt> emission
├── claim.ts                                             # AST → <post> claim emission
├── searchSession.ts                                     # AST → <session>/<datum>/<stack> emission
└── __tests__/
```

---

## Tasks

### Task 1: Extend `Module` schema for search

**Files:** `lib/domain/modules.ts`, tests.

Add `caseSearchConfig` to the module schema:

```ts
interface CaseSearchConfig {
  // Default filters (always-applied invisible filters)
  defaultFilters: Predicate;                  // single Predicate; the always-on case-list filter is shared

  // Claim
  claimCondition?: Predicate;                 // when set, controls whether the claim happens
  dontClaimAlreadyOwned: boolean;             // skip claim if user already owns the case
  blacklistedOwnerIds?: ValueExpression;      // ValueExpression returning space-separated owner_ids

  // Display
  searchScreenTitle?: string;
  searchScreenSubtitle?: string;              // markdown; web-only
  emptyListText?: string;
  searchButtonLabel?: string;
  searchAgainButtonLabel?: string;
  searchButtonDisplayCondition?: Predicate;   // hide/show search button

  // No `workflowMode` field. The author does not choose a workflow mode;
  // the compiler infers per-platform from configured content per the spec's
  // "One surface, no mode picker — locked" section. CCHQ's mode-picker is a
  // CCHQ authoring-UX artifact we explicitly reject.

  // Custom sort
  customSortProperties?: SortKey[];
  sortByRelevance?: boolean;                  // toggle for commcare_search_score sort
}
```

`searchInputs` already lives on `caseListConfig` from Plan 3 — shared between the case-list inline-search experience and the search-config screen.

Tests: schema parse; round-trip through Zod.


### Task 2: Default Filters section UI

**Files:** `components/builder/case-search-config/DefaultFiltersSection.tsx`, tests.

Reuses Plan 3 Task 2's `PredicateCardEditor`. Adds a runtime-context affordance for referencing search inputs (input-ref term cards get a smart picker scoped to the module's declared inputs from Plan 3). Live-preview panel shows "this filter narrows results from X cases to Y" using Plan 2's `PostgresCaseStore`.

Tests: round-trip; input-ref scoping.


### Task 3: Claim section UI

**Files:** `components/builder/case-search-config/ClaimSection.tsx`, tests.

Predicate input for the claim condition. Toggle for `dontClaimAlreadyOwned`. ValueExpression input for `blacklistedOwnerIds` (rare; collapsed by default). Live-preview shows which fixture cases would and wouldn't be claimed.

Tests: round-trip; preview accuracy.


### Task 4: Display section UI

**Files:** `components/builder/case-search-config/DisplaySection.tsx`, tests.

Plain text inputs for title, subtitle (with markdown preview), empty-list text, button labels. The subtitle accepts markdown but only renders on Web Apps — surface that constraint in the UI.

Tests: round-trip; markdown rendering preview.


### Task 5: Platform divergence panel UI

**Files:** `components/builder/case-search-config/PlatformDivergencePanel.tsx`, tests.

Renders, side-by-side, what the search experience will look like on Android (always case-list-first with inline filter) vs Web Apps (split-screen if available, fallback per inference rule). Uses Plan 1's representability checker to surface per-platform issues. The author sees, at authoring time, the exact UX divergence their config produces — which is the materialization of the "lossy at CCHQ boundary as a feature" spec promise.

Tests: each per-platform scenario shows the right UX preview; representability issues surface in the right panel.


### Task 6: Search Inputs — cross-section binding

**Files:** No new file; `components/builder/case-search-config/CaseSearchConfigPanel.tsx` integrates Plan 3's SearchInputsSection.

Plan 3's SearchInputsSection lives at the case-list config level (because it's shared with inline filtering). The case-search config panel mounts the same component but in a "search-config view" mode that surfaces the search-specific affordances (default value as Search-First-only behavior, etc.). One source, two presentations.

Tests: editing inputs from either surface updates the same module data.


### Task 7: SA tools

**Files:** `lib/agent/tools/case-search-config/*.ts`, tests.

`setCaseSearchDefaultFilters(moduleId, predicate)`, `setCaseSearchClaim(moduleId, settings)`, `setCaseSearchDisplay(moduleId, labels)`. Each accepts the typed AST shape via Zod. The structured-output ≤8-optional-fields constraint applies; tools split into surfaces accordingly.

Tests: schema parse via `scripts/test-schema.ts`; tool effects on fixture blueprints.


### Task 8: Platform-aware compilation decision tree

**Files:** `lib/commcare/suite/case-search/compileForPlatform.ts`, tests.

```ts
type PlatformContext = { platform: "android" | "web"; flags: { splitScreenAvailable: boolean } };
type WireShape = {
  autoLaunch: boolean;
  defaultSearch: boolean;
  inlineSearch: boolean;
  splitScreen: boolean;
};

export function compileForPlatform(config: CaseSearchConfig, ctx: PlatformContext): WireShape;
```

Decision tree (no author override; pure inference from content + platform):
1. If `ctx.platform === "android"` → always `{ autoLaunch: false, defaultSearch: false, inlineSearch: true, splitScreen: false }`. Mobile is always case-list-first regardless.
2. If `ctx.platform === "web"`:
   - If `ctx.flags.splitScreenAvailable` → `{ autoLaunch: false, defaultSearch: false, inlineSearch: true, splitScreen: true }`. The modern UX. Filters in sidebar, results in main panel, inline.
   - Else if `config.defaultFilters !== match-all && config.searchInputs.length === 0` (the case-list config's `searchInputs` field, which is shared with this config per Plan 3 Task 1) → `{ autoLaunch: true, defaultSearch: true, inlineSearch: false, splitScreen: false }`. Skip-to-results. Author intent is clear: default filters configured, no inputs to type, show filtered results immediately.
   - Else → `{ autoLaunch: false, defaultSearch: false, inlineSearch: false, splitScreen: false }`. List-first (the most user-respectful default). The user sees their local case list first; if they need to search, they hit the search button. We do NOT default to search-first because forcing a user to fill a search form before learning whether they have any local cases at all is worse UX than letting them see the list and search if needed. CCHQ's "Search First" mode exists for the rare clerical-worker case but is the wrong default; if a deploy needs that workflow, that's a CCHQ-side UX cost we accept rather than degrade Nova's authoring.

Tests: each branch hit with a fixture; output asserted; absence of `workflowMode` confirmed (the field doesn't exist on the schema).


### Task 9: `<remote-request>` emission

**Files:** `lib/commcare/suite/case-search/remoteRequest.ts`, tests.

AST → suite XML for the search config. Top-level structure follows `commcare-hq/.../tests/data/suite/remote_request.xml`:

```xml
<remote-request>
  <post>...</post>                    <!-- claim, from claim.ts -->
  <command>...</command>              <!-- search command label -->
  <instance/>+                        <!-- declared instances -->
  <session>
    <query>
      <data ...>+                     <!-- case_type, default values, special CCHQ keys, _xpath_query -->
      <prompt ...>+                   <!-- search inputs -->
    </query>
    <datum ...>                       <!-- selected case id -->
  </session>
  <stack>...</stack>                  <!-- post-claim navigation -->
</remote-request>
```

`<query>` attributes (`default_search`, `dynamic_search`, `search_on_clear`, `inline_search`) come from Task 8's WireShape.

Default filters compile via Plan 1's CSQL emitter (with `concat()` wrapping). Claim condition compiles via Plan 1's CSQL emitter for the `<post relevant=...>` attribute. Search prompts compile via Task 10. Datum is a typed structure with `nodeset` constructed from `instance('results')` (or `instance('results:inline')` if `inlineSearch`). Stack is a typed structure for post-claim navigation.

Tests: golden-file comparisons against fixture suite XML, one per platform × content combination.


### Task 10: Search prompts emission

**Files:** `lib/commcare/suite/case-search/searchPrompts.ts`, tests.

Each `SearchInputDef` becomes a `<prompt key=... input=...>`  element with optional `<display>` for labels and `<default>` for default values (compiled from the input's ValueExpression default).

Tests: each input type (text / select / date / date-range / barcode) emits the right XML.


### Task 11: Claim emission

**Files:** `lib/commcare/suite/case-search/claim.ts`, tests.

`<post url="..." relevant="...">` element with `<data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>`. The `relevant` attribute compiles from `claimCondition` (plus the standard "case is not already in casedb" check).

If `dontClaimAlreadyOwned` is true, AND the standard claim-only-if-not-owned guard in. If `blacklistedOwnerIds` is set, include the data-key for it.

Tests: golden-file comparisons; toggling `dontClaimAlreadyOwned` modifies `relevant` correctly.


### Task 12: Validator rules

**Files:** `lib/commcare/validator/rules/case-search/*.ts`, tests.

- `searchInputReferences` — every search-input ref in the default filter / claim condition / display condition resolves to a declared input.
- `defaultFilterTypeCheck` — the default filter Predicate type-checks via Plan 1.
- `claimConditionTypeCheck` — the claim condition Predicate type-checks.
- `inputDefaultFilterConflict` — a property cannot appear in both Default Search Filters and a Search Input (cache file line 180; HQ raises a config error here, so we should match).
- `representability` — runs Plan 1's representability checker per platform target.

Tests: each rule fires on bad input.


### Task 13: Plan 4 integration test

**Files:** `__tests__/integration/`.

End-to-end: build a fixture blueprint with case-search-config; run the validator; emit `<remote-request>`; compare against golden file; round-trip via the platform-aware compiler for both Android and Web; verify the WireShape outputs.


---

## Dependencies between tasks

- 1 standalone
- 2, 3, 4 depend on 1 + Plan 3 editor primitives + Plan 2 CaseStore (live-preview)
- 5 depends on 1 + Plan 1 representability
- 6 depends on Plan 3 Task 8 + Task 1
- 7 depends on 1 + Plan 1
- 8 depends on 1
- 9 depends on 1, 8 + Plan 1 CSQL emitter
- 10 depends on Plan 3 Task 1 + Plan 1 expression emitter
- 11 depends on 1 + Plan 1
- 12 depends on 1 + Plan 1
- 13 depends on all prior

## Final verification

- [ ] `npm run test` green
- [ ] `npm run lint` clean
- [ ] Integration test (Task 13) passes
- [ ] Cross-check `<remote-request>` emission against `commcare-hq/.../tests/data/suite/remote_request.xml`
- [ ] Platform divergence panel correctly previews both Android and Web

## Plan shape

Plan 4 is similar weight to Plan 3 in shape — most work is in the wire emitter (Task 9, `<remote-request>` emission) and the platform-divergence preview (Task 5), both differentiating features. Tasks 1-6 build the schema + UI surfaces; 7 ships SA tools; 8 implements the platform-aware compilation decision tree; 9-11 emit suite XML; 12 runs validators; 13 is the integration test.
