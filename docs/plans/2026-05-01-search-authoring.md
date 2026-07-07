# Search Authoring Implementation Plan (Plan 4 of 5)

> **For agentic workers:** Implement this plan task-by-task with subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 4 of 5. Reshaped 2026-05-08 against the v2 `caseListConfig` shape that Plan 3 + the 2026-05-07 schema reshape ship. The reshape revisited Plan 4's premise: CCHQ's authoring layer separates "case list" and "search results" into duplicate config surfaces (`<sort>` vs `custom_sort_properties`, case-list filter vs default search filter), but Nova's principle is "from the user's perspective there is only one case list ever, regardless of how they get there." The wire emitter projects the single `caseListConfig` onto both wire detail blocks (`m{N}_case_short` + `m{N}_search_short`, mirror for long) at emission. Plan 4's `caseSearchConfig` carries only the search-only authoring concerns that have no case-list parallel — claim flow + display labels + the cross-bound search inputs from Plan 3. Plan 5 (Running-app search execution) depends on this plan.

**Goal:** Ship the case-search authoring experience end-to-end. Module schema for claim flow + display labels. Search-config workspace UI: Claim section + Display section + the cross-bound Search Inputs section embedded from `caseListConfig.searchInputs`. SA tools accept the typed AST. Platform-aware compilation decision tree (split-screen / skip-to-results / list-first fallback). Wire emission for `<remote-request>` + `<query>` + `<post>` (claim) + `<datum>` + `<stack>` + `<prompt>` per-arm dispatch. Wire emission of dual `<detail>` blocks for the search-results screen, projecting the case-list display + sort onto both wire IDs. Validator rules for the new search-specific cross-references.

**Architecture summary:** `caseSearchConfig` lives at `mod.caseSearchConfig` alongside `caseListConfig`. Authors compose it through a typed UI; the platform-aware compiler picks emission based on author content + deploy feature flags (split-screen availability). The compiler is one function with a pure decision tree; deciding-on-emit is testable in isolation. The wire emitters follow the canonical CCHQ test fixtures byte-for-byte: `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml` for `<remote-request>`, `search_command_detail.xml` for the dual `<detail>` blocks. The "follow the fixture" rule is a wire-shape contract (CCHQ is our import target); it does NOT extend to CCHQ's authoring shape (which Nova rejects).

**Tech Stack:** Plan 1's AST + emitters; Plan 2's CaseStore (live preview); Plan 3 + reshape's editor primitives reused (`PredicateCardEditor`, `ExpressionCardEditor`, `SearchInputsSection`, `useValidityPropagator`). The case-list shortDetail / longDetail / compiler emitters at `lib/commcare/suite/case-list/` extend to emit dual wire IDs.

**The "one case list" principle, made structural.** Three CCHQ-shape leaks Plan 4 explicitly rejects:
- **`caseSearchConfig.defaultFilters`** — would re-create CCHQ's "case list filter vs default search filter" split. Nova's `caseListConfig.filter` is the single source; the wire emitter projects it onto BOTH the case-list `<detail nodeset>` filter slot AND the search-side `<data key="_xpath_query">` slot.
- **`caseSearchConfig.customSorts`** — would re-create CCHQ's `custom_sort_properties` parallel-config split (the v0 `findSortKey` silent-drop bug class transposed to search-results). Nova's `caseListConfig.columns[*].sort` is the single source; the wire emitter projects identical `<sort>` blocks onto both `m{N}_case_short` and `m{N}_search_short`.
- **`caseSearchConfig.sortByRelevance`** + the `<data key="commcare_sort">` ES retrieval-sort wire slot — CCHQ exposes a magic-string property name (`commcare_search_score`) in a generic sort row to override ES's default `_score` ranking. Nova never emits `<data key="commcare_sort">`. ES's default `_score` sort is in effect for fuzzy / phonetic / starts-with match results; the runtime player display sort then comes from the `<sort>` blocks on `m{N}_search_short` (the same blocks that govern `m{N}_case_short`).

The fixture verifying the "one case list, two wire IDs, identical content" wire shape is `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml` — `m0_case_short` and `m0_search_short` carry identical `<field>` + `<sort>` content.

---

## File Structure

Every file mapped to its owning task. NEW / EDIT annotated. UI components include their mount site.

### Schema (Task 1)

- `lib/domain/modules.ts` (EDIT) — add `caseSearchConfigSchema` + `caseSearchConfig?: CaseSearchConfig` slot on the Module schema.
- `lib/domain/index.ts` (EDIT) — re-export `CaseSearchConfig`, `caseSearchConfigSchema`.
- `lib/domain/__tests__/modules.test.ts` (EDIT) — schema-roundtrip tests for the new slot.

### UI sections (Tasks 2-3 build sections; Task 12 mounts them in the shell)

- `components/builder/case-search-config/AdvancedSection.tsx` (NEW) — Task 2. Mount: `CaseSearchConfigPanel.tsx::AdvancedSection` (Task 12 owns the mount line).
- `components/builder/case-search-config/DisplaySection.tsx` (NEW) — Task 3. Mount: `CaseSearchConfigPanel.tsx::DisplaySection` (Task 12 owns the mount line).
- `components/builder/case-search-config/__tests__/AdvancedSection.test.tsx` (NEW)
- `components/builder/case-search-config/__tests__/DisplaySection.test.tsx` (NEW)

