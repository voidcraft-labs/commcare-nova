# Search Authoring Implementation Plan (Plan 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 4 of 5. Depends on Plan 1 (Foundation), Plan 2 (Case data layer), Plan 3 (Case list authoring) + the 2026-05-07 schema reshape that brought `caseListConfig` to its v2 shape (sort-on-column, calc-as-kind, discriminated `SearchInputDef`, visibility flags). Plan 5 (Running-app search execution) depends on this.

**Goal:** Ship the case-search authoring experience end-to-end. Module schema for default filters + claim condition + display labels + custom search-results sort. Search-config builder UI: Default Filters section (typed Predicate AST) + Claim section + Display section + Custom Sort section, plus the cross-bound Search Inputs from Plan 3 embedded as the section that lives on `caseListConfig`. SA tools accept typed AST. Platform-aware compilation logic (split-screen / skip-to-results / list-first fallback). Wire emission for `<remote-request>` + `<query>` + `<post>` (claim) + `<datum>` (case-id selection) + `<stack>`.

**Architecture summary:** Search config is module-level data living at `mod.caseSearchConfig`. Authors compose it through a typed UI; the platform-aware compiler picks emission based on author content + deploy feature flags (split-screen availability). The compiler is one function with a pure decision tree; deciding-on-emit is testable in isolation. The wire emitter follows `commcare-hq/.../tests/data/suite/remote_request.xml` as the canonical reference.

**Tech Stack:** Plan 1's AST + emitters; Plan 2's CaseStore (live preview); Plan 3 + reshape's editor primitives reused (`PredicateCardEditor`, `ExpressionCardEditor`, `SearchInputsSection`, the case-list-config card shells, `useValidityPropagator`).

---

## File Structure

```
lib/domain/modules.ts                                     # extended with caseSearchConfig

components/builder/case-search-config/
├── CaseSearchConfigPanel.tsx                             # multi-section UI shell
├── DefaultFiltersSection.tsx                             # default filters (typed Predicate)
├── ClaimSection.tsx                                      # claim condition + don't-claim-already-owned + blacklist
├── DisplaySection.tsx                                    # title, subtitle, empty-list text, button labels
├── CustomSortSection.tsx                                  # ordered property-sort list + sort-by-relevance toggle
└── __tests__/

lib/agent/tools/case-search-config/
├── setCaseSearchDefaultFilters.ts
├── setCaseSearchClaim.ts
├── setCaseSearchDisplay.ts
├── setCaseSearchCustomSorts.ts
└── __tests__/

lib/commcare/validator/rules/case-search/
├── searchInputReferences.ts
├── defaultFilterTypeCheck.ts
├── claimConditionTypeCheck.ts
├── inputDefaultFilterConflict.ts                          # the cache-file footgun
└── __tests__/

lib/commcare/suite/case-search/
├── compileForPlatform.ts                                  # decision tree: AST + flags → wire shape
├── remoteRequest.ts                                       # AST → <remote-request> emission
├── searchPrompts.ts                                       # AST → <prompt> emission (per-arm dispatch)
├── claim.ts                                               # AST → <post> claim emission
├── searchSession.ts                                       # AST → <session>/<datum>/<stack> emission
├── customSorts.ts                                         # AST → <sort> emission for the search-results detail
└── __tests__/
```

---

## Tasks

### Task 1: Extend `Module` schema for search-config

**Files:** `lib/domain/modules.ts`, `lib/domain/__tests__/modules.test.ts`.

Add `caseSearchConfig?: CaseSearchConfig` to the module schema. The shape:

```ts
interface CaseSearchConfig {
  // Default filters — always-applied invisible filters layered on top of
  // caseListConfig.filter at the search-results layer. Single Predicate;
  // match-all sentinel ≡ no filter.
  defaultFilters: Predicate;

  // Claim
  claimCondition?: Predicate;                 // when present, gates whether the claim happens
  dontClaimAlreadyOwned: boolean;             // skip claim if the user already owns the case
  blacklistedOwnerIds?: ValueExpression;      // ValueExpression returning space-separated owner_ids

  // Display
  searchScreenTitle?: string;
  searchScreenSubtitle?: string;              // markdown
  emptyListText?: string;
  searchButtonLabel?: string;
  searchAgainButtonLabel?: string;
  searchButtonDisplayCondition?: Predicate;   // hide/show search button

  // Custom sort for search results — array order IS the priority.
  // Each entry references a case property by name; the wire emitter
  // derives the comparator type from the property's declared data_type
  // following the same three-fallback rule the case-list sort uses
  // (resolved data type → applicable comparator [0]; unresolved → "plain").
  customSorts?: Array<{ property: string; direction: "asc" | "desc" }>;
  sortByRelevance?: boolean;                  // toggles commcare_search_score sort

  // No `workflowMode` field — the compiler infers per-platform from
  // configured content (Task 7's decision tree). Per the spec's
  // "One surface, no mode picker — locked" section: CCHQ's mode picker
  // is a CCHQ authoring-UX artifact Nova explicitly rejects.
}
```

`searchInputs` does NOT live here — it stays on `mod.caseListConfig.searchInputs` per Plan 3 + the v2 reshape, shared between the case-list inline-search experience and the search-config screen.

Add the schema as `caseSearchConfigSchema = z.object({...})` exported from `lib/domain/modules.ts`. Re-export through `lib/domain/index.ts`.

Tests: schema parse round-trip; required-fields gate (`defaultFilters`, `dontClaimAlreadyOwned`); optional fields stripped when undefined.

### Task 2: Default Filters section UI

**Files:** `components/builder/case-search-config/DefaultFiltersSection.tsx`, tests.

Reuses `PredicateCardEditor` from Plan 3. The section:
- Mounts `<PredicateCardEditor predicate={config.defaultFilters} onChange={...} caseTypes={...} currentCaseType={...} knownInputs={mod.caseListConfig?.searchInputs ?? []} />`.
- The `knownInputs` prop scopes the input-ref smart picker to the discriminated v2 `SearchInputDef` union — both `kind: "simple"` and `kind: "advanced"` arms surface as referenceable inputs.
- Routes through `useValidityPropagator` for save-gate propagation (mirrors the `FiltersSection` pattern from Plan 3).
- Live-preview affordance via `lib/preview/engine/caseDataBindingClient.ts::readFilterPreview` — emits a "this filter narrows results from X cases to Y" line. The preview gates on validity per the case-list-config workspace pattern.

