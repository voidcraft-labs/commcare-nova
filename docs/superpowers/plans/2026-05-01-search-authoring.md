# Search Authoring Implementation Plan (Plan 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **RE-BASELINE 2026-05-08 — `caseListConfig` was reshaped after Plan 3 SHIPPED.** The schema this plan composes against is now v2 (see [`2026-05-07-case-list-schema-reshape.md`](./2026-05-07-case-list-schema-reshape.md)). Any task touching `Column` / `SearchInputDef` / sort shape MUST re-baseline against the v2 `caseListConfig` shape before implementer dispatch — the reshape changed `searchInputs` to a discriminated `kind: "simple"` / `kind: "advanced"` union, moved sort onto each column (no parallel `SortKey[]` array), made calculated columns a kind on the unified column union, and replaced the `searchInputDef.xpath` slot with the discriminated `predicate` slot on the advanced arm.
>
> Tasks requiring re-baseline before dispatch:
>
> - **Task 1** (`caseSearchConfig` schema). The inline `customSortProperties?: SortKey[]` field below was authored before the reshape; the reshape's column-mounted sort pattern is the canonical Nova authoring shape, but `caseSearchConfig`'s sort surface is a separate schema (case-search has no Column equivalent — sort is on properties, not on display columns). The Task 1 implementer must explicitly choose between mirroring v2's column-mounted shape or justifying divergence based on the case-search domain. Don't carry the v1 SortKey shape forward by default.
> - **Task 2** (DefaultFilters UI). The default-filter editor references search inputs by name; the v2 shape is a discriminated union so the input-ref picker must consume both arms.
> - **Task 5** (Search Inputs cross-section binding). Plan 3's `SearchInputsSection` is now discriminated UI (simple-row vs advanced-row + per-row "convert to advanced/simple" affordance). The case-search-config's mount of the same component must consume the v2 shape.
> - **Task 6** (SA tools). Tool input schemas accept the typed AST; the v2 search-input shape is a discriminated union so each tool's input schema must reflect both arms. The eight-optional-fields ceiling still applies.
> - **Task 8** (`<remote-request>` emission). The wire emitter consumes `caseListConfig.searchInputs` to build the `<query>/<prompt>` blocks; both `kind: "simple"` (property + mode + via) and `kind: "advanced"` (predicate-driven) need wire emission paths. The advanced arm's `predicate` lowers through Plan 1's CSQL emitter directly, where the simple arm's predicate is built from (property, mode, via).
> - **Task 9** (Search prompts emission). Each `SearchInputDef` becomes a `<prompt>` element; the v2 discriminated union changes the per-arm shape — simple-arm prompts derive from `(property, mode, via)`, advanced-arm prompts have no per-arm property reference and pull the predicate's compiled wire form.
> - **Task 11** (Validator rules). `searchInputReferences` reads the discriminated arm; `defaultFilterTypeCheck` operates on the v2 `caseListConfig.filter` shape (unchanged by the reshape) but the predicate type checker now sees discriminated search-input refs.
>
> Tasks NOT requiring re-baseline:
>
> - **Tasks 3, 4** (Claim section UI, Display section UI) — operate on `caseSearchConfig`-only slots that the reshape didn't touch.
> - **Task 7** (Platform-aware compilation decision tree) — the `inlineSearch` / `splitScreen` / `autoLaunch` / `defaultSearch` decision tree reads `searchInputs.length` only; the v2 discriminated union doesn't change array length semantics.
> - **Task 10** (Claim emission) — wire-shape only, no v2-shape consumption.
> - **Task 12** (Plan 4 integration test) — re-baselines naturally as it composes the v2-touching tasks above.
> - **Task 13** (CaseSearchConfigPanel + mount site) — pure shell + mount-site work, schema-shape-agnostic.

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
  searchScreenSubtitle?: string;              // markdown
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

Plain text inputs for title, subtitle (with markdown preview), empty-list text, button labels.

Tests: round-trip; markdown rendering preview.