The cross-bound `SearchInputsSection` (Plan 3's discriminated UI, mounted against `mod.caseListConfig.searchInputs`) is mounted inline by Task 12 alongside DisplaySection and AdvancedSection — Task 12 ships the three-section shell as a single coherent surface.

### Cross-binding verification (Task 4)

- `components/builder/case-search-config/__tests__/searchInputsCrossBinding.test.tsx` (NEW) — Task 4. Test-only task; depends on Task 12's CaseSearchConfigPanel shell. Verifies the contract that case-list and case-search workspaces edit the same `caseListConfig.searchInputs` array round-trip.

### SA tools (Task 5)

- `lib/agent/tools/case-search-config/setCaseSearchAdvanced.ts` (NEW)
- `lib/agent/tools/case-search-config/setCaseSearchDisplay.ts` (NEW)
- `lib/agent/tools/case-search-config/shared.ts` (NEW) — `snapshotCaseSearchConfig` helper + Zod input schemas for the two tools' bodies (omitting `moduleIndex`).
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchAdvanced.test.ts` (NEW)
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchDisplay.test.ts` (NEW)
- `lib/agent/tools/case-search-config/__tests__/schema.test.ts` (NEW) — verifies both tools' input schemas pass `scripts/test-schema.ts` (Anthropic 8-optional-ceiling structural defense).
- `lib/agent/tools/shared/moduleNotFoundResult.ts` (NEW) — relocate the helper out of `case-list-config/shared.ts` (first-duplication: caseSearchConfig tools need the same shape; extract before duplicating).
- `lib/agent/tools/case-list-config/shared.ts` (EDIT) — re-export from the new shared location; remove the inline definition.
- `lib/agent/solutionsArchitect.ts` (EDIT) — register the 2 new tools.
- `lib/agent/summarizeBlueprint.ts` (EDIT) — surface `caseSearchConfig` presence + display labels + advanced-cluster state in the SA-facing module summary.
- `lib/agent/prompts.ts` (EDIT) — system-prompt addition naming the 2 case-search tools + the "edit the same searchInputs through case-list tools" cross-binding rule.
- `lib/agent/tools/getModule.ts` (EDIT) — projection includes `caseSearchConfig` verbatim.
- `lib/agent/tools/updateModule.ts` (EDIT) — JSDoc references the new tool family alongside the existing case-list-config family.
- `lib/mcp/server.ts` (EDIT) — MCP parity for the 2 new tools.
- `lib/agent/CLAUDE.md` (EDIT) — case-search-config tool family documented alongside case-list-config.

### Wire emission (Tasks 6-10)

- `lib/commcare/suite/case-search/compileForPlatform.ts` (NEW) — Task 6. Decision tree from `(caseListConfig, caseSearchConfig, platformContext) → WireShape`.
- `lib/commcare/suite/case-search/__tests__/compileForPlatform.test.ts` (NEW) — Task 6.
- `lib/commcare/suite/case-list/shortDetail.ts` (EDIT) — Task 7. Emit dual blocks `m{N}_case_short` + `m{N}_search_short` when the module has `caseSearchConfig`.
- `lib/commcare/suite/case-list/longDetail.ts` (EDIT) — Task 7. Emit dual blocks `m{N}_case_long` + `m{N}_search_long` when the module has `caseSearchConfig`.
- `lib/commcare/suite/case-list/compiler.ts` (EDIT) — Task 7. Orchestrator threads `caseSearchConfig` presence through to the dual-emit branches.
- `lib/commcare/suite/case-list/__tests__/dualDetailEmission.test.ts` (NEW) — Task 7. Golden-file comparison against `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`.
- `lib/commcare/suite/case-search/remoteRequest.ts` (NEW) — Task 8. `<remote-request>` orchestrator.
- `lib/commcare/suite/case-search/searchSession.ts` (NEW) — Task 8. `<session>` / `<datum>` / `<stack>` sub-emitter.
- `lib/commcare/suite/case-search/__tests__/remoteRequest.test.ts` (NEW) — Task 8. Golden-file against `remote_request.xml`.
- `lib/commcare/suite/case-search/claim.ts` (NEW) — Task 9. `<post>` claim emission.
- `lib/commcare/suite/case-search/__tests__/claim.test.ts` (NEW) — Task 9. Golden-file against `search_config_blacklisted_owners.xml`.
- `lib/commcare/suite/case-search/searchPrompts.ts` (NEW) — Task 10. `<prompt>` per-arm dispatch.
- `lib/commcare/suite/case-search/__tests__/searchPrompts.test.ts` (NEW) — Task 10.
- `lib/commcare/compiler.ts` (EDIT) — Task 8. Thread the case-search wire output into the suite-level emission.

### Validator rules (Task 11)

- `lib/commcare/validator/rules/case-search/searchButtonDisplayConditionTypeCheck.ts` (NEW) — Task 11.
- `lib/commcare/validator/rules/case-search/excludedOwnerIdsTypeCheck.ts` (NEW) — Task 11.
- `lib/commcare/validator/rules/case-search/filterSearchInputConflict.ts` (NEW) — Task 11.
- `lib/commcare/validator/rules/case-search/__tests__/searchButtonDisplayConditionTypeCheck.test.ts` (NEW)
- `lib/commcare/validator/rules/case-search/__tests__/excludedOwnerIdsTypeCheck.test.ts` (NEW)
- `lib/commcare/validator/rules/case-search/__tests__/filterSearchInputConflict.test.ts` (NEW)
- `lib/commcare/validator/rules/case-search/__tests__/integration.test.ts` (NEW) — case-search rules wired through `runValidation`.
- `lib/commcare/validator/rules/case-list/searchInputDefaultTypeCheck.ts` (NEW) — Task 11. Lives under case-list because `searchInputs` is owned by `caseListConfig`.
- `lib/commcare/validator/rules/case-list/searchInputPredicateTypeCheck.ts` (NEW) — Task 11. Same scope reason.
- `lib/commcare/validator/rules/module.ts` (EDIT) — register the new rules.

### Workspace shell + URL routing (Task 12)

- `components/builder/case-search-config/CaseSearchConfigPanel.tsx` (NEW) — Task 12. Multi-section workspace shell. Mounts DisplaySection (built by Task 3), the Plan 3 `SearchInputsSection` (cross-bound against `mod.caseListConfig.searchInputs`), and AdvancedSection (built by Task 2). Section order top-to-bottom: Display → Search Inputs → Advanced.
- `components/builder/case-search-config/__tests__/CaseSearchConfigPanel.test.tsx` (NEW)
- `lib/routing/types.ts` (EDIT) — add `{ kind: "search-config"; moduleUuid: Uuid }` to the `Location` discriminated union.
- `lib/routing/location.ts` (EDIT) — parse `[moduleUuid, "search-config"]` segments → `{ kind: "search-config", moduleUuid }`; serialize the kind back. Mirror the `cases` arm.
- `lib/routing/hooks.tsx` (EDIT) — add `openSearchConfig(moduleUuid)` to the `useNavigate()` returned actions; thread `kind: "search-config"` through `useBreadcrumbs`.
- `lib/routing/CLAUDE.md` (EDIT) — add the `/{moduleUuid}/search-config` route to the URL schema table.
- `lib/routing/__tests__/location.test.ts` (EDIT) — round-trip cases for the new kind.
- `components/preview/PreviewShell.tsx` (EDIT) — add `loc.kind === "search-config"` branch dispatching to `<CaseSearchConfigPanel moduleUuid={...} />` in edit mode. Live mode: defer to Plan 5's running-app rendering (Plan 5 owns the live-mode dispatch; Plan 4 leaves a typed fallback that renders a "live preview lands in Plan 5" placeholder rather than crashing).
- `components/preview/screens/ModuleScreen.tsx` (EDIT) — add a "Search Config" affordance card alongside the existing "Case List" card. Visible when `mod.caseType` is set (case-search authoring requires a case type). Clicking calls `useNavigate().openSearchConfig(moduleUuid)`.
- `components/preview/screens/__tests__/ModuleScreen.test.tsx` (EDIT) — affordance card visibility + click dispatch.

### Integration test (Task 13)

- `__tests__/integration/case-search-authoring.test.ts` (NEW) — end-to-end against the testcontainer harness.

---

## Tasks

### Task 1: Extend `Module` schema for `caseSearchConfig`

**Files:** `lib/domain/modules.ts`, `lib/domain/index.ts`, `lib/domain/__tests__/modules.test.ts`.

Add `caseSearchConfig?: CaseSearchConfig` to the module schema. The shape:

```ts
interface CaseSearchConfig {
  // Display
  searchScreenTitle?: string;
  searchScreenSubtitle?: string;            // markdown rendered at runtime
  emptyListText?: string;
  searchButtonLabel?: string;
  searchAgainButtonLabel?: string;
  searchButtonDisplayCondition?: Predicate; // hides/shows the search button

  // Advanced
  // ValueExpression returning a space-separated list of owner IDs whose
  // cases are excluded from the search-results scope. The runtime applies
  // the exclusion before paging results back to the search screen. Rare
  // affordance — the editor collapses closed by default in the UI.
  excludedOwnerIds?: ValueExpression;
}
```

Notable schema decisions:

- **No `defaultFilters` slot.** `caseListConfig.filter` is the single Predicate source. The wire emitter projects it onto both the case-list `<detail nodeset>` filter and the search-side `<data key="_xpath_query">` slot at emission time (Task 8).
- **No `customSorts` / `sortByRelevance` slots.** `caseListConfig.columns[*].sort` is the single source for display sort; the wire emitter projects identical `<sort>` blocks onto both `m{N}_case_short` and `m{N}_search_short` (Task 7). Nova never emits `<data key="commcare_sort">` (the ES retrieval-sort override); ES's default `_score` ranking is in effect for fuzzy / phonetic match results.
- **`searchInputs` does NOT live here.** It stays on `mod.caseListConfig.searchInputs` per Plan 3 + the v2 reshape, shared between the case-list inline-search experience and the case-search-config workspace.
- **No claim-condition authoring.** CCHQ's runtime fires the case-claim step automatically: the `<post relevant>` always emits the default guard `count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0` regardless of any author input. The claim-condition slot CCHQ exposes (`additional_relevant`) is gated behind `CASE_SEARCH_DEPRECATED` for authoring — Nova does not expose an authoring affordance for it.
- **The two clusters are display + advanced.** Display owns the search-screen labels (six text + predicate slots). Advanced owns niche search-side filters (today: `excludedOwnerIds`); the abstract name lets future advanced filters land here without a schema rename.

Schema is `z.object({ ... }).strict()` with all-optional fields. `caseSearchConfig: undefined` on a module signals "no case-search authoring"; an empty `{}` signals "search authored, every slot uses runtime defaults" — both are valid persisted shapes, distinguishing the two states meaningfully.

**Tests:** schema parse round-trip; empty-config round-trip; `.strict()` rejects unknown keys; explicit `undefined` admitted on optional slots; `caseSearchConfig: undefined` round-trips as the absent-slot shape on the Module.

### Task 2: Advanced section UI

**Files:** `components/builder/case-search-config/AdvancedSection.tsx`, tests.

One sub-control today; the section name is intentionally abstract so future advanced filters land here without a rename.

- **Excluded owner IDs** — collapsed-by-default `<ExpressionCardEditor expression={config.excludedOwnerIds} onChange={...} expectedType="text" />`. Returns a space-separated `ValueExpression` of owner IDs to exclude from the search-results scope. The editor stays mounted whenever the slot is defined (collapse toggles visibility via the `hidden` attribute, not unmount), so a backend-loaded invalid expression still surfaces its type-check verdict on a default-collapsed first render.

Routes through `useValidityPropagator` for save-gate propagation (mirrors the `FiltersSection` pattern from Plan 3). Section validity = `!exclusionPresent || expressionValid` — slot-presence short-circuit when the exclusion expression is absent.

**Mount site:** `CaseSearchConfigPanel.tsx::AdvancedSection` (Task 12's shell mounts it as the third section, below Display and Search Inputs).

**Tests:** empty-state render; add-path round-trip; populated-config round-trip; collapse-state visibility toggle preserves mount; excluded-owners expression validity propagates through `useValidityPropagator`.

### Task 3: Display section UI

**Files:** `components/builder/case-search-config/DisplaySection.tsx`, tests.

Plain text inputs for `searchScreenTitle`, `emptyListText`, `searchButtonLabel`, `searchAgainButtonLabel`. Markdown editor for `searchScreenSubtitle` — verify the existing markdown primitive path during implementation; if none exists, use a textarea + live `<MarkdownPreview />` per the project's existing convention (the user-facing label "Subtitle" hints at markdown via a small "Markdown" badge). Optional `searchButtonDisplayCondition` via `<PredicateCardEditor />` (collapsed by default).

Routes through `useValidityPropagator`.

**Mount site:** `CaseSearchConfigPanel.tsx::DisplaySection` (Task 12's shell mounts it).

**Tests:** round-trip; markdown rendering preview; button-display-condition validity; empty-string vs undefined for each text slot round-trips correctly (omit on undefined per the `withCommonSlots` pattern from the reshape).

### Task 4: Search-inputs cross-binding test

**Files:** `components/builder/case-search-config/__tests__/searchInputsCrossBinding.test.tsx` (NEW).

The discriminated `SearchInputsSection` from Plan 3's reshape ships unchanged. Plan 4 mounts it inside `CaseSearchConfigPanel` (Task 12) against `mod.caseListConfig.searchInputs` — the same array the case-list-config workspace edits. This task verifies the structural cross-binding works end-to-end: editing inputs from one surface persists across the other.

The test mounts both `CaseListWorkspace` and `CaseSearchConfigPanel` against the same doc-store fixture (using a shared `BlueprintProvider`). It exercises:
- Add a `kind: "simple"` search input from `CaseSearchConfigPanel`'s mount of `SearchInputsSection`; assert it appears in `CaseListWorkspace`'s SearchInputsSection mount.
- Convert a search input from simple → advanced from `CaseListWorkspace`; assert the conversion is visible in `CaseSearchConfigPanel`.
- Round-trip preserves `uuid` + `name` + `label` + `type` + the per-arm shape across both surfaces.

**Depends on Task 12** (`CaseSearchConfigPanel` must exist). The executor picks Task 4 only after Task 12's deliverables have landed — the dependencies block names this explicitly.

**Mount site:** N/A — test-only task verifying the cross-binding contract.

### Task 5: SA tools

**Files:** `lib/agent/tools/case-search-config/*.ts`, `lib/agent/blueprintHelpers.ts` (EDIT), `lib/agent/solutionsArchitect.ts` (EDIT), `lib/mcp/server.ts` (EDIT), `lib/agent/CLAUDE.md` (EDIT), `lib/agent/tools/shared/moduleNotFoundResult.ts` (NEW), `lib/agent/tools/case-list-config/shared.ts` (EDIT — re-export from new location), tests.

Two wholesale tools — `caseSearchConfig` is a config bag, not an addressable list, so atomic-op decomposition doesn't apply. Each tool replaces a coherent cluster of related fields. Both reuse the relocated `moduleNotFoundResult` helper.

- `setCaseSearchAdvanced({ moduleIndex, excludedOwnerIds })` — sets the entire advanced cluster. The `excludedOwnerIds` slot is required-and-nullable on the SA boundary: pass `null` to clear, non-null to set (mirrors `setCaseListFilter`'s wholesale-replace shape). Today the cluster carries one slot; future advanced filters land here without a tool rename.
- `setCaseSearchDisplay({ moduleIndex, searchScreenTitle?, searchScreenSubtitle?, emptyListText?, searchButtonLabel?, searchAgainButtonLabel?, searchButtonDisplayCondition? })` — sets the entire display cluster. `null`-clearing convention applies.

Each tool's `execute` returns `MutatingToolResult<R>` per the shared contract; success result is structured `{ message, ... }` carrying the touched-field-count discriminator (mirror `setCaseListFilter`'s structured-success shape — the SA reads the discriminator without re-parsing prose).

**Module-not-found defense** at the tool boundary, using the relocated `moduleNotFoundResult<TSuccess>(doc, moduleIndex, "set the case-search advanced cluster")` helper. Elm-style error: "Tried to set the case-search advanced cluster on module index N. Found no module at that index. Look at `getModule`'s projection for valid indices."

**Helper relocation (first-duplication discipline).** The reshape's `moduleNotFoundResult` lives at `lib/agent/tools/case-list-config/shared.ts`. Adding case-search-config as a second consumer triggers the first-duplication rule: relocate the helper to `lib/agent/tools/shared/moduleNotFoundResult.ts` BEFORE adding the second copy. The case-list-config tools' `shared.ts` re-exports from the new location to keep the same import path stable for those tools.

**Structured-output ≤8-optional-fields ceiling** applies — `setCaseSearchDisplay` carries 6 optional fields plus `moduleIndex` (required). Verify via `scripts/test-schema.ts` lowering the input schema through `z.toJSONSchema` and feeding it into the Anthropic schema compiler.

**Module addressing.** Both tools take `moduleIndex: number` (0-based), mirroring the existing case-list-config family's pattern (`setCaseListFilter` and the 8 atomic-op tools all use `moduleIndex`).

**Read-tool projection.** `getModule` returns `mod.caseSearchConfig` verbatim when present. `summarizeBlueprint` adds a one-line surface per module: `"case_search: display={titleSet/subtitleSet/...} advanced={excludedOwnerIds|none}"` so the SA can resume from a fresh-session prompt without re-reading.

**Registration:** `lib/agent/solutionsArchitect.ts` adds the 2 tools to the shared set alongside the case-list-config family. `lib/mcp/server.ts` mirrors the registration.

**Tests:** each tool's input schema passes `scripts/test-schema.ts`; `execute` happy-path + module-not-found error arms; MCP wire envelope projection round-trips.

### Task 6: Platform-aware compilation decision tree

**Files:** `lib/commcare/suite/case-search/compileForPlatform.ts`, tests.

```ts
type PlatformContext = { platform: "android" | "web" };

interface WireShape {
  autoLaunch: boolean;
  defaultSearch: boolean;
  inlineSearch: boolean;
}

export function compileForPlatform(
  caseListConfig: CaseListConfig,
  caseSearchConfig: CaseSearchConfig,
  ctx: PlatformContext,
): WireShape;
```

Decision tree (no author override; pure inference from content + platform):

1. **Android** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: true }`. Android always shows the case list first regardless of any wire flag (per the spec's web-apps-shaped authoring principle).
2. **Web, `caseListConfig.filter` configured AND zero search inputs** → `{ autoLaunch: true, defaultSearch: true, inlineSearch: false }`. Skip-to-results — author intent is clear (filter narrows the list, nothing for the user to type, show filtered results immediately).
3. **Web fallback** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: false }`. List-first. Forcing a user to fill a search form before they see whether they have any local cases is worse UX than letting them see the list first.

The "filter configured" check is `caseListConfig.filter !== undefined && caseListConfig.filter.kind !== "match-all"`. The "zero search inputs" check is `caseListConfig.searchInputs.length === 0`.

**Verification gate (transferred from spec):** before locking emission code, the implementer reads `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py` to confirm how `auto_launch` propagates to the suite XML — specifically the `<query>` `auto_launch` attribute semantics and any case-search-vs-callout context divergence. Same gate covers `inline_search`'s real wire behavior (`instance('results')` vs `instance('results:inline')`). The implementer's commit body cites the relevant CCHQ source location by stable name (no line numbers per the standing rule).

**Tests:** each branch hit with a fixture; output asserted; absence of any "workflow mode" enum confirmed (Nova does not author the four CCHQ workflow modes — the four-shape compiler output is the only choice point and it's content-derived).

### Task 7: Search-results dual-detail emission

**Files:**
- `lib/commcare/suite/case-list/shortDetail.ts` (EDIT)
- `lib/commcare/suite/case-list/longDetail.ts` (EDIT)
- `lib/commcare/suite/case-list/compiler.ts` (EDIT)
- `lib/commcare/suite/case-list/__tests__/dualDetailEmission.test.ts` (NEW)

When the module has `caseSearchConfig`, the wire emitter produces TWO `<detail>` blocks per surface:

- `m{N}_case_short` — the local case-list short detail (existing emission; unchanged content).
- `m{N}_search_short` — the search-results short detail. Identical `<field>` content (same columns, filtered by `visibleInList ?? true`). Identical `<sort>` content (same `caseListConfig.columns[*].sort` projected through the existing `buildSortDirectives` + `emitSortBlock`).

Mirror for long: `m{N}_case_long` and `m{N}_search_long`. Identical content, filtered by `visibleInDetail ?? true`. No `<sort>` blocks on either long detail (CCHQ doesn't emit sort on long detail — the case is already selected).

The two wire IDs differ only in the `id=` attribute and the localization key prefix (`m{N}.case_short.*` vs `m{N}.search_short.*` — verify exact prefix during implementation against the fixture). Field `<template>` xpath functions reference `instance('casedb')` on `case_short` and `instance('results')` on `search_short` for any cross-case lookups; the `current()/index/parent` form for direct relations is identical on both.

**Wire fixture verification gate.** Implementer + reviewers verify the emitted XML matches `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml` byte-for-byte at the element-tree shape level. The fixture is the `<partial>` containing both `m0_case_short` (with sort) and `m0_search_short` (with same sort, instance-references rewritten). Golden-file test pins the structural identity.

**Behavior when `caseSearchConfig` is absent.** The orchestrator skips the dual-emit; only `m{N}_case_short` and `m{N}_case_long` emit. This matches the existing Plan 3 reshape behavior — the addition is a pure-additive branch when `caseSearchConfig` is present.

**Tests:** golden-file comparisons; visibility filter applies to both wire IDs; sort projection identity; module-without-caseSearchConfig emits only the case-list pair.

### Task 8: `<remote-request>` orchestrator + `<session>` sub-emitter

**Files:** `lib/commcare/suite/case-search/remoteRequest.ts` (NEW), `lib/commcare/suite/case-search/searchSession.ts` (NEW), `lib/commcare/compiler.ts` (EDIT), tests.

`remoteRequest.ts` is the top-level orchestrator that produces the `<remote-request>` element. It composes:

- `<post>` claim — from Task 9.
- `<command>` — search command label.
- `<instance>` declarations — from term-walking the AST.
- `<session>` — owned by `searchSession.ts` (this task), wraps `<query>` (which composes `<data>` slots + `<prompt>` slots from Task 10) and `<datum>`.
- `<stack>` — post-claim navigation; owned by `searchSession.ts`.

The XML shell follows `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml` byte-for-byte at the element-tree shape level.

`<query>` attributes (verified against `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::RemoteRequestQuery` and `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_remote_request_queries`):
- `url` — fixed CCHQ remote-search endpoint with `__DOMAIN__` / `__APP_ID__` placeholders that CCHQ's import path resolves at suite-XML regeneration time.
- `default_search` from Task 6's `WireShape.defaultSearch`.
- `storage-instance` from `WireShape.inlineSearch` — `"results"` standalone vs `"results:inline"` when inline.
- `template` — fixed `"case"`.

`auto_launch` (from `WireShape.autoLaunch`) and `inline_search` are NOT `<query>` attributes. `auto_launch` lands as `<action auto_launch>` inside `m{N}_case_short` (per CCHQ's wire layout in `search_command_detail.xml::detail/action[@auto_launch]`); the orchestrator threads the bool through to the case-list short-detail emitter (Task 7). `inline_search` is a CCHQ-internal Python flag at `module_uses_inline_search`; it picks the storage-instance identifier at emission time but is never serialized as a wire attribute.

**`<data>` slots inside `<query>`:**
- `case_type` — required, references `'<case_type>'`.
- `_xpath_query` — single AND-composed CSQL string. Compiles every contributing predicate from one source plus any advanced-arm search inputs:
  - `caseListConfig.filter` (when present) — the unified filter.
  - Each `caseListConfig.searchInputs[i]` whose `kind === "advanced"` — the `predicate` slot.
  - All contributions AND together at the AST level (`and(...)` builder) BEFORE compilation; the CSQL emitter receives one Predicate and emits one CSQL string. The wire layer carries one `<data key="_xpath_query">` element regardless of how many AST predicates contributed.
  - When the AND-composed result is `match-all` (no filter, no advanced inputs) the `<data key="_xpath_query">` element is omitted entirely (CCHQ accepts the absence cleanly).
- `commcare_blacklisted_owner_ids` — emitted when `caseSearchConfig.excludedOwnerIds` is set. The `ref` attribute is the compiled `ValueExpression` (compile via the on-device emitter; the result is an XPath expression evaluating to a space-separated list of owner IDs). CCHQ's `<query>`-side owner-exclusion filtering is owned at this layer (NOT the `<post>` element — verified against `~/code/commcare-hq/.../suite_xml/post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums` and `~/code/commcare-hq/.../tests/data/suite/search_config_blacklisted_owners.xml`). The CCHQ wire-side data key keeps its `blacklisted` token; only Nova's authoring vocabulary moves to `excludedOwnerIds`.
- `commcare_sort` — NEVER emitted. ES default `_score` ranking applies for fuzzy / phonetic / starts-with match results.

`<datum>`:
- `id="search_case_id"`.
- `nodeset="instance('results')/results/case[@case_type='X'][not(commcare_is_related_case=true())]"` — when `inlineSearch=false`.
- `nodeset="instance('results:inline')/results/case[@case_type='X'][not(commcare_is_related_case=true())]"` — when `inlineSearch=true`.
- `value="./@case_id"`.
- `detail-confirm="m{N}_search_long"`.
- `detail-select="m{N}_search_short"`.

`<stack>` — `<push><rewind value="instance('commcaresession')/session/data/search_case_id"/></push>` per the canonical fixture.

**Verification gate (carried over from spec):** before locking emission code, read `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py` to confirm `<query>` and `<datum>` attribute semantics. Cite by stable name (no line numbers).

**Tests:** golden-file comparisons against `remote_request.xml`, one fixture per platform × content combination matching the three-branch `WireShape` decision tree (Android / Web-skip-to-results / Web-list-first fallback). The `<data key="_xpath_query">` emission asserts AND-composition: a fixture with both a `caseListConfig.filter` AND an advanced-arm search input produces ONE `<data>` element whose CSQL is the AND-conjunction of both contributions.

### Task 9: Claim emission

**Files:** `lib/commcare/suite/case-search/claim.ts`, tests.

`<post url="..." relevant="...">` is the structural element CCHQ's runtime fires on case selection from search results to claim ownership. The element is wire-required regardless of authoring; Nova always emits it whenever a module carries `caseSearchConfig`.

The `relevant` attribute carries one static expression — CCHQ's `CaseClaimXpath.default_relevant`, lifted verbatim: `count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0`. Structural defense against repeat-claim writes (the underlying cause of the `state hash mismatch` log spam in CCHQ webapps logs — Nova emits the guard so we never make it worse). There is no author-controlled composition: every emission carries this exact guard string.

Inside `<post>`, ONLY:
- `<data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>` — required, always present. No other `<data>` children (the excluded-owners filter lives on `<query>`, not `<post>` — Task 8's territory).

The emitter is a small pure helper — five lines of XML produced from a fixed string template. No predicate compiler involvement, no AST traversal, no input dependency beyond knowing which case-search module is being emitted.

**Wire fixture verification gate.** Verify against `~/code/commcare-hq/.../tests/data/suite/remote_request.xml` for the `<post>` element shape and child ordering. CCHQ source citations for the static guard: `~/code/commcare-hq/.../models.py::CaseSearch.get_relevant`, `~/code/commcare-hq/.../xpath.py::CaseClaimXpath.default_relevant`. Cite by stable name (no line numbers).

**Tests:** golden-file comparison against `remote_request.xml`'s `<post>` shape — the emission is a single static template, so one golden file pins the contract.

### Task 10: Search prompts emission (per-arm dispatch)

**Files:** `lib/commcare/suite/case-search/searchPrompts.ts`, tests.

Each `caseListConfig.searchInputs[i]` becomes a `<prompt key="{input.name}" input="{input.type}">` element with optional `<display>` for label and `<default>` for default value (compiled from `input.default` via Plan 1's CSQL emitter).

**Per-arm dispatch:**

- **`kind: "simple"`** — emits the `<prompt>` element structurally identically. The simple-arm `(property, mode, via)` slots inform the prompt's *runtime semantics* via CCHQ-side machinery (CCHQ matches the prompt value against the property by mode at search execution time); the wire-emitted shape is the same `<prompt key=... input=...>` for every simple-arm row.

- **`kind: "advanced"`** — emits the `<prompt>` element identically AND the row's `predicate` is rolled into Task 8's AND-composition for `<data key="_xpath_query">`. The prompt declares the input slot; the `_xpath_query` CSQL clause references `instance('search-input:results')/input/field[@name='X']` to consume the input value at search time.

**Empty-input boilerplate.** Advanced-arm predicates referencing the input must wrap in the `whenInputPresent(input("name"), predicate)` AST node — the CSQL emitter generates the `if(count(input), predicate, true())` wrapper automatically. Authors don't write this; the validator (Task 11) ensures advanced-arm predicates either (a) don't reference the input at all (constant predicates) or (b) wrap input references through `whenInputPresent`.

**Tests:** each `input.type` (text / select / date / date-range / barcode) emits the right XML for both arms. Simple-arm emits the same shape regardless of `(property, mode, via)`. Advanced-arm `predicate` lowering exercised.

### Task 11: Validator rules

**Files:** `lib/commcare/validator/rules/case-search/*.ts`, `lib/commcare/validator/rules/case-list/*.ts`, `lib/commcare/validator/rules/module.ts` (EDIT), tests.

Rules registered in `module.ts`:

- **`searchButtonDisplayConditionTypeCheck`** — `caseSearchConfig.searchButtonDisplayCondition` (when present) predicate type-checks via Plan 1's predicate type checker against the module's `caseTypes` schema map. `input(...)` term references resolve through the type checker's native `knownInputs` mechanism — no separate input-reference rule needed; an unknown input name surfaces as a type-check failure.
- **`excludedOwnerIdsTypeCheck`** — `caseSearchConfig.excludedOwnerIds` (when present) value-expression type-checks with `expectedType: "text"`. The slot's authoring meaning is "evaluates to a space-separated text string of owner IDs," and the AST-strict contract narrows the top-level expectation to text.
- **`filterSearchInputConflict`** — when `caseSearchConfig` is present (i.e., the module emits a `<remote-request>`), no property may appear as both a `prop(...)` term inside `caseListConfig.filter` AND a simple-arm `caseListConfig.searchInputs[i].property`. Both contribute clauses to the same `<data key="_xpath_query">` AND-composition; CCHQ's runtime treats this as a config error. Dedup is via-aware: keys on `(destinationCaseType, property)` after via-walk via `checkRelationPath`. Elm-style error names the conflicting property + both surfaces.
- **`searchInputDefaultTypeCheck`** (under `case-list/`) — `caseListConfig.searchInputs[i].default` value-expression type-checks with per-widget `expectedType` from a `SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES` lookup. Lives under `case-list/` because `searchInputs` is owned by `caseListConfig`.
- **`searchInputPredicateTypeCheck`** (under `case-list/`) — advanced-arm `caseListConfig.searchInputs[i].predicate` predicate type-checks with `knownInputs` for cross-input ref resolution. Same scope reason.

**Tests:** each rule fires on bad input + passes on clean input. Integration test wires the case-search rules through `runValidation` against a fixture with overlapping property names + an unknown input reference inside `searchButtonDisplayCondition`.

### Task 12: `CaseSearchConfigPanel` + URL routing + ModuleScreen affordance

**Files:**
- `components/builder/case-search-config/CaseSearchConfigPanel.tsx` (NEW)
- `components/builder/case-search-config/__tests__/CaseSearchConfigPanel.test.tsx` (NEW)
- `lib/routing/types.ts` (EDIT)
- `lib/routing/location.ts` (EDIT)
- `lib/routing/hooks.tsx` (EDIT)
- `lib/routing/CLAUDE.md` (EDIT)
- `lib/routing/__tests__/location.test.ts` (EDIT)
- `components/preview/PreviewShell.tsx` (EDIT)
- `components/preview/screens/ModuleScreen.tsx` (EDIT)
- `components/preview/screens/__tests__/ModuleScreen.test.tsx` (EDIT)

**`CaseSearchConfigPanel.tsx`** — multi-section UI shell. Renders three sections in order: **Display → Search Inputs → Advanced**. Section order is load-bearing — Display sits at the top because the search-screen title and subtitle are the most prominent slots on the page; Advanced sits at the bottom because its current contents are niche affordances most authors never reach for. Sticky violet-railed section headers (mirror Plan 3's `CaseListSectionHeader` pattern). Single-scroll magazine layout. Reads `mod.caseSearchConfig` (every per-section mutator spreads `...(value ?? {})` before applying its patch, so first-edit emits a strict-parse-valid empty-but-present config) and `mod.caseListConfig.searchInputs` from the doc store; writes via `useBlueprintDocApi().updateModule(moduleUuid, ...)`.

**URL routing changes (the load-bearing fix vs the prior plan, which mis-cited `lib/preview/engine/types.ts`):**

- `lib/routing/types.ts` — extend the `Location` discriminated union with `| { kind: "search-config"; moduleUuid: Uuid }`. The full union now: `home | module | cases | form | search-config`.
- `lib/routing/location.ts` — `parsePathToLocation([moduleUuid, "search-config"], doc)` returns `{ kind: "search-config", moduleUuid }`; `serializePath({ kind: "search-config", moduleUuid })` returns `[moduleUuid, "search-config"]`. Mirror the `cases` arm's exact handling (including the `recoverLocation` fallback semantics).
- `lib/routing/hooks.tsx` — add `openSearchConfig(moduleUuid: Uuid)` to the actions returned by `useNavigate()`. Thread the new `kind` through `useBreadcrumbs` (label: `"Search Config"`).
- `lib/routing/CLAUDE.md` — add `/build/[id]/{moduleUuid}/search-config → search config` to the URL schema table.

**`PreviewShell.tsx`** — add a `loc.kind === "search-config"` branch. Edit mode: dispatch to `<CaseSearchConfigPanel moduleUuid={loc.moduleUuid} />`. Live mode: render a typed placeholder ("Live preview lands in a follow-up.") so the runtime never throws on the new kind. The live-mode dispatch lands in a follow-up plan; Plan 4's placeholder is a sentinel that gives the user a non-crash path until then.

**`ModuleScreen.tsx`** — add a "Search Config" affordance card alongside the existing "Case List" card. Card visibility: `mod.caseType !== undefined` (case-search authoring requires a declared case type). Click handler: `useNavigate().openSearchConfig(moduleUuid)`. Disabled-state rendering: when the module has no `caseType`, the card is greyed with a hover hint "Set a case type on this module to enable search authoring."

**Mount site (locked):** dedicated `/search-config` URL alongside `/cases`. The case-list workspace's three-section magazine stays focused on the case list; the case-search workspace lives separately. Two parallel scrolling workspaces is clearer than one mega-workspace, mirrors the spec's separation of "Case list config" and "Case search config" concerns, and respects the user's "no 4th tab in CaseListWorkspace" directive.

**User-runnable acceptance.** User runs `npm run dev`, opens an existing case-typed module, sees the "Search Config" affordance card on the module screen, clicks it. URL changes to `/build/{appId}/{moduleUuid}/search-config`. Sees the three-section authoring UI in order: Display, Search Inputs, Advanced. In the Display section, edits the search-screen title. Reloads the page. Sees the change persist (route round-trip; `mod.caseSearchConfig.searchScreenTitle` round-tripped through Firestore + the doc store).

**Tests:** Panel round-trip; URL round-trip via `parsePathToLocation` + `serializePath`; `useNavigate().openSearchConfig` triggers the right history-state push; ModuleScreen affordance card visible / disabled / click-dispatches under the three case-type states.

### Task 13: Plan 4 integration test

**Files:** `__tests__/integration/case-search-authoring.test.ts`.

End-to-end against the testcontainer harness:

- Build a fixture blueprint with `caseListConfig` (columns + sort + searchInputs) AND `caseSearchConfig` (display + advanced).
- Run the validator; assert clean.
- Construct a synthetic broken predicate (input ref to a non-declared name in `searchButtonDisplayCondition`); assert `searchButtonDisplayConditionTypeCheck` fires with Elm-style error.
- Construct a `filterSearchInputConflict` fixture (property `status` in both `caseListConfig.filter` AND a simple-arm `searchInputs[i].property`); assert rule fires.
- Emit `<remote-request>` via `remoteRequest.ts`; compare against golden file.
- Emit dual `<detail>` blocks via the case-list emitter (Task 7); compare against `search_command_detail.xml` golden file.
- Round-trip via `compileForPlatform` for Android + Web (skip-to-results + list-first fallback); verify the `WireShape` outputs against the three-branch decision tree.
- SA path: call `setCaseSearchAdvanced` and `setCaseSearchDisplay` through the agent layer; assert mutation effects on the doc store; assert the structured success result.
- Module-not-found Elm error arms for both tools.

**No Plan 5 dependencies.** This test verifies the authoring-side wire emission only. Postgres-side runtime behavior of the search-input UI lands in Plan 5.

---

## Dependencies between tasks

- 1 standalone (depends on Plans 1-3 + reshape).
- 2, 3 depend on 1 + Plan 3's editor primitives.
- 4 depends on 12 (the shell must exist before the cross-binding test can mount it) + Plan 3's `SearchInputsSection`.
- 5 depends on 1 + the existing case-list-config tool family pattern.
- 6 depends on 1.
- 7 depends on 1 + Plan 3 reshape's `case-list/` emitter (the file being EDITED).
- 8 depends on 1, 6, 9, 10 + Plan 1's CSQL emitter.
- 9 depends on 1 + Plan 1.
- 10 depends on 1 + Plan 3's discriminated `SearchInputDef`.
- 11 depends on 1 + Plan 1.
- 12 depends on 1, 2, 3 (the shell mounts DisplaySection, the cross-bound SearchInputsSection from Plan 3, and AdvancedSection).
- 13 depends on all prior.

**Topological ordering for the executor:** 1 → {2, 3, 5, 6} → {7, 9, 10, 11} → 8 → 12 → 4 → 13. Task 4 sits AFTER Task 12 in execution order despite its lower task ID — Task 4 verifies a contract Task 12 establishes. The numbering reflects authoring grouping (UI sections cluster as Tasks 2-4); the executor follows dependencies, not numbers.

## Reviewer instructions for wire-emission tasks (Tasks 6-10)

Every wire-emission task's spec-compliance + code-quality reviewer prompt names the relevant CCHQ fixture(s) the implementer must hold the emitted XML against. Reviewers verify the bytes Nova emits would be accepted by CCHQ's importer — the validity check, NOT a copy of CCHQ's authoring shape (which Nova rejects). Authoring-shape rejection and wire-shape verification are independent concerns.

| Task | CCHQ fixtures |
|---|---|
| 6 — `compileForPlatform` | `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py` (cited by stable name) |
| 7 — Dual-detail emission | `tests/data/suite/search_command_detail.xml` (`m0_case_short` + `m0_search_short` carry identical content) |
| 8 — `<remote-request>` | `tests/data/suite/remote_request.xml` |
| 9 — Claim emission | `tests/data/suite/search_config_blacklisted_owners.xml`, `case-search-with-action.xml`, `case-search-again-with-action.xml` |
| 10 — Search prompts | `tests/data/suite/remote_request.xml` (the `<prompt>` block) |

Reviewers report any structural divergence at the element-tree shape level (tag names, attribute names, child ordering) as a blocker. Cite by stable name (`file.xml::<element_path>`); never line numbers per the standing rule.

## Final verification

- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (whole-graph after Task 13).
- [ ] `npm run build` clean.
- [ ] `npm test` green (full suite, deterministic two consecutive runs).
- [ ] Integration test (Task 13) passes.
- [ ] Cross-check `<remote-request>` emission against `remote_request.xml`.
- [ ] Cross-check dual-detail emission against `search_command_detail.xml`.
- [ ] Cross-check claim wire shape against `search_config_blacklisted_owners.xml`.
- [ ] **User-runnable acceptance:** User runs `npm run dev`, opens an existing case-typed module, clicks the "Search Config" affordance card on the module screen. URL changes to `/build/{appId}/{moduleUuid}/search-config`. Sees the three-section authoring UI in order: Display, Search Inputs, Advanced. In the Display section, edits the search-screen title. Reloads the page. Sees the change persist (the value round-tripped through the doc store + Firestore + the route).

## Plan shape

Plan 4's weight is dominated by the wire emitter (Tasks 7-10) and the platform-aware compilation decision tree (Task 6). Tasks 1-4 build the schema + UI sections; 5 ships the 2 SA tools; 6 implements the decision tree (export-side, no author UI); 7 extends the case-list emitter for dual-detail emission; 8-10 emit suite XML for the case-search-specific elements; 11 runs validators; 12 mounts the workspace; 13 is the integration test. The author-facing live preview is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule — there is no per-platform divergence panel; per-runtime UX differences are CCHQ-side concerns the export adapter handles silently.

## What this plan does NOT change

- `caseListConfig` shape (Plan 3 + reshape ship the v2 shape; Plan 4 reads it).
- The Predicate / ValueExpression AST families and their card-based editors.
- The seven `SearchInputMode` arms.
- The discriminated `SearchInputDef` simple/advanced shape (Plan 3 reshape).
- The doc store's `updateModule(uuid, { caseSearchConfig })` surface.
- Saga pattern, WeakMap-keyed validity shadow, declarative editor-schema pattern.
- The 8 atomic-op SA tools on `caseListConfig` (Plan 3 reshape).
- `lib/db/applyBlueprintChange.ts` — touches `caseTypes` only.
- `lib/commcare/session.ts` — touches `caseListConfig.filter` only (which Plan 4 reuses, doesn't reshape).
- `lib/commcare/suite/case-list/nodesetFilter.ts` — case-list nodeset filter slot is unchanged; Plan 4 adds the search-side `<data key="_xpath_query">` emission separately.

## SHIPPED

### Task 1 — `caseSearchConfig` schema — 2026-05-08

Landed across three commits: `f10a82e6` (initial schema + 9 tests) → `4915690f` (CR round-1 fix-pass — JSDoc rewritten in authoring voice; dropped the `<data key="blacklist">` XML literal from the excluded-owners field comment; trimmed the schema header) → `86f7e18d` (CR round-2 fix-pass — dropped wire-emission narration from header + excluded-owners test comment; renamed historical CCHQ-leak field names in the strict-rejection test to `__unknown_a/_b/_c`).

**Final shape:**
- `caseSearchConfigSchema` is `z.object({ ... }).strict()` with 9 fields. `dontClaimAlreadyOwned: z.boolean()` is required at the schema level (no default); other fields are optional (`claimCondition`, `excludedOwnerIds` for claim; six display labels for the display cluster).
- `caseSearchConfig: caseSearchConfigSchema.optional()` added to `moduleSchema` — modules without case-search authoring don't carry the slot.
- `CaseSearchConfig` type derived via `z.infer<>`. Re-exported through `lib/domain/index.ts`'s wildcard barrel — no explicit edit needed.
- No builder helper added (matches the existing `caseListConfig` pattern, which has no top-level builder).

**Test count:** 564 / 564 green in `lib/domain` (8 new tests for caseSearchConfig: full-populated round-trip, minimal round-trip, missing-required rejection, type-error rejection, strict-mode unknown-key rejection, explicit-undefined optional handling, module-without-slot, module-with-both-configs).

**Acceptance gates landed:**
- `npm run lint -- lib/domain` clean.
- `npm test -- lib/domain` green (deterministic two runs).
- `npx tsc --noEmit` clean (purely additive change — no consumer breakage).
- Sweeps clean: zero line-number citations, zero CCHQ-leak field name references, zero external-doc references.

**Deltas from the planned shape:** none structural.

**Whole-repo build state:** green throughout (the schema addition is purely additive; consumers ignore the new optional slot until Task 12 mounts the workspace).

**Option A — `dontClaimAlreadyOwned` dropped 2026-05-08.** CCHQ's `additional_relevant` (the field a "skip already-owned" toggle would compile to) is gated behind the `CASE_SEARCH_DEPRECATED` feature flag for authoring; the runtime is alive but the authoring affordance is being wound down. The toggle was a Nova-invented affordance over a wind-down field. Schema removed across `lib/domain/modules.ts::caseSearchConfigSchema` + `lib/domain/__tests__/modules.test.ts`. Every `caseSearchConfig` slot is now optional; the empty `{}` shape is a valid persisted state. The `claimCondition` Predicate Card editor remains as the only authoring affordance for claim conditions.

**Next:** Task 2 — Claim section UI.

### Task 2 — Claim section UI — 2026-05-08

Landed across six commits: `fa6ef683` (initial ClaimSection + 8 tests) → `a8de7358` (extract `PredicateSlotCard` primitive; refactor `FiltersSection` + `ClaimSection` to use it) → `27d3bbcb` (relocate `useValidityPropagator` from `components/builder/case-list-config/useInnerValidityShadow.ts` to `components/builder/shared/useInnerValidityShadow.ts`; 8 consumer import-path updates) → `0440b471` (doc-only cleanup of stale path references post-relocation) → `083a1e79` (CR-round-1 cleanup: snapshot consumer lists reframed as scope descriptions, filter-branded action icons swapped to generic glyphs, `expectedType="text"` wired on the excluded-owners editor, round-trip test split into per-invariant blocks, preservation test added) → `286703c5` (CR-round-2 cleanup: wire-narration dropped from authoring-voice surfaces in Task 2 scope).

**Final shape:**

- `components/builder/case-search-config/ClaimSection.tsx` (NEW) — three sub-controls authoring `mod.caseSearchConfig`'s claim cluster: claim condition (mounts `<PredicateSlotCard>`), don't-claim-already-owned toggle (default `false`), excluded owner IDs (collapsed-by-default `<ExpressionCardEditor>` with `expectedType="text"`). The excluded-owners editor stays mounted unconditionally when the slot is defined; collapse toggles visibility via the `hidden` attribute, not unmount, so backend-loaded invalid expressions surface their type-check verdict on first render. The `nextConfig` helper seeds `{ dontClaimAlreadyOwned: false }` on first edit so the parent never sees a partial config that fails strict parse, and spreads unrelated slots so a per-slot mutator doesn't lose the rest. Section validity = `predicateValid && (!exclusionPresent || expressionValid)`; the toggle is always valid.

- `components/builder/shared/PredicateSlotCard.tsx` (NEW) — extracted shared primitive owning the "optional `Predicate` slot with section-header chrome + add-clear affordance + slot-presence body switch" shape. Two consumers at landing time: `FiltersSection`'s filter slot, `ClaimSection`'s claim-condition slot. Add affordance emits `matchAll()`; clear emits `undefined` (matches the schema's `.optional()` slot type). Mounts `<PredicateCardEditor>` when the slot is defined; threads validity through `useValidityPropagator` with a slot-presence short-circuit (`!slotPresent || predicateValid`). Action-button glyphs are generic `tabler/plus` + `tabler/x` so the primitive isn't filter-branded.

- `components/builder/shared/useInnerValidityShadow.ts` (MOVED via `git mv`) — relocated from `components/builder/case-list-config/`. Eight consumers across two workspaces (`FiltersSection`, `DisplaySection`, `SearchInputsSection`, `ColumnEditor`, `ExpressionCardEditor`, `PredicateCardEditor`, `ClaimSection`, `PredicateSlotCard`) import from the new shared/ home. The `useValidityPropagator` hook + the `useInnerValidityShadow` (WeakMap-backed sibling for per-row validity) are the canonical validity-propagation utilities for any editor with an `onValidityChange` prop.

- `components/builder/case-list-config/FiltersSection.tsx` (REFACTORED) — chrome moved into the `PredicateSlotCard` primitive; the section shrank from 249 to 142 lines. The section's existing observable behavior is preserved (top-level wrapper + status-density line + preview affordance stay).

- `components/builder/CLAUDE.md` (UPDATED) — new "shared primitives" content describes `PredicateSlotCard`'s role-and-shape (not a snapshot consumer list), the `useInnerValidityShadow` hook home, and how the case-list-config workspace section consumes both. The case-list-config section's `useValidityPropagator` references now point at the shared/ home.

**Test count:** 3858 / 3858 green across 227 test files (deterministic two runs). +3 from Task 2's introduction (ClaimSection +8, PredicateSlotCard +8, FiltersSection unchanged at 8 — the round-trip test split added 2; the preservation test added 1).

**Acceptance gates landed:**

- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- `npm test` 3858 / 14 skipped.
- Drift sweeps clean: zero `case-list-config/useInnerValidityShadow` references after the relocation; zero `tablerFilter` glyphs in the cross-section primitive or the inline excluded-owners chrome; zero `Today's consumers|Currently used by` snapshot lists in `shared/`; zero `wire emitter|wire layer` references in the Task 2-scope authoring-voice surfaces (the cross-layer wire-coordination comments in `DisplaySection` and `SearchInputsSection` stay — they name load-bearing contracts the authoring code's correctness depends on).

**Deltas from the planned shape:** The plan named `ClaimSection.tsx` + tests. Scope expanded to extract `PredicateSlotCard` (first-duplication on FiltersSection) and to relocate `useValidityPropagator` to its cross-family home in `shared/`. Both expansions were structurally justified.

**Acknowledged structural debt:** `PredicateCardEditor` itself wasn't relocated to `shared/` — its transitive import graph (~25-30 files: `cards/ChildPredicateEditor` → all 13 predicate cards → `editorContext` + `path` + `editorSchemas` + `expressionEditorSchemas` + `ExpressionCardEditor` + `primitives/`) is a half-directory rename, slated between Task 12 (workspace mount) and Task 13 (integration test). The `OptionalSlotCard<T>` generalization that would unify `PredicateSlotCard`'s chrome with `ClaimSection`'s inline `ValueExpression` excluded-owners chrome is part of the same reorg.

**Whole-repo build state:** green throughout. Task 2's deliverables compose into Task 12's workspace shell when that lands.

**Option A — `dontClaimAlreadyOwned` dropped 2026-05-08.** The toggle, header chrome, `Toggle` import, and the toggle-persistence test block were removed from `ClaimSection.tsx`. The section now mounts only the claim-condition `<PredicateSlotCard>` and the excluded-owner-IDs `<ExpressionCardEditor>`. Section validity = `predicateValid && (!exclusionPresent || expressionValid)`. The `claimCondition` Predicate Card editor remains as the only authoring affordance for claim conditions; CCHQ's `additional_relevant` (the underlying runtime field) is alive but its CCHQ-side authoring UI is gated `CASE_SEARCH_DEPRECATED`.

**Next:** Task 3 — Display section UI.

### Task 3 — Display section UI — 2026-05-08

Landed across two commits: `4c71b1f4` (initial DisplaySection + tests + extracted `nextConfig` shared helper; 21 tests in case-search-config + ClaimSection refactored to import the shared helper) → `30708a55` (CR round-1 fix-pass: spurious-emit no-op gate on focus-blur of an undefined slot + consumer-snapshot rewording in the file header).

**Final shape:**

- `components/builder/case-search-config/DisplaySection.tsx` (NEW) — six controls authoring `mod.caseSearchConfig`'s display cluster: five optional text slots (`searchScreenTitle`, `searchScreenSubtitle` with markdown affordance, `emptyListText`, `searchButtonLabel`, `searchAgainButtonLabel`) routed through a local `OptionalTextRow` primitive, plus `searchButtonDisplayCondition` mounted via the shared `<PredicateSlotCard>` primitive. Section-overall validity = `(!searchButtonDisplayConditionPresent || predicateValid)`; the five text slots are always valid (string slot, no validation states). Empty-string-clears: when a text input value transitions to `""`, the `nextConfig` setter writes `undefined` so strict-parse drops the slot.

- `components/builder/case-search-config/OptionalTextRow` (local primitive inside DisplaySection.tsx) — five-slot row primitive built on `useCommitField`. Single-line `<input>` for plain text slots; `<textarea>` + a "Markdown" badge + live `<PreviewMarkdown>` panel when the `markdown` flag is set. `useId()` + `htmlFor` for label-input binding so `getByLabelText` resolves correctly in tests. The `onEmpty` callback gates on `value !== undefined` — focus-blur-without-typing AND Esc-on-empty are no-ops when the slot was never set, so a passive interaction can't trigger a spurious autosave write or undo-history entry.

- `components/builder/case-search-config/nextConfig.ts` (NEW) — extracted shared helper consumed by both ClaimSection (refactored to import) and DisplaySection. Accepts `(current: CaseSearchConfig | undefined, patch: Partial<CaseSearchConfig>)` and returns a fully-formed `CaseSearchConfig` with `dontClaimAlreadyOwned: false` seeded when `current` is undefined. Spread order is `...base, ...patch` so untouched siblings flow through every per-slot mutator. First-duplication discipline applied on the second consumer.

- `components/builder/case-search-config/ClaimSection.tsx` (MODIFIED) — drops the inline `nextConfig` helper, imports from the shared location.

**Markdown affordance choice:** the `searchScreenSubtitle` slot uses textarea + live `<PreviewMarkdown>` rather than the project's TipTap-based `InlineTextEditor`. The TipTap editor is a heavyweight WYSIWYG primitive scoped for inline label/hint editing in the form preview — wrong shape for an authoring-side multi-line markdown text slot. The fallback path (textarea + live preview + a "Markdown" badge near the label) matches the spec's stated fallback and reads cleanly in the workspace.

**Test count:** 3869 / 3869 green across 227 test files (deterministic two runs). +11 from Task 3's introduction (DisplaySection has 10 tests; ClaimSection's 11 tests pass post-refactor). +1 from the round-1 fix-pass's spurious-emit regression test.

**Acceptance gates landed:**

- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- `npm test` 3869 / 14 skipped.
- Drift sweeps clean: zero `wire emitter|wire layer|wire emit` references in the Task 3-scope authoring-voice surfaces, zero `Today's consumers|Currently used by|Consumers right now|Filters and Claim sections|sections consume` snapshot lists, zero line-number citations in committed comments, zero `Plan 4|Plan N|spec section|SHIPPED` references.

**Deltas from the planned shape:** The plan listed only `DisplaySection.tsx` + tests. Scope expanded to extract `nextConfig` (first-duplication on the second consumer) and a local `OptionalTextRow` primitive owning the five text-slot chrome.

**Whole-repo build state:** green throughout. Task 3's deliverables compose into Task 12's workspace shell when that lands.

**Option A — `dontClaimAlreadyOwned` dropped 2026-05-08.** The shared `nextConfig.ts` helper was removed (its sole purpose was seeding `{ dontClaimAlreadyOwned: false }` on the absent→empty transition; with the field gone, the helper collapses to `{ ...(value ?? {}), [slot]: next }` and inlines cleanly into both ClaimSection and DisplaySection per-slot mutators). Test rationales that cited the seeded default were rewritten to reference the new "absent vs empty config" boundary.

**Next:** Task 4 — Embed Search Inputs section (cross-binding test). Task 4 sits AFTER Task 12 in execution order despite its lower task ID — Task 4 verifies a contract Task 12 establishes; the executor follows dependencies, not numbers.

### Task 5 — SA tools (claim + display) — 2026-05-08

Landed at commit `4f97c7da`. Spec review (sonnet, ONCE) clean; CR round 1 (opus, fresh agent) Approved with three observation-only Minors.

**Final shape:**

- `lib/agent/tools/case-search-config/setCaseSearchClaim.ts` (NEW) — wholesale-replace tool for the claim cluster (`claimCondition`, `dontClaimAlreadyOwned`, `excludedOwnerIds`). Slots are `.nullable()` (NOT `.optional()`) — required-and-nullable shape mirrors `setCaseListFilter` exactly. Optional-count-zero on the schema; well under the Anthropic 8-optional ceiling. Mutation tag `module:M:caseSearch:claim`. Structured success carries `claimConditionKind: Predicate["kind"] | "cleared"` discriminator.

- `lib/agent/tools/case-search-config/setCaseSearchDisplay.ts` (NEW) — wholesale-replace tool for the display cluster (six text + predicate slots). Same `.nullable()` pattern. Mutation tag `module:M:caseSearch:display`. Structured success carries `displaySlotsSet: readonly DisplaySlotName[]` (a list, not a single discriminator — six independent slots warrant a list). Bootstrap-default seeding (`dontClaimAlreadyOwned: false`) gates on `mod.caseSearchConfig === undefined` so a display-only edit on a fresh module produces a strict-parse-valid config without overwriting an existing toggle value.

- `lib/agent/tools/case-search-config/shared.ts` (NEW) — `snapshotCaseSearchConfig(mod: Module): CaseSearchConfig | undefined` helper (Pattern A) + Zod input schemas for both tools.

- `lib/agent/tools/shared/moduleNotFoundResult.ts` (NEW) — first-duplication relocation. Helper moved from `lib/agent/tools/case-list-config/shared.ts` BEFORE adding the second consumer. The case-list-config `shared.ts` now re-exports from the new shared/ location so the 9 existing case-list-config tool import paths stay stable.

- Registration sweep complete: `solutionsArchitect.ts` (chat surface), `lib/mcp/server.ts` (MCP parity, `set_case_search_claim` + `set_case_search_display`), `getModule.ts` projection includes `case_search_config: mod.caseSearchConfig ?? null`, `summarizeBlueprint.ts` adds `summarizeCaseSearch` (one-line per-module rendering of claim + display state), `prompts.ts` INITIAL_BUILD step names the new tools + cross-binding rule (search inputs stay on `caseListConfig.searchInputs`, never inside case-search tools), `updateModule.ts` JSDoc parallel reference, `lib/agent/CLAUDE.md` documents the new family, `scripts/test-schema.ts` registers both tools in the live-API harness.

- Tests: 25 new tests across 4 new test files. Coverage includes happy path + structured-success discriminator + null-clears semantic (keys omitted, not undefined) + cross-cluster preservation (sibling cluster survives byte-identically) + fresh-module bootstrap + module-not-found Elm-style error + cross-surface parity (chat + MCP produce structurally-identical mutation batches).

**Test count:** 3899 → 3913 (final count after the supplemental tests in `__tests__/moduleNotFoundResult.test.ts` and the schema structural-defense file). The implementer's commit body reported +25 across 4 files; the actual baseline-to-final delta is 3874 → 3913 (+39) when measured against `081c829e`.

**Acceptance gates landed:**

- `npm run lint` clean (1020 files).
- `npx tsc --noEmit` clean.
- `npm test` 3913 / 14 skipped.
- Drift sweeps clean: zero `Today's consumers|Currently used by|Consumers right now` snapshot lists, zero `Plan 4|Plan N|spec section|SHIPPED` references, zero line-number citations in committed comments, zero wire-emit narration in the schema-touching tool surfaces.

**Deltas from the planned shape:** The plan originally listed four tools (`setCaseSearchClaim` / `setCaseSearchDisplay` / `setCaseSearchDefaultFilters` / `setCaseSearchCustomSorts`); the 2026-05-08 reshape dropped `defaultFilters` / `customSorts` / `sortByRelevance` from the schema, leaving two. The drop is consistent across schema (Task 1) → SA tools (Task 5) → wire emission (Tasks 8-10); Plan 5 synced.

**CR round-1 observation-only Minors (none blocking):**
1. Commit body's test-count delta cited as `+25` against the 3874 baseline; actual delta is `+39` to 3913. Captured here in the SHIPPED block at the correct count.
2. `setCaseSearchDisplay`'s rebuild logic types the temporary as `Record<DisplaySlotName, unknown>`. A more precise type (`Record<DisplaySlotName, string | Predicate | null>`) is possible; current shape's only op is `!== null` so the loose type doesn't bite at runtime. Acceptable as-is.
3. The conditional-spread fan-out across six display slots could refactor to a loop. Current explicit form mirrors `setCaseListFilter`'s exact pattern for family parity. Stylistic, not blocking.

**Whole-repo build state:** green throughout.

**Option A — `dontClaimAlreadyOwned` dropped 2026-05-08.** Removed from `setCaseSearchClaimBodySchema` + the tool's input destructure + the `SetCaseSearchClaimSuccess` interface + the strip-and-rebuild's existing-cluster destructure. The tool now takes `{ claimCondition, excludedOwnerIds }` (each `.nullable()`); structured success carries only `claimConditionKind`. `setCaseSearchDisplay`'s bootstrap-default seed dropped the `dontClaimAlreadyOwned: false` rebuild base — a fresh-module display edit now produces a config carrying only the supplied display slot. SA-prompt narration in `lib/agent/CLAUDE.md` + `summarizeBlueprint.ts::summarizeCaseSearch` updated to drop the flag. The `claimCondition` Predicate Card editor on the SA boundary remains as the only authoring affordance for claim conditions.

**Next:** Task 6 — Platform-aware compilation decision tree (running in parallel with this plan-sync).

### Task 6 — Platform-aware compilation decision tree — 2026-05-08

Landed at commit `45b91fe3`. Spec review (sonnet, ONCE) clean; CR round 1 (opus, fresh agent) APPROVED with no issues.

**Final shape:**

- `lib/commcare/suite/case-search/compileForPlatform.ts` (NEW, 147 lines) — pure decision-tree function `compileForPlatform(caseListConfig, caseSearchConfig, ctx) → WireShape`. Total over the input domain; four branches dispatch-by-condition: Android invariance (1) → web split-screen (2) → web skip-to-results (3) → web list-first fallback (4). Match-all carve-out: a filter set to `{ kind: "match-all" }` is treated as absent (boolean-algebra identity element).

- `lib/commcare/suite/case-search/types.ts` (NEW, 95 lines) — four supporting types: `Platform` (closed-set union), `PlatformFlags`, `PlatformContext = { platform; flags }` (compositional), `WireShape` (`readonly` boolean fields). The new directory `lib/commcare/suite/case-search/` is created by this task; subsequent tasks (7 dual-detail emission, 8 `<remote-request>` orchestrator, 9 claim emission, 10 search prompts) add sibling files.

- `lib/commcare/suite/case-search/__tests__/compileForPlatform.test.ts` (NEW, 332 lines) — 14 tests across four describe shells: Android invariance (4 tests verifying all content variants produce the same output), web split-screen (2), web no-split-screen sub-shapes (5 incl. match-all carve-out), purity (3: idempotency + immutability of both input configs).

**CCHQ verification gate (honored):** the implementer cited `details.py::DetailContributor._get_auto_launch_expression`, `remote_requests.py::RemoteRequestFactory.build_remote_request_queries`, `entries.py::EntriesHelper.get_query_datums`, `util.py::module_uses_inline_search` by stable name — verified against the actual CCHQ source. Three semantics confirmed:
1. `auto_launch` lives on `<action auto_launch="...">` inside `m{N}_case_short` (NOT on `<query>` or `<remote-request>`). Wire form is an XPath expression.
2. `default_search` is an attribute on `<query>` inside `<remote-request>/<session>`.
3. `inline_search` selects the storage-instance identifier on the search-side `<datum nodeset>` — `instance('results')` standalone vs `instance('results:inline')` inline.

**Structural finding routed to Task 8:** CCHQ's `module_uses_inline_search` requires `auto_launch=true` (boolean AND of three flags). Two of the decision tree's branches (Android + web split-screen) emit `{ autoLaunch: false, inlineSearch: true }` — CCHQ's runtime helper short-circuits the inline post-and-query embedding for those combinations. The decision tree expresses platform intent faithfully; the wire-emission orchestrator (Task 8) decides whether to emit the redundant flag faithfully or omit, given the runtime semantic. Documented in the commit body for Task 8's implementer.

**Test count:** 3913 / 14 skipped (deterministic two runs). +14 from baseline.

**Acceptance gates landed:**
- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- Drift sweeps clean: zero line-number citations in committed code, zero Plan 4 / spec section / SHIPPED references, zero consumer-inventory snapshots.
- CR-spotted side observation: pre-existing line-number citation in `lib/commcare/expression/csqlEmitter.ts:163`'s throw-message body — NOT introduced by Task 6, but a real "no line numbers in committed code" hard-gate violation. Cleanup tracked separately.

**Deltas from the planned shape:** None. The implementation matches the plan's branch table exactly. `types.ts` decomposed into `Platform | PlatformFlags | PlatformContext` rather than the flat shape the prompt suggested — matches the case-list package's existing convention.

**Whole-repo build state:** green throughout. Task 6's `WireShape` type is the contract Task 8's `<remote-request>` orchestrator consumes.

**Next:** Tasks 7 (dual-detail emission), 9 (claim emission), 10 (search prompts), 11 (validators), 8 (`<remote-request>` orchestrator — depends on 6 + 9 + 10), 12 (workspace mount), 4 (cross-binding test, after 12), 13 (integration test).

### Task 6 addendum — `splitScreen` dropped from `WireShape` — 2026-05-09

**Drop:** `splitScreen: boolean` field on `WireShape` and the supporting `splitScreenAvailable: boolean` flag on `PlatformFlags`. With `splitScreenAvailable` removed, the `PlatformFlags` interface itself is empty and goes too — `PlatformContext` reduces to `{ platform: Platform }`.

**Why the original premise was wrong:** Task 6's JSDoc claimed `splitScreen` lands on the `<query>` element as a wire attribute on deploys with `SPLIT_SCREEN_CASE_SEARCH` enabled. That claim is unsupported by CCHQ's source — `rg "split_screen|SPLIT_SCREEN" commcare-hq/corehq/apps/app_manager/suite_xml/` returns zero matches. CCHQ's Python suite emission is unconditional with respect to the toggle. The runtime gate lives entirely in formplayer's Java layer at `formplayer/src/main/java/org/commcare/formplayer/beans/menus/EntityListResponse.java::EntityListResponse`, which checks `TOGGLE_SPLIT_SCREEN_CASE_SEARCH` and conditionally populates `queryResponse` for the front-end JS to render the split-screen UX. The toggle's effect is 100% runtime / front-end; there is no wire-format surface for Nova to gate on.

**Branch-2 disposition:** the original Task 6 had four branches; branch 2 ("Web + split-screen available") returned `{ inlineSearch: true, splitScreen: true }`. With `splitScreenAvailable` gone, branch 2 had no triggering condition, so it folds into branch 4 (web fallback). Post-drop the decision tree is three branches:

1. Android → `{ autoLaunch: false, defaultSearch: false, inlineSearch: true }`.
2. Web + filter-effective + zero inputs → `{ autoLaunch: true, defaultSearch: true, inlineSearch: false }` (skip-to-results).
3. Web fallback → `{ autoLaunch: false, defaultSearch: false, inlineSearch: false }` (list-first).

Web no longer emits `inlineSearch: true` from any branch — only Android does. The supersedes clause from Task 6's "Structural finding routed to Task 8" tightens accordingly: only the Android branch produces the `{ autoLaunch: false, inlineSearch: true }` combination that CCHQ's `module_uses_inline_search` short-circuits; Task 8's web emission has no parallel case to reckon with.

**Files updated:**
- `lib/commcare/suite/case-search/types.ts` — drop `PlatformFlags` interface and `flags` field on `PlatformContext`; drop `splitScreen` field on `WireShape`. JSDoc rewritten for the three-flag shape.
- `lib/commcare/suite/case-search/compileForPlatform.ts` — fold branch 2 into branch 4; rewrite JSDoc to enumerate three flags / three branches.
- `lib/commcare/suite/case-search/__tests__/compileForPlatform.test.ts` — collapse the four-branch test organization to three (drop the "web + split-screen available" describe shell entirely; drop the "split-screen flag dominates" Android case as the flag no longer exists). Test count: 11 (was 14).
- `docs/plans/2026-05-01-search-authoring.md` — Task 6 plan body's `PlatformContext` / `WireShape` definition + branch table updated to three-flag / three-branch shape.

**Whole-repo build state:** green throughout. Lint, `tsc --noEmit`, and `npm test` all clean post-change.

### Task 7 — Dual-detail emission — 2026-05-08

Landed at commit `c454265f`. Spec review (sonnet, ONCE) clean; CR round 1 (opus, fresh agent) APPROVED with two observation-only Minors.

**Final shape:**

- `lib/commcare/suite/case-list/types.ts` (EDIT) — added `DetailTarget` type (closed-set union `"case" | "search"`), extended `CaseListEmitContext` with the `target` field as a second axis orthogonal to `detailKind`.

- `lib/commcare/suite/case-list/columns.ts` (EDIT) — 2D `DETAIL_LOCALE_TYPE` lookup `(target × detailKind)` produces the four canonical CCHQ tokens (`case_short` / `case_long` / `search_short` / `search_long`). `rewriteCasedbToResults` helper rewrites `instance('casedb')/casedb/case[` → `instance('results')/results/case[` only on the search target; preserves other instance references (`instance('reports')`, etc.). `rewriteSortDirectiveForTarget` helper rewrites calc-arm sort directives' xpath when target is search; property-rooted directives need no rewrite (bare property name has no instance prefix).

- `lib/commcare/suite/case-list/shortDetail.ts` (EDIT) and `lib/commcare/suite/case-list/longDetail.ts` (EDIT) — both accept the `target` parameter (default `"case"` for backward-compat with existing callers); detail id composes `m{N}_{target}_{short|long}`.

- `lib/commcare/compiler.ts` (EDIT) — orchestrator emits the search variant when `mod.caseSearchConfig` is present (additive branch; case-only modules emit identically to before).

- `lib/commcare/suite/case-list/__tests__/dualDetailEmission.test.ts` (NEW) — 12 tests across four shells:
  1. Absent `caseSearchConfig` → only case pair emits.
  2. Present `caseSearchConfig` → 4 blocks emit (case_short + search_short + case_long + search_long).
  3. Identical `<field>` + `<sort>` content between case_target and search_target.
  4. Locale-key prefix swap (`m{N}.case_short.*` ↔ `m{N}.search_short.*`) + instance-reference rewrite for cross-case lookups.

**Path chosen: B** — `target: "case" | "search"` as a second axis on `CaseListEmitContext` orthogonal to `detailKind`, with the orchestrator owning the dual-emit decision. Single emitter handles both targets; reuse > parameterize. Mirrors the existing context's discriminator-axis pattern.

**CCHQ fixture findings (verified against `commcare-hq/.../tests/data/suite/search_command_detail.xml`):**
1. The `case_<field>_<n>` suffix on header locale ids retains its leading `case_` literal token even on `search_short` / `search_long` — fixture's `m0.search_short.case_name_1.header` confirms (this is CCHQ's `column.model = 'case'` projection, independent of the detail-type substring).
2. Both `m0_search_short` and `m0_search_long` carry the same `<title>` shell with `cchq.case` locale.
3. `m0_search_long` carries no `<sort>` blocks (matches the case-long suppression rule).

**Plan-text correction (cited for completeness):** the plan's Task 7 file list named `lib/commcare/suite/case-list/compiler.ts`. The actual orchestrator is `lib/commcare/compiler.ts` (no `suite/case-list` prefix). The implementer correctly edited the right file.

**Test count:** 3942 → 3942 (the +12 from this task plus +18 from Task 11 — the suite count was already 3942 from Task 11's commit landing first).

**Acceptance gates landed:**
- `npm run lint` clean.
- `npx tsc --noEmit` clean (in scope; two unrelated TS errors flagged by the CR live in Task 10's + Task 12's in-flight scopes; their implementers resolve on commit).
- `npm test` 3942 / 14 skipped.
- Drift sweeps clean.

**CR round-1 Minor observations (none blocking):**
1. Calc-column locale-id swap on search target isn't pinned by a dedicated test invariant. The fixture-verified structure (`m0.search_short.case_calculated_property_<n>.header`) is correct in the implementation; one assertion would close the test gap. Acceptable as-is; flagged for future tightening.
2. The byte-identity test uses `expect(suiteXml).toContain(direct.xml)` (substring), the surrounding comment reads slightly stronger than substring containment validates. Either tighten or relax the comment. Stylistic.

**Whole-repo build state:** green. Task 7's dual-detail emission composes into Task 8's `<remote-request>` orchestrator (the `<datum>` element references `m{N}_search_short` and `m{N}_search_long` per the canonical fixture).

**Next:** Task 11 fix-pass for the round-1 CR's findings (Critical: `filterSearchInputConflict` dedup ignoring `via`; Important: drop Rule 1 + add 4 type-check rules for the slots the plan claimed were covered but weren't).

### Task 10 — Search prompts emission — 2026-05-08

Landed across two commits: `da4db02b` (initial implementation; DONE_WITH_CONCERNS for two CCHQ-source corrections that contradicted the prompt) → `7541f127` (CR round-1 fix-pass: stale test-header comment + forward-projection cleanup + import-style alignment + attribute-order test tightening).

Spec review (sonnet, ONCE) clean; CR round 1 (opus, fresh agent) Approved with one Important + three Minors all addressed in `7541f127`.

**Final shape:**

- `lib/commcare/suite/case-search/searchPrompts.ts` (NEW, 343 lines) — pure emitter. Two exports:
  - `emitSearchPrompts(searchInputs, moduleId)` returns the array of `<prompt>` element strings the orchestrator (Task 8) splices into `<query>` verbatim. Indent convention: 8 spaces from column zero, matching the canonical fixture's `<query>` body depth.
  - `getAdvancedArmPredicates(searchInputs)` returns `ReadonlyArray<{ name, predicate }>` for advanced-arm inputs only. Source-array order preserved. Task 8's orchestrator AND-composes these into `<data key="_xpath_query">`.

- `lib/commcare/suite/case-search/__tests__/searchPrompts.test.ts` (NEW, 449 lines) — 19 tests (one added in the fix-pass for `(barcode + default)` attribute ordering). Each `it()` pins one invariant. Coverage: 5 per-type mappings, simple-vs-advanced parity, `<display>` always-emit + label fallback, `@default` attribute on/off, attribute order pinned by exact-string equality, `getAdvancedArmPredicates` filtering + ordering, empty-input array, `moduleId` threading, golden-file comparison against `~/code/commcare-hq/.../tests/data/suite/remote_request.xml`.

**CCHQ-source corrections vs the prompt:** the implementer used CCHQ source as the tiebreaker, correcting two prompt errors:

1. **`@default` is the XML attribute on `<prompt>`, NOT a `<default>` child element** — verified at `commcare-hq/.../suite_xml/xml_models.py::QueryPrompt::default_value = StringField('@default', required=False)`. The prompt's proposed `<default>{xpath}</default>` shape would not match CCHQ's runtime parser; the attribute form is canonical.

2. **`barcode` maps to `appearance="barcode_scan"`, NOT `input="barcode"`** — verified at `commcare-hq/.../views/modules.py::_update_search_properties`. CCHQ admits `@input` and `@appearance` as orthogonal `QueryPrompt` slots; barcode routes through `appearance` while date / daterange / select1 / select / checkbox route through `input_`. Treating barcode as `@input` would be a wire-shape error.

**Per-`SearchInputType` wire mapping (CCHQ-authoritative):**

| Nova `input.type` | Wire emission |
|---|---|
| `text` | bare `<prompt>` (no `@input`, no `@appearance`) |
| `select` | `input="select1"` |
| `date` | `input="date"` |
| `date-range` | `input="daterange"` |
| `barcode` | `appearance="barcode_scan"` |

**Other structural choices:**
- `<display>` always emits (matches CCHQ's unconditional `Display(text=Text(locale_id=…))`); when `input.label` is empty, the locale registers `input.name` as a sensible UX fallback.
- Helper signature is `(searchInputs, moduleId)` — dropped speculative `caseTypes` / `currentCaseType` parameters because `emitOnDeviceExpression(expr: ValueExpression): string` doesn't need them.
- Import style: sibling-relative for cross-`commcare` symbols + `@/lib/domain*` aliases for domain primitives (mirrors `lib/commcare/suite/case-list/columns.ts` + `sortKeys.ts`).

**Test count:** 33/33 in the case-search package; full project: 3982 / 14 skipped after this task closes.

**Acceptance gates landed:**
- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- Drift sweeps clean: zero line-number citations, zero plan/spec references, zero forward-projection in the new files.

**Two pre-existing test failures flagged but out of Task 10 scope:** `lib/commcare/validator/rules/case-search/__tests__/{excludedOwnerIdsTypeCheck,integration}.test.ts` — these belong to Task 11's in-flight 6-rule fix-pass. The Task 11 implementer is expected to resolve in their commit. (At Task 10's landing time the file was named `blacklistedOwnerIdsTypeCheck.test.ts`; renamed in commit `0b0a6f33`.)

**Whole-repo build state:** green within Task 10's scope; the Task 11 fix-pass is running and will close those validator failures.

**Next:** Task 11's 6-rule fix-pass (in flight), Task 12 (workspace mount, in flight), Task 9 (resolved 2026-05-08: supervisor picked Option A — see Task 9 body's "Resolution — no separate skip-already-owned toggle" section), Task 8 (`<remote-request>` orchestrator — depends on 9 + 10), Task 4 (cross-binding test, depends on 12), Task 13 (integration test, depends on all).

### Task 12 — CaseSearchConfigPanel + URL routing + ModuleScreen affordance — 2026-05-08

Landed across two commits: `1cc1dd0a` (initial implementation; DONE_WITH_CONCERNS for cross-task interference + two prompt deviations the implementer correctly resolved) → `f54c3f0f` (CR round-1 fix-pass: dead-variable cleanup + test-contract pinning + case-less validity test).

Spec review (sonnet, ONCE) clean; CR round 1 (opus, fresh agent) APPROVED with two Minors + one observation, all addressed in `f54c3f0f`.

**Final shape:**

- `components/builder/case-search-config/CaseSearchConfigPanel.tsx` (NEW, 326 lines) — multi-section workspace shell mounting ClaimSection (Task 2) + DisplaySection (Task 3) + Plan 3's `SearchInputsSection` (cross-bound against `mod.caseListConfig.searchInputs`). Sticky violet-railed section headers via `CaseListSectionHeader`. Single-scroll magazine layout. Reads `mod.caseSearchConfig` and `mod.caseListConfig.searchInputs` from the doc store; writes via `useBlueprintDocApi().updateModule(moduleUuid, ...)`. Cross-binding load-bearing: SearchInputsSection edits write to `caseListConfig.searchInputs`, NOT a parallel slot.

- `lib/routing/types.ts` (EDIT) — `Location` union extends with `{ kind: "search-config"; moduleUuid: Uuid }`.
- `lib/routing/location.ts` (EDIT) — parser handles `[moduleUuid, "search-config"]` → `{ kind, moduleUuid }`; serializer round-trips; `recoverLocation` falls back to home when moduleUuid doesn't resolve.
- `lib/routing/hooks.tsx` (EDIT) — `openSearchConfig(moduleUuid)` exposed via `useNavigate()`. `useBreadcrumbs` threads the new kind with label "Search Config".
- `lib/routing/CLAUDE.md` (EDIT) — URL schema table updated.
- `components/preview/PreviewShell.tsx` (EDIT) — `loc.kind === "search-config"` branch dispatches to CaseSearchConfigPanel in edit mode. Live mode renders a typed placeholder ("Live preview lands in a follow-up.") to prevent runtime crashes; Plan 5 owns the live-mode dispatch.
- `components/preview/screens/ModuleScreen.tsx` (EDIT) — "Search Config" affordance card. Always-render-but-greyed pattern: `disabled={!hasCase}` + click suppression + hover hint when case-less.
- `lib/preview/engine/types.ts` (EDIT) — `PreviewScreen` extended with `{ type: "searchConfig"; moduleIndex: number }` for dispatch uniformity. Load-bearing: `screenKey()` exhaustive switch + `screensEqual()` + `getParentScreen()` all carry the new arm.

**Tests:** 14 in CaseSearchConfigPanel.test.tsx (one added in fix-pass for case-less validity), 4 new in ModuleScreen.test.tsx, 4 new in location.test.ts. Each `it()` pins one invariant.

**Implementer's deviations from prompt (all defensible):**

1. **Live-mode placeholder copy** — used "Live preview lands in a follow-up." instead of the prompt's "Live preview lands in Plan 5" because the latter violates the project's no-external-doc-references-in-code rule. Correct catch.

2. **ModuleScreen affordance visibility** — the prompt was contradictory ("Visible when caseType is set" AND "greyed when caseType is undefined"). Implementer chose always-render-but-greyed (the disabled-state spec is the more specific signal). Diverges from the existing `CaseListCard` pattern (which only renders when case-typed). Surfaced for supervisor review; defensible — the disabled card with hint actively educates the user about the prerequisite.

3. **Cross-task interference** — when isolating for verification, the implementer overwrote Task 11's uncommitted WIP via `git checkout HEAD --` + `rm`. Task 11's implementer (running in parallel with their session context intact) re-applied + committed at `1505c4e9`. No data loss. Worth noting for future workflow: parallel implementers on the shared worktree need explicit sequencing OR use of `git stash`. Documented for the next round.

**Test count:** 4001 / 14 skipped after Task 12 + Task 11 fix-pass both land.

**Acceptance gates landed:**
- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- Drift sweeps clean.
- User-runnable acceptance: a user can navigate to `/build/{appId}/{moduleUuid}/search-config` via the ModuleScreen affordance card, see the three-section UI, edit a claim condition, and the change persists across reload (URL round-trip + doc store + Firestore).

**CR round-1 Minors all addressed in `f54c3f0f`:** dead-variable alias unified to `searchInputs`; seed test tightened with a `<DocSnapshotProbe>` consumer that reads post-mutation doc state; case-less validity contract pinned by an explicit test.

**Whole-repo build state:** green throughout.

**Next:** Task 11 round-2 CR's expectedType correction → plan-sync Task 11 → Task 9 (BLOCKED) → Task 8 → Task 4 → Task 13.

### Task 11 — Validator rules — 2026-05-08

Landed across three commits:
- `c203d611` — initial 3-rule shipment + canonical AST walker (`lib/domain/predicate/walk.ts`).
- `1505c4e9` — round-1 CR fix-pass: dropped redundant Rule 1, added 4 type-check rules for slots the plan claimed were covered (but weren't), fixed Rule 4 dedup to use via-aware `(destinationCaseType, property)` key.
- `04ee212d` — round-2 CR fix-pass: tightened `expectedType` on `excludedOwnerIdsTypeCheck` (named `blacklistedOwnerIdsTypeCheck` at the time; renamed in commit `0b0a6f33`) + `searchInputDefaultTypeCheck` to match AST-strict contract.

Spec review (sonnet, ONCE) clean; CR rounds 1 + 2 (opus, fresh agent each) both Approved with progressive fix-pass cycles.

**Final rule family (6 rules):**

In `lib/commcare/validator/rules/case-search/`:
1. `claimConditionTypeCheck` — predicate type-check on `caseSearchConfig.claimCondition`.
2. `searchButtonDisplayConditionTypeCheck` — predicate type-check on `caseSearchConfig.searchButtonDisplayCondition`.
3. `excludedOwnerIdsTypeCheck` — value-expression type-check on `caseSearchConfig.excludedOwnerIds` with `expectedType: "text"` (AST-strict contract; the slot's authoring meaning is "evaluates to a space-separated text string of owner IDs").
4. `filterSearchInputConflict` — when `caseSearchConfig` is present, no property may appear as both a `prop(...)` term in `caseListConfig.filter` AND a simple-arm `caseListConfig.searchInputs[i].property`. Dedup is via-aware: keys on `(destinationCaseType, property)` after via-walk via `checkRelationPath` (mirrors `searchInputModeMatchesPropertyType`'s pattern). Cross-walk no-fire pinned by regression test.

In `lib/commcare/validator/rules/case-list/` (because `searchInputs` lives on `caseListConfig`):
5. `searchInputDefaultTypeCheck` — value-expression type-check on `searchInputs[i].default` with per-widget `expectedType` from the new `SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES` lookup at `lib/domain/modules.ts`.
6. `searchInputPredicateTypeCheck` — predicate type-check on advanced-arm `searchInputs[i].predicate` with `knownInputs` for cross-input ref resolution.

**Key supporting work:**
- `lib/domain/predicate/walk.ts` (NEW, 241 lines) — first canonical public AST walker. Three exports (`walkTerms`, `walkInputRefs`, `walkPropertyRefs`) exhaustive over both `Predicate` and `ValueExpression` unions, with TypeScript `never` exhaustiveness assertions at every default branch. Future kind addition fails to compile rather than silently being skipped.
- `lib/domain/modules.ts::SEARCH_INPUT_TYPE_DEFAULT_EXPECTED_TYPES` — single-source-of-truth lookup mapping each `SearchInputType` enum value to the `CasePropertyDataType` Nova's authoring layer demands for the `default` slot. `text → "text"`, `select → "text"` (widens via `typesCompatible(text, single_select|multi_select)`), `date → "date"`, `date-range → "date"` (CCHQ `daterange` widget renders a calendar picker), `barcode → "text"`.

**Drop:** `searchInputReferences` (the original Rule 1) was redundant with the predicate type-checker's native `knownInputs`-based input-ref resolution. Removed entirely; `CASE_SEARCH_INPUT_REFERENCE_UNKNOWN` error code dropped.

**Test count:** 84 / 84 passing in the validator surface (was 65 before Task 11; +19 net). Full project: 4003 / 14 skipped.

**Acceptance gates landed:**
- `npm run lint` clean.
- `npx tsc --noEmit` clean (in scope; 3 pre-existing errors flagged in Task 4's in-flight test file are not Task 11's).
- Drift sweeps clean.

**Plan correction:** the original Task 11 plan body claimed `searchButtonDisplayCondition` and `excludedOwnerIds` were "covered by existing predicate / expression typeCheck rules (Plan 3 ships them on the module-walker)" — this premise was FALSE. There was no module-walker; `filterTypeCheck` was scoped to `caseListConfig.filter` only. Round-1 CR caught the gap; the fix-pass added the missing 4 rules. Future Plan 4 readers should treat the original "covered by existing rules" claim as superseded by this SHIPPED block.

**Whole-repo build state:** green throughout.

**Next:** Task 4 (cross-binding test, in flight), Task 9 (resolved 2026-05-08: supervisor picked Option A — see Task 9 body's "Resolution — no separate skip-already-owned toggle" section), Task 8 (`<remote-request>` orchestrator, depends on Task 9), Task 13 (integration test, depends on all). Plus the queued predicate-editor-subtree reorg (slated between Tasks 12 ✓ and 13).

### Task 4 — SearchInputs cross-binding test — 2026-05-08

Landed at commit `8ffd57ab`. Spec review (sonnet, ONCE) clean; CR round 1 (opus, fresh agent) APPROVED with no blockers (one observation-only Minor on `userEvent` vs `fireEvent` style — sibling tests use the same pattern, not flagged for action).

**Final shape:**

- `components/builder/case-search-config/__tests__/searchInputsCrossBinding.test.tsx` (NEW, 655 lines, 8 `it()` blocks). Test-only — zero production-code changes.

**Mount setup:** single `BlueprintDocProvider` wraps both `CaseListWorkspace` + `CaseSearchConfigPanel` + a `DocSnapshotProbe`. Both workspaces share one Zustand store instance — the cross-binding contract is genuinely under test, not tautological. `DocSnapshotProbe` (introduced in Task 12's fix-pass at `f54c3f0f`) reads live `Module` state from the store post-mutation via `useModule(moduleUuid)`; assertions run against the persisted shape, not the rendered view.

**Mocks:** the four surrounding shells (DisplaySection + FiltersSection in case-list, ClaimSection + DisplaySection in case-search) are mocked to minimal `<div data-testid="..." />` stubs so only the `SearchInputsSection` mount drives mutations. `SearchInputsSection` is left UNMOCKED — real Add/Convert affordances drive real mutations through the doc store. Mocks are non-tautological (zero behavior assertions on the stubs).

**8 invariants pinned (one per `it()` block):**

1. **Persistence-slot pin** — after a cross-binding write, `mod.caseListConfig.searchInputs.length === 1` AND `mod.caseSearchConfig === undefined` (entire slot, stricter than the spec's "no parallel `caseSearchConfig.searchInputs` slot" — catches Claim/Display side-effects too).
2. Add `kind: "simple"` from CaseSearchConfigPanel → appears in CaseListWorkspace.
3. Add `kind: "advanced"` from CaseListWorkspace → appears in CaseSearchConfigPanel.
4. Convert simple → advanced from CaseListWorkspace → visible in CaseSearchConfigPanel.
5. Convert advanced → simple from CaseSearchConfigPanel → visible in CaseListWorkspace.
6. Round-trip preserves all five common slots (`uuid`, `name`, `label`, `type`, `default`) across both convert directions; `default` set to `term(literal("Ada"))` to actually pin the preservation.
7. Per-arm non-leakage on simple rows: `Object.hasOwn` checks confirm `predicate` is absent on simple-arm rows.
8. Per-arm non-leakage on advanced rows: `Object.hasOwn` checks confirm `property`, `mode`, `via` are absent on advanced-arm rows.

**Test count:** 8 in this file; 44 total in case-search-config; 4011 full suite passing.

**Acceptance gates landed:**
- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- Drift sweeps clean.

**Whole-repo build state:** green throughout.

**No production-code concerns surfaced** — the workspaces correctly share doc-store state via `useModule` / `updateModule`, both routing search-input writes through `caseListConfig.searchInputs`. The cross-binding works as designed.

**Next:** Predicate-editor-subtree reorg (in flight); Task 9 (resolved 2026-05-08: supervisor picked Option A — see Task 9 body's "Resolution — no separate skip-already-owned toggle" section); Task 8 (`<remote-request>` orchestrator, depends on Task 9); Task 13 (integration test, depends on all).

### Task 8 — `<remote-request>` orchestrator + `<session>` sub-emitter — 2026-05-09

Landed across two commits: `0b0a6f33` (rename `caseSearchConfig.blacklistedOwnerIds` → `excludedOwnerIds` across every Nova-owned surface; CCHQ wire token `commcare_blacklisted_owner_ids` unchanged) → `357a1b68` (Task 8 emission proper — orchestrator + session sub-emitter + claim sub-emitter + `compiler.ts` integration + `<action>` wiring on `m{N}_case_short`).

Spec review (sonnet, ONCE) clean; the spec review caught six findings (all real, all addressed in the fix-pass that produced this SHIPPED block — see "Plan-text corrections" below).

**Final shape:**

- `lib/commcare/suite/case-search/remoteRequest.ts` (NEW, 247 lines) — top-level orchestrator. `emitRemoteRequest({ module, moduleIndex, platformContext? })` returns `{ xml, strings, wire }`. Composes the six structural pieces in canonical order: `<post>` (delegates to `claim.ts`) → `<command>` → `<instance>` declarations (sorted lexicographically for determinism) → `<session>` (delegates to `searchSession.ts`) → `<stack>` (single rewind frame). Returns the computed `WireShape` so the surrounding compiler threads `autoLaunch` to the case-list short-detail emitter without recomputing. The default platform context is web — the live-preview runtime; per-Android variants pass an explicit override.

- `lib/commcare/suite/case-search/searchSession.ts` (NEW, 358 lines) — `<session>` body. Composes `<query>` with the four CCHQ-pinned attributes (`url default_search storage-instance template`) verified against `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::RemoteRequestQuery` — no `inline_search` or `dynamic_search` attributes (CCHQ doesn't carry them on the wire) and no `search_on_clear` (gated `CASE_SEARCH_ADVANCED`, out of Nova's wire emission). `<data>` slots compose in CCHQ's canonical order (`case_type` → `commcare_blacklisted_owner_ids` when set → CSQL hoist wrappers → `_xpath_query` when present and non-trivial) verified against `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums`. The `<datum>` references the search-side detail ids (`m{N}_search_short` / `m{N}_search_long`); the storage-instance discriminator (`results` vs `results:inline`) flows from `WireShape.inlineSearch`.

- `lib/commcare/suite/case-search/claim.ts` (NEW, 101 lines) — `<post>` claim emission. Three exports: `CLAIM_URL_TEMPLATE` (`__DOMAIN__` placeholder; CCHQ rebuilds suite.xml at import time with the real domain), `CLAIM_DEFAULT_RELEVANT` (the structural `count(...) = 0` guard lifted verbatim from `commcare-hq/corehq/apps/app_manager/xpath.py::CaseClaimXpath.default_relevant`), and `SEARCH_CASE_ID_REF` (the session-data XPath both the `<post>` body and the `<stack>` rewind frame reference). The `<post>` body carries ONLY the single `case_id` `<data>` child. No author composition with `additional_relevant` — the authoring affordance was nuked in Plan 4's "Option B — claim-condition authoring removed wholesale" decision; CCHQ's runtime fires the structural guard regardless.

- `lib/commcare/compiler.ts` (EDIT) — orchestrator integration. `emitRemoteRequest` runs once per module with `caseSearchConfig`, accumulating `<remote-request>` blocks in the suite-XML output alongside `<detail>` and `<entry>` blocks. The returned `WireShape.autoLaunch` threads through to `emitShortDetail` as a `searchAction` arg; the `m{N}_case_short` short-detail picks up an `<action>` element carrying `auto_launch` (per `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_action_kwargs`'s `AUTO_LAUNCH_EXPRESSIONS["single-select"]`) and the optional `searchButtonDisplayCondition` predicate compiled to on-device XPath as the `<action relevant>` attribute (per `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_relevant_expression`). Search-target detail (`m{N}_search_short`) never carries `<action>`.

- `lib/commcare/suite/case-list/shortDetail.ts` (EDIT) — accepts the optional `searchAction` context; renders the `<action>` element on the case-target detail only.

**Tests added (3 new test files):**

- `lib/commcare/suite/case-search/__tests__/claim.test.ts` (NEW, 101 lines)
- `lib/commcare/suite/case-search/__tests__/remoteRequest.test.ts` (NEW, 329 lines)
- `lib/commcare/suite/case-search/__tests__/searchSession.test.ts` (NEW, 473 lines)
- `lib/commcare/suite/case-list/__tests__/shortDetail.test.ts` (EDIT, +125 lines) — `<action>` wiring on `m{N}_case_short`.

**`<query>` attributes (verified against `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::RemoteRequestQuery`):**

| Attribute | Source | Notes |
|---|---|---|
| `url` | `SEARCH_URL_TEMPLATE` (constant) | CCHQ's `app_aware_remote_search` endpoint with `__DOMAIN__` / `__APP_ID__` placeholders. CCHQ regenerates suite.xml at import time. |
| `default_search` | `WireShape.defaultSearch` | Boolean, always emitted. |
| `storage-instance` | `WireShape.inlineSearch ? "results:inline" : "results"` | Threads from the platform compiler's three-branch decision tree. |
| `template` | Constant `"case"` | CCHQ pins this. |

`auto_launch` and `inline_search` are NOT `<query>` attributes (the implementer correctly omitted them despite the original plan body's stale claim). `auto_launch` lands on `<action auto_launch>` inside `m{N}_case_short`; `inline_search` is a CCHQ-internal Python flag that selects the storage-instance identifier and never serializes as a wire attribute.

**`<data>` slot order (CCHQ-canonical):**

1. `case_type` — required, always present, references `'<case_type>'`.
2. `commcare_blacklisted_owner_ids` — emitted only when `caseSearchConfig.excludedOwnerIds` is set. Wire token is CCHQ-controlled (lifted from `commcare-hq/corehq/apps/case_search/models.py::CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY`); Nova's authoring vocabulary calls the slot `excludedOwnerIds`. The `dataLines.push(...)` call site at `searchSession.ts::emitSearchSession` is the explicit translation boundary.
3. CSQL hoist wrappers — each non-grammar value-expression shape lifted from `_xpath_query` emits as its own `<data key="<inputRef>">` slot before the `_xpath_query` slot so the runtime resolves wrapper inputs first.
4. `_xpath_query` — single AND-composed CSQL string. Runs the unified filter (`caseListConfig.filter`) AND every advanced-arm search input's predicate through the `and(...)` reducer at the AST level; emits one CSQL string regardless of how many predicates contributed. Match-all collapses cleanly: when the AND-composed result is `match-all` the `<data key="_xpath_query">` element is omitted entirely (CCHQ accepts the absence).

**`<post>` structural emission:** the `<post>` carries the static `relevant` guard verbatim and a single `case_id` `<data>` child. There is NO AND-composition with `claimCondition` — the authoring affordance was removed in Plan 4's Option B decision (CCHQ's `additional_relevant` is gated `CASE_SEARCH_DEPRECATED`). The `<post>` shape is identical across every emission.

**`searchButtonDisplayCondition` → `<action relevant>` wiring:** when `caseSearchConfig.searchButtonDisplayCondition` is set, the orchestrator threads it through `searchAction.displayCondition` to `emitShortDetail`, which compiles the predicate via `emitCaseListFilter` (on-device XPath) and stamps it on the `<action relevant>` attribute. The wiring is verified against `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_relevant_expression`.

**`__DOMAIN__` / `__APP_ID__` URL placeholders:** both `claim.ts::CLAIM_URL_TEMPLATE` and `searchSession.ts::SEARCH_URL_TEMPLATE` carry placeholder strings rather than the literal domain / app id. CCHQ's `commcare-hq/corehq/apps/app_manager/models.py::Application.create_suite` regenerates `suite.xml` server-side at import time and substitutes the real values. Direct sideload of the .ccz onto a mobile player (a path Nova does not currently surface) would not see the substitution; that path is not on the runway.

**Plan-text corrections (six findings from spec review, all addressed in the fix-pass that produced this block):**

1. **Integration site corrected.** Plan File Structure + Task 8 body cited `lib/commcare/expander.ts` as the EDIT site. Actual site is `lib/commcare/compiler.ts`. Both citations updated.
2. **Stale `<query>` attribute claims dropped.** Plan body claimed `dynamic_search` and `search_on_clear` were `<query>` attributes defaulting to `"false"` (out of v1 scope), and `inline_search` was a `<query>` attribute. CCHQ source contradicts: only `url`, `default_search`, `storage-instance`, `template` are real `<query>` attributes; `search_on_clear` is feature-flag gated; `inline_search` and `dynamic_search` are not `<query>` attributes at all. Plan body rewritten to the four real attributes verified against `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::RemoteRequestQuery`.
3. **File Structure validator-test paths corrected.** Plan File Structure cited `blacklistedOwnerIdsTypeCheck.{ts,test.ts}` — both files were renamed to `excludedOwnerIdsTypeCheck.{ts,test.ts}` in commit `0b0a6f33`. File Structure citations updated.
4. **Authoring-layer rename swept across the plan doc.** Per the rename's spec ("all Nova-owned surfaces use `excludedOwnerIds` voice; CCHQ wire token `commcare_blacklisted_owner_ids` unchanged"), the plan doc's `blacklistedOwnerIds` references swept to `excludedOwnerIds` everywhere except (a) CCHQ fixture filenames (`search_config_blacklisted_owners.xml`), (b) the wire token `commcare_blacklisted_owner_ids`, and (c) historical commit-message subjects quoted verbatim with explicit citations of commit `0b0a6f33`.
5. **`"Search All Cases"` fallback comment cited CCHQ's default.** The implementer's `commandLabel` ternary fallback to `"Search All Cases"` was previously uncommented. Updated `lib/commcare/suite/case-search/remoteRequest.ts::emitRemoteRequest` to cite `commcare-hq/corehq/apps/app_manager/models.py::CaseSearch.search_button_label` so a future reader knows the default is part of the CCHQ contract Nova mirrors, not an arbitrary Nova choice.
6. **This SHIPPED block.** Per the per-phase SHIPPED-sync discipline, after implementer + spec review approval the plan doc gets a SHIPPED block.

**Test count:** 4050 / 14 skipped (deterministic two runs). The Task 8 emission commits added the three new case-search test files plus shortDetail.test.ts additions; the absolute count reflects all prior tasks plus the post-rename validator file moves.

**Acceptance gates landed:**

- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- `npm test` 4050 / 14 skipped.
- Drift sweeps clean post-fix-pass: zero stale `expander.ts` references in Task 8 scope; zero `dynamic_search|search_on_clear|inline_search` claims as `<query>` attributes in plan body; zero authoring-layer `blacklistedOwnerIds` references outside the three preserved categories above.

**Whole-repo build state:** green throughout. Task 8's deliverables compose into Task 13's integration test (which exercises the `<remote-request>` golden-file comparison alongside the dual-detail emission and SA-tool round-trips).

**Next:** Task 13 (integration test, depends on all prior tasks).

## Audit followups — Predicate-editor subtree relocation — 2026-05-08

The supervisor's queued task #8 in the supervisor task list (predicate-editor subtree relocation, slated between Plan 4 Task 12 ✓ and Task 13). Cross-family consumer audit triggered by Task 2's CR + Task 4's setup, deferred until after Task 12 mounted the workspace (so the workspace-mount work didn't churn against a moving target).

The subtree was rooted in `components/builder/case-list-config/` by historical accident — case-list-config was the first consumer. Plan 4 made it genuinely cross-family (FiltersSection, SearchInputsSection's advanced arm, ClaimSection via PredicateSlotCard, DisplaySection's `searchButtonDisplayCondition` via PredicateSlotCard, plus PredicateSlotCard itself in `shared/`). The current home was misleading; `shared/` is correct.

Landed across two commits (one a partial-state intermediate, one the completion):

- `f1646913` — `docs(plan): sync Task 4 SHIPPED` (incidentally bundled the 67 `git mv` operations the reorg implementer pre-staged; the supervisor's `git add` swept them in alongside the plan doc). Branch in transient broken state — renames land without import-path updates.
- `b57cd45a` — `refactor(builder): relocate predicate-editor subtree to shared/` follow-up. Lands the import-path updates across 11 consumer files + the `components/builder/CLAUDE.md` shared-vs-case-list-config split, restoring green build. End state matches the intended atomic relocation.

**Files relocated (67 renames):**
- Top-level: `PredicateCardEditor.tsx`, `ExpressionCardEditor.tsx`, `editorContext.tsx`, `path.ts`, `editorSchemas.ts`, `expressionEditorSchemas.ts`, `nodeIdentity.ts`, `literalRebuild.ts`, `relationDestination.ts`, `dragData.ts`, `useReorderableList.ts`.
- Predicate cards (13): all 13 in `cards/`.
- Expression cards (13): all 13 in `cards/expression/`.
- Primitives (9): `primitives/{BlurCommitTextInput, CardShell, CustomDatePatternInput, ExpressionPicker, HigherOrderBadge, LiteralValueInput, PropertyPicker, PropertyRefPicker, RelationPathBuilder}.tsx`.
- Tests (21): top-level + `cards/` + `cards/expression/` test mirrors.

**Files staying in `case-list-config/`:**
- Workspace shells: `CaseListWorkspace`, `CaseListSectionHeader`, `DisplayPreview`, `DisplaySection`, `FiltersPreview`, `FiltersSection`, `SearchInputsSection`.
- Column-specific: `ColumnEditor`, `columnEditorSchemas`, `columnCellRenderer`, `cards/column/*`.
- `uuid.ts` (only consumed by case-list-config-internal files).

**Lessons learned (process, not implementation):**

1. **Parallel agent operations on a shared worktree need explicit sequencing.** The reorg implementer's `git mv` operations pre-staged 67 renames into the index. When the supervisor ran `git add docs/plans/2026-05-01-search-authoring.md && git commit` for the unrelated Task 4 plan-sync, the staged renames swept in. Fix going forward: when an implementer is running operations that stage to the index (`git mv`, `git add` of any kind), the supervisor avoids unrelated commits OR uses `git add --` with explicit-paths discipline (which was already the case here, but the renames had been staged outside the supervisor's `git add` invocation by the implementer's parallel session).

2. **The implementer's discipline holds.** They correctly chose NOT to `git reset --soft` to repair the partial state — that would have clobbered the supervisor's plan-doc edit. The remediation was a clean follow-up commit instead. End-state is correct; commit history has one extra step.

**Acceptance gates landed:**
- `npm run lint`: clean (1041 files).
- `npx tsc --noEmit`: clean.
- `npm test`: 4011 passing (matches pre-move count, exactly per spec).
- `npm run build`: succeeds.
- Drift sweep `rg "from \"@/components/builder/case-list-config/(PredicateCardEditor|ExpressionCardEditor|cards/[^c]|editorContext|path|editorSchemas|expressionEditorSchemas|primitives|nodeIdentity|literalRebuild|relationDestination|dragData|useReorderableList)\"" components lib`: 0 hits.
- Drift sweep `rg "from \"@/components/builder/case-list-config" components/builder/shared/`: 0 hits — dependency direction is correct (shared/ does not import from case-list-config/).

**Whole-repo build state:** green at `b57cd45a`. Plan 4 Task 13 (integration test) can now run against the post-reorg layout without churning.

## Audit followups — Task 3 — 2026-05-08

Task 3's CR + the implementer's family-grep surfaced the same "spurious onChange on focus-blur of an empty undefined slot" regression class at two pre-existing call sites of `useCommitField` outside Task 3's scope. Per the "audit family in flight" supervision rule, the family fix landed as its own commit.

### Family fix — commit `1674c4a0`

`fix(builder): no-op on focus-blur-of-empty for never-set text slots — family fix`. Applies the same `value !== undefined` gate that Task 3's `OptionalTextRow` got to two more consumers of `useCommitField`'s `onEmpty` callback:

- `components/builder/editor/fields/TextEditor.tsx::handleEmpty` — gated.
- `components/builder/editor/fields/XPathEditor.tsx::clearValidateMsg` — split into two conditionally-fired arms: slot-clear gated on `validateMsg !== undefined`, `setAddingMsg(false)` always fires.

**Path B (consumer-level fix) chosen** after the implementer traced an obstruction with Path A (primitive-level gate at `EditableText`): XPathEditor's `clearValidateMsg` bundles a UI-state cleanup arm (closes the "Add Validation Message" editor) that MUST fire unconditionally even when the slot was never set. A primitive-level gate would block both arms uniformly and leave the editor mounted forever after a passive Add-then-cancel gesture. Path B fixes each consumer's specific semantic correctly.

**Family completeness sweep:** every direct `useCommitField` consumer audited. `FieldHeader` uses the hook for the field-id input with no `onEmpty` (not affected). `InlineField` uses `required` rather than `onEmpty` (different shape, not affected). No non-`useCommitField` consumers with the same shape exist (`XPathField`'s CodeMirror editor uses Cmd/Ctrl+Enter explicit save, not focus-blur autosave).

**Tests:** 5 new regression tests across two new test files (`__tests__/TextEditor.test.tsx` 3 tests + `__tests__/XPathEditor.test.tsx` 2 tests) pinning the split-cleanup invariant at XPathEditor and the no-op-on-never-set + clear-emits-undefined contracts at TextEditor.

**Test count:** 3869 → 3874 passing (+5 from the new tests). Lint + typecheck clean.

**Branch tip after the family fix:** `1674c4a0`.

## Foundation followups — 2026-05-08

Task 1's CR loop surfaced a structural asymmetry: `caseSearchConfigSchema` shipped with `.strict()` while every other Zod schema in `lib/domain/` and `lib/agent/tools/` defaulted to Zod's strip behavior. The reshape's strip-as-tolerance argument ("legacy v0/v1 fields might still flow through") was invalid in production: Plan 5's pre-deploy migration step (`scripts/migrate-case-list-schema-reshape.ts --write`) runs BEFORE the v2 code deploys, so by the time any v2 schema parses a doc, every doc is already v2 with no legacy fields. Strip-as-tolerance was a defensive overbuild that violated the project's "Strong typing everywhere" rule.

Three commits land the foundation cleanup:

### Strict alignment — commits `25894d51` + `2a7fdae0`

- `25894d51` — `refactor(domain): align all schemas to .strict()`. 97 `.strict()` additions across 27 production files: every `z.object({...})` in `lib/domain/modules.ts`, `lib/domain/predicate/types.ts`, `lib/domain/blueprint.ts`, `lib/domain/forms.ts`, `lib/domain/fields/base.ts`, `lib/domain/fields/repeat.ts`, and `lib/agent/tools/**/*.ts`. `.extend()` and `.omit()` propagate strictness, so per-kind columns / per-kind fields / `omit({ uuid: true })`-derived input schemas all inherit strictness without restating.

  Two existing strip-tests reversed to strict-rejection tests: `moduleSchema — rejects unknown top-level keys` and `caseListConfigSchema — three-slot shape::rejects unknown top-level keys`. 44 test failures surfaced from three consumer call sites that were using `parse()` as a "projection / strip-by-validation" mechanism — addressed in the next commit.

- `2a7fdae0` — `fix(domain): replace strip-as-projection with explicit key filter`. Three consumers fixed:
  - `lib/preview/engine/caseDataBindingClient.ts::pickBlueprintDoc` — replaced `blueprintDocSchema.parse(state)` with `pickByKeys(state, BLUEPRINT_DOC_KEYS)` (precomputed key set) + explicit `fieldParent` re-attach. The Server Actions in `caseDataBinding.ts` re-validate at the wire boundary; the projection step is now pure projection, not validation-as-projection.
  - `lib/domain/fields/index.ts::reconcileFieldForKind` — replaced the spread-then-`fieldSchema.safeParse` strip pattern with `pickFieldKeysForKind` (per-kind valid-key dispatcher backed by `fieldKindKeySets` and, for repeat targets, `repeatVariantKeySets`).
  - `lib/doc/mutations/fields.ts::updateField` reducer — replaced the spread-then-`fieldSchema.safeParse` strip pattern with `applyFieldPatch` (introduced as an explicit merge-then-filter helper).

  Shared primitive: `pickByKeys(source, allowedKeys)` exported from `lib/domain/fields/index.ts` — used by both `pickBlueprintDoc` (BlueprintDoc projection) and `pickFieldKeysForKind` (per-kind field projection). First-duplication discipline applied; one helper, two consumers.

### Mutation-type tightening — commits `7127f66a` + `87803b32`

`applyFieldPatch` (introduced in `2a7fdae0`) was a runtime workaround for a loose type: `FieldPatch` was a union-wide partial that allowed any field variant's keys on any field's patch. The user's instinct: tighten the type so TypeScript catches the misuse at compile time, dropping the runtime helper.

- `7127f66a` — `refactor(doc): discriminate updateField mutation by targetKind`. The `updateField` mutation now carries `targetKind: K` as a discriminator; its `patch` slot is typed as `Partial<Omit<Extract<Field, { kind: K }>, "uuid" | "kind">>`. The Zod `mutationSchema` mirrors the type: the `kind: "updateField"` arm is a nested `z.discriminatedUnion("targetKind", ...)` over per-kind patch shapes (one schema per kind in `fieldPatchSchemaByKind`).

  12 call sites updated to pass `targetKind` explicitly: `useBlueprintMutations.updateField`, `updateFieldMutations` agent helper, six fix functions in `lib/commcare/validator/fixes.ts`, four UI components, and the `editField` agent tool. Every site already had the field's kind in scope, so the migration was a single argument addition per site.

  Reducer rewrite at `lib/doc/mutations/fields.ts::updateField`: reads `mut.targetKind` first, fires Elm-style warn + no-op if `field.kind !== mut.targetKind` (stale-mutation guard for parallel `convertField` races), spread-merges through `pickFieldKeysForKind` for the repeat-mode-switch cleanup case TypeScript can't narrow at the type level, then validates via `fieldSchema.safeParse`.

  `applyFieldPatch` deleted; `pickFieldKeysForKind` retained for the repeat sub-discriminator case (which TypeScript can't narrow because repeat is itself a discriminated union nested inside `Field`).

  Tests: 3838 → 3839 (one added — pinning the repeat-mode-switch cleanup path); the "strips keys not valid for the target kind" test pivoted to "skips a stale patch when the field's kind drifted from targetKind."

- `87803b32` — `refactor(domain): extract FieldPatchFor + partialOf, tighten pickByKeys`. CR-flagged first-duplication violation: the literal `Partial<Omit<Extract<Field, { kind: K }>, "uuid" | "kind">>` appeared at 8 distinct sites. Extracted as `FieldPatchFor<K>` next to `fieldPatchSchemaByKind` (paired type-level + runtime-schema for the same shape). All 8 sites replaced; UI inline `as unknown as Partial<Omit<...>>` triple-casts collapsed to `as FieldPatchFor<F["kind"]>`.

  Two minor polish items folded into the same commit: a `partialOf` helper for the 18 `.omit({ uuid: true, kind: true }).partial()` repetitions inside `fieldPatchSchemaByKind` (with explicit return-type annotation to preserve per-variant key sets), and `pickByKeys`'s generic signature tightened from `Record<string, unknown> → Record<string, unknown>` to `<T extends Record<string, unknown>>(source: T, ...) => Partial<T>` — removing the `as unknown as Record<string, unknown>` cast at `pickBlueprintDoc`'s call site.

**Compile-time guarantee.** The CR verified the type tightening empirically: a temp file constructing three intentionally-bad mutations (`{ targetKind: "hidden", patch: { label } }`, `{ targetKind: "text", patch: { subtype } }`, missing `targetKind`) all failed `tsc --noEmit` with precise per-arm error messages. The inferred patch shape for the `hidden` arm omits `label`; the `text` arm includes `validate`, `validate_msg`, `calculate`. `partialOf`'s explicit return-type annotation preserves the per-variant key set rather than collapsing to `Record<string, never>`.

**Final state:**
- `applyFieldPatch` deleted; `rg "applyFieldPatch" lib components` returns zero hits.
- `Partial<Omit<Extract<Field, { kind: K }>, "uuid" | "kind">>` literal eliminated; `rg "Partial<Omit<Extract<Field" lib components` returns zero hits.
- 3839 tests passing across 227 files.
- `npm run lint`, `npx tsc --noEmit`, `npm run build` all green.

**Why this section, not its own plan.** The reshape's pattern (`docs/plans/2026-05-07-case-list-schema-reshape.md`'s "Audit-driven follow-ups" section) is the precedent: foundation fixes that surface during a plan's CR loop and that the supervisor lands as their own commits stay attached to the plan as followups, not as a separate plan. This section documents the four foundation commits so a fresh-session supervisor reading Plan 4 sees the foundation that Plan 4's later tasks compose against.

### Option B — claim-condition authoring removed wholesale — 2026-05-09

**Decision.** CCHQ's runtime fires the case-claim step automatically: the `<post>` `relevant` always emits the default guard `count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0` regardless of any author input (verified at `commcare-hq/.../models.py::CaseSearch.get_relevant`). The `claimCondition` field compiles to CCHQ's `additional_relevant`, which is gated behind `CASE_SEARCH_DEPRECATED` for authoring. In four years at Dimagi the user has never seen anyone author a claim condition. The Nova affordance was inventing UX over a wind-down field for a runtime step CCHQ already runs without authoring input. Drop it.

**Affected tasks.** Tasks 1, 2, 5, 9, 11, 12 — schema, ClaimSection UI, SA tools, claim wire emission, validator, workspace mount.

**Schema (Task 1).** `claimCondition` removed from `caseSearchConfigSchema` (`lib/domain/modules.ts`). Schema collapses to seven optional fields — `excludedOwnerIds` plus the six display labels. `lib/domain/__tests__/modules.test.ts` updated: round-trip fixture drops the `claimCondition` line; the `admits explicit undefined` test pivots to the `excludedOwnerIds` slot. `caseSearchConfigSchema`'s description reframes the two clusters as **display** + **advanced** (single-slot today, abstracted name to absorb future advanced filters). (At the time of this Option B writeup the slot was named `blacklistedOwnerIds`; renamed to `excludedOwnerIds` in commit `0b0a6f33`.)

**UI (Tasks 2, 12).** `components/builder/case-search-config/ClaimSection.tsx` + its test deleted entirely. The `excludedOwnerIds` editor relocates to a NEW `components/builder/case-search-config/AdvancedSection.tsx` whose section title is the abstract "Advanced" — matching CCHQ's own framing (`CASE_SEARCH_ADVANCED` toggle, "Advanced Case Search") and scoping the section to its role (niche search-side filters), not its current contents. Abstract naming is load-bearing — future advanced filters land here without a section rename. `CaseSearchConfigPanel.tsx` reorders to **Display → Search Inputs → Advanced**: Display sits at the top because the search-screen title and subtitle are the most important slots on the page; Advanced sits at the bottom because its current contents are niche affordances most authors never reach for. Status-line builders track the section reorder: `buildClaimStatus` deleted, `buildAdvancedStatus` added. The state hook renames `claimValid → advancedValid`; composite verdict is `displayValid && searchInputsValid && advancedValid`. Panel test updated for the section-order swap and the `claim-section-stub` → `advanced-section-stub` mock-id change.

**SA tools (Task 5).** `setCaseSearchClaim` renamed to `setCaseSearchAdvanced`:
- File rename: `lib/agent/tools/case-search-config/setCaseSearchClaim.ts` → `setCaseSearchAdvanced.ts`. Tool name on the SA boundary becomes `setCaseSearchAdvanced`. The body shape collapses to `{ excludedOwnerIds: ValueExpression | null }` — null clears, non-null sets, mirroring the wholesale-replace pattern. The `claimConditionKind` discriminator on the success result drops; the single-slot wholesale tool's success is `{ message }` only (no useful branching off "exclusion set vs cleared" beyond what the prose conveys).
- Test file rename: `__tests__/setCaseSearchClaim.test.ts` → `setCaseSearchAdvanced.test.ts`. Test bodies pivot to exercise the excluded-owners slot only.
- Schema test (`__tests__/schema.test.ts`) updated: `setCaseSearchAdvanced` smoke parses replace the `setCaseSearchClaim` smoke parses.
- `setCaseSearchDisplay`'s strip-and-rebuild renames the destructured rest from `claimCluster` to `advancedCluster`. Description text references the advanced cluster.
- `lib/agent/tools/case-search-config/shared.ts`: `setCaseSearchClaimBodySchema` renamed to `setCaseSearchAdvancedBodySchema`; the body shape drops the `claimCondition` field. File header reframes the two clusters.
- `lib/agent/solutionsArchitect.ts`: registered tool name update.
- `lib/agent/tools/getModule.ts`: JSDoc reframes the two clusters; tool description text references "display cluster + advanced cluster."
- `lib/agent/tools/updateModule.ts`: JSDoc references the renamed advanced tool.
- `lib/agent/tools/shared/moduleNotFoundResult.ts`: JSDoc references the renamed tool.
- `lib/mcp/server.ts`: MCP wire name `set_case_search_advanced` replaces `set_case_search_claim`.
- `lib/agent/CLAUDE.md`: case-search authoring section reframes the two clusters; the prompt-list of shared tools renames `setCaseSearchClaim` → `setCaseSearchAdvanced`.
- `lib/agent/prompts.ts`: build-mode workflow narrative drops the "claim flow on selection" trigger (claim runs automatically), frames the case-search tools as covering "search-screen labels, niche search-side filters."
- `lib/agent/summarizeBlueprint.ts::summarizeCaseSearch` rewritten: the `claim={kind|none}` line drops; the new shape is `case_search: display={…} advanced={excludedOwnerIds|none}`. Edit-mode SA reading the blueprint summary sees the same density without the deprecated cluster.
- `scripts/test-schema.ts`: registered name + import path update; the `setCaseSearchClaim` test entry becomes `setCaseSearchAdvanced` with the prompt rewritten to match the single-slot shape.

**Validator (Task 11).** `lib/commcare/validator/rules/case-search/claimConditionTypeCheck.ts` + its test (`__tests__/claimConditionTypeCheck.test.ts`) deleted entirely. `lib/commcare/validator/rules/module.ts` drops the `claimConditionTypeCheck` import + registration. `searchButtonDisplayConditionTypeCheck.ts`'s JSDoc rewords the now-orphan `claimConditionTypeCheck` reference into "every predicate-slot type-check rule" — the structurally-identical pattern is still load-bearing, just no longer cross-referencing the deleted rule. `__tests__/integration.test.ts` rewritten: the violating-blueprint case drops the claim condition predicate (one fewer rule fires); the clean-blueprint case drops `claimCondition` from `caseSearchConfig` and replaces the `input("region_search")` reference inside the (now-deleted) claim condition with an equivalent reference inside `searchButtonDisplayCondition` to keep input-resolution coverage. The `filterSearchInputConflict` rule is **untouched** — it gates on `caseSearchConfig` presence (search authored = `<remote-request>` emitted), which is the right gate regardless of the cluster split inside.

**Wire emission (Task 9).** Plan 4 Task 9's pending scope (claim emission) collapses. With `claimCondition` gone, the `<post>` `relevant` attribute emits the default guard verbatim: `count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0`. There is no AND-composition with `additional_relevant`. Task 9 reduces to a 5-line helper that emits the `<post>` element + its single `<data key="case_id">` child + the static `relevant` string. The "Resolution — no separate skip-already-owned toggle" sub-section becomes moot and is preserved here only as a historical reference; the operative decision is "no claim authoring at all."

**Spec doc.** `docs/specs/2026-04-30-case-list-search-design.md`: the V1-IN list's "Claim condition (Predicate AST)" bullet is removed. The "Predicate AST" use-list cross-reference at the spec head is updated to drop "claim conditions" — `Predicate` is still used for filters, default search filters, search-button display conditions, and EXISTS clauses. `lib/domain/predicate/CLAUDE.md`'s package summary follows the spec.

**File deletions (commit-ready).**
- `components/builder/case-search-config/ClaimSection.tsx`
- `components/builder/case-search-config/__tests__/ClaimSection.test.tsx`
- `lib/commcare/validator/rules/case-search/claimConditionTypeCheck.ts`
- `lib/commcare/validator/rules/case-search/__tests__/claimConditionTypeCheck.test.ts`

**File renames (commit-ready).**
- `lib/agent/tools/case-search-config/setCaseSearchClaim.ts` → `setCaseSearchAdvanced.ts`
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchClaim.test.ts` → `setCaseSearchAdvanced.test.ts`

**New files (commit-ready).**
- `components/builder/case-search-config/AdvancedSection.tsx` — single-section panel for `excludedOwnerIds` today; abstract "Advanced" naming so future advanced filters land here without a rename. Mirrors the structure of the deleted `ClaimSection`'s excluded-owners editor (collapsed-by-default, `expectedType="text"`, mount-stays-on across collapse toggles).
- `components/builder/case-search-config/__tests__/AdvancedSection.test.tsx` — empty-state / add-path / populated-round-trip / validity-propagation coverage; pins the load-bearing decision that collapse is a VISIBILITY toggle (the editor stays mounted through close-to-open transitions so the type-check verdict keeps reaching the section even on default-collapsed loads).

**Final sweep.** `rg "claimCondition|additional_relevant|setCaseSearchClaim|ClaimSection|claim.cluster|claim.emission" --type ts --type tsx` returns zero matches in code/tests. The spec/plan markdown carries historic SHIPPED-block mentions only (those are institutional memory for fresh-session supervisors and stay).

**Acceptance gates.**
- `npx tsc --noEmit` clean.
- `npm run lint` clean.
- `npm test` all green.
- The four `rg` final-sweep terms return zero matches outside of `docs/`.