**Mount site:** `CaseSearchConfigPanel.tsx::DefaultFiltersSection` (Task 13's shell mounts it as the first section).

Tests: round-trip; input-ref scoping verifies both `simple` and `advanced` arms surface; validity-gate suppresses preview load on invalid predicate.

### Task 3: Claim section UI

**Files:** `components/builder/case-search-config/ClaimSection.tsx`, tests.

Three sub-controls:
- **Claim condition** — `<PredicateCardEditor predicate={config.claimCondition} onChange={...} />` — optional; absent ≡ "always claim."
- **Don't claim already owned** — boolean toggle wired to `config.dontClaimAlreadyOwned`.
- **Blacklisted owner ids** — collapsed-by-default `<ExpressionCardEditor expression={config.blacklistedOwnerIds} onChange={...} />`. Returns a space-separated `ValueExpression`. Rare; collapse default closed.

Routes through `useValidityPropagator`.

**Mount site:** `CaseSearchConfigPanel.tsx::ClaimSection`.

Tests: round-trip; toggle persistence; blacklist expression validity; preview shows would/wouldn't-be-claimed cases against fixture rows.

### Task 4: Display section UI

**Files:** `components/builder/case-search-config/DisplaySection.tsx`, tests.

Plain text inputs for `searchScreenTitle`, `emptyListText`, `searchButtonLabel`, `searchAgainButtonLabel`. Markdown editor for `searchScreenSubtitle` (existing markdown primitive — verify path during implementation; if none exists, use a simple textarea + live `<MarkdownPreview />` per the project's existing convention). Optional `searchButtonDisplayCondition` via `<PredicateCardEditor />` (collapsed by default).

**Mount site:** `CaseSearchConfigPanel.tsx::DisplaySection`.

Tests: round-trip; markdown rendering preview; button-display-condition validity.

### Task 5: Custom sort section UI

**Files:** `components/builder/case-search-config/CustomSortSection.tsx`, tests.

Ordered list of `{ property, direction }` entries. Add affordance picks a property from the case type's declared properties. Per-row direction toggle (asc/desc). Drag-to-reorder reassigns array order (which IS the sort priority). A separate "Sort by relevance" toggle wires to `config.sortByRelevance`.

The shape mirrors the case-list `SortPriorityStack` from Plan 3's reshape but addresses properties, not columns — the case-search has no display-column equivalent, so the sort entries are property-keyed.

**Mount site:** `CaseSearchConfigPanel.tsx::CustomSortSection`.

Tests: round-trip; reorder updates array order; sort-by-relevance toggle persists.

### Task 6: Embed Search Inputs section (cross-binding from Plan 3)

**Files:** `components/builder/case-search-config/CaseSearchConfigPanel.tsx` (the shell from Task 13 already mounts it).

The discriminated `SearchInputsSection` from Plan 3's reshape (with simple/advanced rows + per-row "Convert to advanced/simple" affordance) is mounted directly inside `CaseSearchConfigPanel.tsx` against `mod.caseListConfig.searchInputs`. This is the SAME data the case-list-config workspace edits — the case-search-config panel and the case-list workspace are both authoring surfaces for the same `searchInputs` array.

No new component. The mount in `CaseSearchConfigPanel` is one `<SearchInputsSection value={config.searchInputs} onChange={...} caseTypes={...} currentCaseType={...} />` line. The discriminated UI ships as-is from Plan 3.

**Mount site:** `CaseSearchConfigPanel.tsx::SearchInputsSection`.

Tests: editing inputs from the case-search-config panel updates the same `mod.caseListConfig.searchInputs` array the case-list-config workspace reads. Round-trip from either surface preserves `uuid` + `name` + `label` + `type` + the per-arm shape.

### Task 7: SA tools

**Files:** `lib/agent/tools/case-search-config/*.ts`, tests.

Four wholesale tools (config slots are mostly settings, no atomic-op decomposition needed):

- `setCaseSearchDefaultFilters({ moduleIndex, filter: Predicate | null })` — `null` clears.
- `setCaseSearchClaim({ moduleIndex, claimCondition?, dontClaimAlreadyOwned, blacklistedOwnerIds? })`.
- `setCaseSearchDisplay({ moduleIndex, searchScreenTitle?, searchScreenSubtitle?, emptyListText?, searchButtonLabel?, searchAgainButtonLabel?, searchButtonDisplayCondition? })`.
- `setCaseSearchCustomSorts({ moduleIndex, customSorts: Array<{property, direction}>, sortByRelevance: boolean })`.

Each tool's input schema accepts the typed AST shape via Zod (Predicate / ValueExpression). Each tool's `execute` returns `MutatingToolResult<R>` per the shared contract; success result is structured `{ message, ... }` with the relevant payload (see `setCaseListFilter` for the canonical structured-success pattern).

The structured-output ≤8-optional-fields ceiling applies — `setCaseSearchDisplay` carries six optional fields plus `moduleIndex` + a wholesale-default sentinel; verify via `scripts/test-schema.ts`.

Elm-style error returns: "Tried to set the case-search default filters on module index N. Found no module at that index. Look at `getModule`'s projection for valid indices." (Mirror the case-list-config tool family's voice.)

**Registration:** `lib/agent/solutionsArchitect.ts` adds the four tools to the shared set. `lib/mcp/server.ts` mirrors the registration. `lib/agent/CLAUDE.md` documents the case-search-config tool surface alongside the case-list-config tool family.

Tests: each tool's input schema passes `scripts/test-schema.ts`; `execute` happy-path + module-not-found error arms; MCP wire envelope projection.

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

export function compileForPlatform(
  caseListConfig: CaseListConfig,
  caseSearchConfig: CaseSearchConfig,
  ctx: PlatformContext,
): WireShape;
```

Decision tree (no author override; pure inference from content + platform):

1. **Android** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: true, splitScreen: false }`. Mobile is always case-list-first regardless.
2. **Web + split-screen available** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: true, splitScreen: true }`. Modern UX: filters in sidebar, results in main panel, inline.
3. **Web, split-screen unavailable, default-filters configured AND zero search inputs** → `{ autoLaunch: true, defaultSearch: true, inlineSearch: false, splitScreen: false }`. Skip-to-results — author intent is clear (default filters configured, nothing for the user to type, show filtered results immediately).
4. **Web fallback** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: false, splitScreen: false }`. List-first. Forcing a user to fill a search form before learning whether they have any local cases is worse UX than letting them see the list and search if needed.

The "default filters configured" check is `caseSearchConfig.defaultFilters.kind !== "match-all"`. The "zero search inputs" check is `caseListConfig.searchInputs.length === 0`.

Tests: each branch hit with a fixture; output asserted; absence of `workflowMode` confirmed (the field doesn't exist on the schema).

### Task 9: Custom sort emission

**Files:** `lib/commcare/suite/case-search/customSorts.ts`, tests.

Emit `<sort>` blocks under the search-results `<detail>` block following the same shape the case-list `sortKeys.ts` uses (Plan 3 reshape's wire emitter). Each `customSorts[i]` becomes one `<sort>` block:

- `type` derived from `applicableSortTypes(propertyDataType)[0]` per the case-list emitter's contract; three-fallback rule (`undefined` / `ANY_TYPE` / unmapped → `"plain"`) applies.
- `direction` from the entry.
- `order` from the array index.

When `sortByRelevance` is true, emit a final `<sort type="plain" order="N" direction="asc"><text><xpath function="commcare_search_score"/></text></sort>` block (CCHQ's relevance-sort wire shape).

Tests: golden-file comparisons; three-fallback derivation; relevance-sort emission appended last.

### Task 10: `<remote-request>` emission

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
      <prompt ...>+                   <!-- search inputs, from searchPrompts.ts -->
    </query>
    <datum ...>                       <!-- selected case id -->
  </session>
  <stack>...</stack>                  <!-- post-claim navigation -->
</remote-request>
```

`<query>` attributes (`default_search`, `dynamic_search`, `search_on_clear`, `inline_search`) come from Task 8's `WireShape`.

Default filters compile via Plan 1's CSQL emitter (with `concat()` wrapping). Claim condition compiles via Plan 1's CSQL emitter for the `<post relevant=...>` attribute (Task 11). Search prompts compile via Task 12. Datum is a typed structure with `nodeset` constructed from `instance('results')` (or `instance('results:inline')` if `inlineSearch`). Stack is a typed structure for post-claim navigation.

Tests: golden-file comparisons against fixture suite XML, one per platform × content combination (Android-list-first / Web-split-screen / Web-skip-to-results / Web-list-first fallback).

### Task 11: Claim emission

**Files:** `lib/commcare/suite/case-search/claim.ts`, tests.

`<post url="..." relevant="...">` element with `<data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>`. The `relevant` attribute compiles from `claimCondition` (when present) AND'd with the standard "case is not already in casedb" check. When `dontClaimAlreadyOwned` is true, the standard claim-only-if-not-owned guard is also AND'd in. When `blacklistedOwnerIds` is set, an additional `<data key="blacklist" .../>` element surfaces the compiled expression.

Tests: golden-file comparisons; toggling `dontClaimAlreadyOwned` modifies `relevant` correctly; `blacklistedOwnerIds` adds the data element when set.

### Task 12: Search prompts emission (per-arm dispatch)

**Files:** `lib/commcare/suite/case-search/searchPrompts.ts`, tests.

Each `SearchInputDef` (from `mod.caseListConfig.searchInputs`) becomes a `<prompt key={input.name} input={input.type}>` element with optional `<display>` for label and `<default>` for default-value (compiled from `input.default`). Per-arm dispatch:

- **Simple arm (`kind: "simple"`)** — the prompt's filter contribution at runtime is built from `(property, mode, via)`. The wire emits the prompt structurally; the per-mode runtime semantics live in CCHQ's runtime (Nova's emitter just produces the prompt declaration). The `mode` and `via` slots inform whether the prompt's value gets matched as `prop = value` (exact mode) / `prop LIKE value%` (starts-with) / etc.

- **Advanced arm (`kind: "advanced"`)** — the prompt is still declared identically (same `<prompt>` element), but the runtime filter contribution is the compiled `predicate` value, surfaced as a `<data key="_xpath_query" .../>` on the `<query>` element (advanced-arm predicates compose as additional `_xpath_query` clauses; CCHQ's runtime ANDs them with the simple-arm-derived clauses).

Tests: each input `type` (text / select / date / date-range / barcode) emits the right XML for both arms. Simple-arm `(property, mode, via)` mapping verified against the per-mode XML shape. Advanced-arm predicate-to-`_xpath_query` lowering exercised.

### Task 13: Validator rules

**Files:** `lib/commcare/validator/rules/case-search/*.ts`, tests.

Four rules registered in `lib/commcare/validator/rules/module.ts`:

- **`searchInputReferences`** — every `input("name")` term reference in `caseSearchConfig.defaultFilters` / `claimCondition` / `searchButtonDisplayCondition` / `customSorts[i].property` must resolve to a declared `mod.caseListConfig.searchInputs[i].name` (across both `simple` and `advanced` arms). Elm-style error names the bad reference and lists declared input names.
- **`defaultFilterTypeCheck`** — `caseSearchConfig.defaultFilters` predicate type-checks via Plan 1's predicate type checker against the module's `caseTypes` schema map.
- **`claimConditionTypeCheck`** — `caseSearchConfig.claimCondition` (when present) predicate type-checks.
- **`inputDefaultFilterConflict`** — a property cannot appear in both `caseSearchConfig.defaultFilters` (as a `prop` term) and a search input's `simple-arm property` slot (CCHQ runtime config error per cache file). Elm-style error names the conflicting property + both surfaces.

Tests: each rule fires on bad input + passes on clean input. Integration test covers the conflict rule against a fixture with overlapping property names.

### Task 14: CaseSearchConfigPanel + mount site

**Files:**
- `components/builder/case-search-config/CaseSearchConfigPanel.tsx` (NEW) — multi-section UI shell. Renders the five sections from Tasks 2-6 in order: Default Filters → Claim → Display → Custom Sort → Search Inputs. Sticky violet-railed section headers (mirror Plan 3's `CaseListSectionHeader` pattern). Single-scroll magazine layout.
- `components/builder/case-search-config/__tests__/CaseSearchConfigPanel.test.tsx` (NEW).
- `lib/preview/engine/types.ts` (EDIT) — add `kind: "search-config"` to the `PreviewScreen` union.
- `components/preview/PreviewShell.tsx` (EDIT) — edit-mode dispatcher for `screen.kind === "search-config"` mounts `<CaseSearchConfigPanel moduleUuid={...} />`. Live-mode dispatcher routes to the running-app rendering Plan 5 will provide.
- `app/(app)/build/[id]/[[...path]]/page.tsx` (EDIT) — URL parser routes `/build/{appId}/{moduleUuid}/search-config` to a `screen` of `kind: "search-config"`.
- `components/preview/screens/ModuleScreen.tsx` (EDIT) — add a "Search Config" affordance card alongside the existing "Case List" card, shown only when the module declares a `caseType` (the prerequisite for case-search authoring). Click navigates to `/build/{appId}/{moduleUuid}/search-config`.

**Mount site (locked):** dedicated `/search-config` URL alongside `/cases`. The case-list workspace's three-section magazine stays focused on the case list; the case-search workspace lives separately. Two parallel scrolling workspaces is clearer than one mega-workspace, mirrors the spec's separation of "Case list config" and "Case search config" concerns, and respects the user's "no 4th tab in CaseListWorkspace" directive.

**User-runnable acceptance.** User runs `npm run dev`, opens an existing case-typed module, sees the "Search Config" affordance card on the module screen, clicks it. URL changes to `/build/{appId}/{moduleUuid}/search-config`. Sees the multi-section authoring UI (Default Filters / Claim / Display / Custom Sort / Search Inputs). Edits a default filter via `PredicateCardEditor`. Sees the change persist after page reload (route round-trip).

### Task 15: Plan 4 integration test

**Files:** `__tests__/integration/case-search-authoring.test.ts`.

End-to-end against the testcontainer harness:
- Build a fixture blueprint with `caseListConfig` (columns + sort + searchInputs) AND `caseSearchConfig` (default filters + claim + display + custom sorts).
- Run the validator; assert clean.
- Construct one synthetic broken predicate (input ref to a non-declared name); assert `searchInputReferences` rule fires with Elm-style error.
- Emit `<remote-request>` via `remoteRequest.ts`; compare against golden file.
- Round-trip via `compileForPlatform` for Android + Web (split-screen-available + split-screen-unavailable + skip-to-results); verify the four `WireShape` outputs.
- SA path: call each of the four wholesale tools through the agent layer; assert mutation effects on the doc store.
- Postgres preview: `caseSearchConfig.defaultFilters` + `caseListConfig.searchInputs` runtime values flow through `lib/preview/engine/caseDataBindingHelpers.ts::readCaseListPreview` (extended in Plan 5) — defer the runtime-bindings test to Plan 5; this test verifies the authoring-side wire emission only.

---

## Dependencies between tasks

- 1 standalone (depends on Plans 1-3 + reshape).
- 2, 3, 4, 5 depend on 1 + Plan 3's editor primitives + Plan 2's CaseStore (live preview).
- 6 depends on Plan 3 Task 8 (`SearchInputsSection`).
- 7 depends on 1 + Plan 1 + the reshape's atomic-op + structured-success pattern from Plan 3.
- 8 depends on 1.
- 9 depends on 1 + Plan 3's wire-emission `applicableSortTypes` rule (the table moves into the wire emitter per the reshape).
- 10 depends on 1, 8, 9, 11, 12 + Plan 1's CSQL emitter.
- 11 depends on 1 + Plan 1.
- 12 depends on Plan 3 + the v2 discriminated `SearchInputDef` shape.
- 13 depends on 1 + Plan 1.
- 14 depends on 1, 2, 3, 4, 5, 6 (the shell mounts the sections).
- 15 depends on all prior.

## Final verification

- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean.
- [ ] `npm run build` clean.
- [ ] `npm test` green (full suite, deterministic two consecutive runs).
- [ ] Integration test (Task 15) passes.
- [ ] Cross-check `<remote-request>` emission against `commcare-hq/.../tests/data/suite/remote_request.xml`.
- [ ] **User-runnable acceptance:** User runs `npm run dev`, navigates to a case-typed module's `/search-config` URL via the ModuleScreen affordance card, edits a default filter, sees the change persist after page reload. The full case-search authoring surface is reachable from a fresh `npm run dev` session WITHOUT any "configure first" handholding.

## Plan shape

Plan 4's weight is dominated by the wire emitter (Task 10, `<remote-request>` emission) and the platform-aware compilation decision tree (Task 8) the export adapter uses to translate one author-side config into the right wire shape per CCHQ runtime. Tasks 1-6 build the schema + UI sections; 7 ships SA tools; 8 implements the decision tree (export-side, no author UI); 9-12 emit suite XML; 13 runs validators; 14 mounts the workspace; 15 is the integration test. The author-facing live preview is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule — there is no per-platform divergence panel; per-runtime UX differences are CCHQ-side concerns the export adapter handles silently.