### Task 5: Search Inputs — cross-section binding

**Files:** No new file; `components/builder/case-search-config/CaseSearchConfigPanel.tsx` integrates Plan 3's SearchInputsSection.

Plan 3's SearchInputsSection lives at the case-list config level (because it's shared with inline filtering). The case-search config panel mounts the same component but in a "search-config view" mode that surfaces the search-specific affordances (default value as Search-First-only behavior, etc.). One source, two presentations.

Tests: editing inputs from either surface updates the same module data.


### Task 6: SA tools

**Files:** `lib/agent/tools/case-search-config/*.ts`, tests.

`setCaseSearchDefaultFilters(moduleId, predicate)`, `setCaseSearchClaim(moduleId, settings)`, `setCaseSearchDisplay(moduleId, labels)`. Each accepts the typed AST shape via Zod. The structured-output ≤8-optional-fields constraint applies; tools split into surfaces accordingly.

Tests: schema parse via `scripts/test-schema.ts`; tool effects on fixture blueprints.


### Task 7: Platform-aware compilation decision tree

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


### Task 8: `<remote-request>` emission

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


### Task 9: Search prompts emission

**Files:** `lib/commcare/suite/case-search/searchPrompts.ts`, tests.

Each `SearchInputDef` becomes a `<prompt key=... input=...>`  element with optional `<display>` for labels and `<default>` for default values (compiled from the input's ValueExpression default).

Tests: each input type (text / select / date / date-range / barcode) emits the right XML.


### Task 10: Claim emission

**Files:** `lib/commcare/suite/case-search/claim.ts`, tests.

`<post url="..." relevant="...">` element with `<data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>`. The `relevant` attribute compiles from `claimCondition` (plus the standard "case is not already in casedb" check).

If `dontClaimAlreadyOwned` is true, AND the standard claim-only-if-not-owned guard in. If `blacklistedOwnerIds` is set, include the data-key for it.

Tests: golden-file comparisons; toggling `dontClaimAlreadyOwned` modifies `relevant` correctly.


### Task 11: Validator rules

**Files:** `lib/commcare/validator/rules/case-search/*.ts`, tests.

- `searchInputReferences` — every search-input ref in the default filter / claim condition / display condition resolves to a declared input.
- `defaultFilterTypeCheck` — the default filter Predicate type-checks via Plan 1.
- `claimConditionTypeCheck` — the claim condition Predicate type-checks.
- `inputDefaultFilterConflict` — a property cannot appear in both Default Search Filters and a Search Input (cache file line 180; HQ raises a config error here, so we should match).

Tests: each rule fires on bad input.


### Task 12: Plan 4 integration test

**Files:** `__tests__/integration/`.

End-to-end: build a fixture blueprint with case-search-config; run the validator; emit `<remote-request>`; compare against golden file; round-trip via the platform-aware compiler for both Android and Web; verify the WireShape outputs.


### Task 13: CaseSearchConfigPanel + mount site

**Origin.** Plan 4's File Structure (line 21) lists `CaseSearchConfigPanel.tsx` as "the multi-section UI shell." Tasks 2-5 build the inner sections (DefaultFilters / Claim / Display / SearchInputs cross-section binding). No Task in the original plan explicitly builds the SHELL or names its mount site. This is the same gap class that bit Plan 3 (case-list authoring); discovered during the family audit on 2026-05-07. This task closes it BEFORE Plan 4 dispatch.

**Files:**
- `components/builder/case-search-config/CaseSearchConfigPanel.tsx` (NEW) — the multi-section UI shell.
- `components/builder/case-search-config/__tests__/CaseSearchConfigPanel.test.tsx` (NEW).
- Mount-site integration files (TBD per "Mount site" decision below) — at minimum either `components/preview/PreviewShell.tsx` (if a new URL is added) or `components/builder/case-list-config/CaseListWorkspace.tsx` (if mounted alongside the case-list authoring workspace).

**Mount site decision (REQUIRED to be made before dispatching the Task 13 implementer; do NOT default).**

The user explicitly directed: NOT a 4th tab in `CaseListWorkspace`. Two remaining shapes:
- **Option A — dedicated workspace at its own URL.** Add `kind: "search-config"` to the URL schema (`/build/[id]/{moduleUuid}/search-config`). PreviewShell dispatches to `<CaseSearchConfigPanel />` in edit mode. Symmetric with how `/cases` works. ModuleScreen gets a second affordance card ("Search Config") below the "Case List" card, shown only when the module has at least one case-search consumer.
- **Option B — additional section in `CaseListWorkspace`.** Same single-scroll workspace, additional section below Search Inputs (e.g., titled "Search Config" or "Case Search"). The user's "no 4th TAB" instruction does not necessarily forbid an additional SECTION in the single-scroll layout — the workspace is sectioned, not tabbed. But this conflates two distinct authoring surfaces (case-list config vs case-search config) into one workspace, which the spec line 17 vs line 18 (the spec lists them as separate authoring layers) might want kept apart.

**Recommendation for the supervisor at Plan 4 dispatch time:** Option A (dedicated `/search-config` URL). The spec treats case-list config and case-search config as two separate concepts ("Case list config" line 17, "Case search config" line 18), and the user's UX direction so far (single-scroll magazine, no tabs/mode-pickers) suggests two parallel scrolling workspaces are clearer than one mega-workspace. But the supervisor MUST confirm with the user before dispatching the Task 13 implementer — the ambiguity about whether case-search-config gets its own /search-config URL vs lives inside /cases as a sibling section is a real design question, not punt-framing.

**User-runnable acceptance.** User runs `npm run dev`, opens an existing case-typed module with a case-search consumer, navigates to the case-search authoring surface (either via the second ModuleScreen card → `/search-config`, OR by scrolling further down within `/cases` — depending on which mount-site option the supervisor confirms with the user). Sees the multi-section authoring UI (Default Filters / Claim / Display + the cross-bound Search Inputs from Plan 3). Edits a default filter, sees the change persist after page reload.


---

## Dependencies between tasks

- 1 standalone
- 2, 3, 4 depend on 1 + Plan 3 editor primitives + Plan 2 CaseStore (live-preview)
- 5 depends on Plan 3 Task 8 + Task 1
- 6 depends on 1 + Plan 1
- 7 depends on 1
- 8 depends on 1, 7 + Plan 1 CSQL emitter
- 9 depends on Plan 3 Task 1 + Plan 1 expression emitter
- 10 depends on 1 + Plan 1
- 11 depends on 1 + Plan 1
- 12 depends on all prior
- 13 depends on 1, 2, 3, 4 + Plan 3 Task 8.5 (CaseListWorkspace establishes the workspace pattern this mirrors)

## Final verification

- [ ] `npm run test` green
- [ ] `npm run lint` clean
- [ ] Integration test (Task 12) passes
- [ ] Cross-check `<remote-request>` emission against `commcare-hq/.../tests/data/suite/remote_request.xml`
- [ ] **User-runnable acceptance:** User runs `npm run dev`, opens a built case-typed app, navigates to a module with case-search-config, opens the case-search authoring surface (mount site per Task 13 decision), edits a default filter via the Default Filters section, sees the change persist after page reload. End-to-end authoring is reachable from a fresh `npm run dev` session WITHOUT any "configure first" handholding.

## Plan shape

Plan 4's weight is dominated by the wire emitter (Task 8, `<remote-request>` emission) and the platform-aware compilation decision tree (Task 7) the export adapter uses to translate one author-side config into the right wire shape per CCHQ runtime. Tasks 1-5 build the schema + UI surfaces; 6 ships SA tools; 7 implements the decision tree (export-side, no author UI); 8-10 emit suite XML; 11 runs validators; 12 is the integration test. The author-facing live preview is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule — there is no per-platform divergence panel; per-runtime UX differences are CCHQ-side concerns the export adapter handles silently.
