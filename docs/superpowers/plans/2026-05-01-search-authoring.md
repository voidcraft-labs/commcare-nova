# Search Authoring Implementation Plan (Plan 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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

- `components/builder/case-search-config/ClaimSection.tsx` (NEW) — Task 2. Mount: `CaseSearchConfigPanel.tsx::ClaimSection` (Task 12 owns the mount line).
- `components/builder/case-search-config/DisplaySection.tsx` (NEW) — Task 3. Mount: `CaseSearchConfigPanel.tsx::DisplaySection` (Task 12 owns the mount line).
- `components/builder/case-search-config/__tests__/ClaimSection.test.tsx` (NEW)
- `components/builder/case-search-config/__tests__/DisplaySection.test.tsx` (NEW)

The cross-bound `SearchInputsSection` (Plan 3's discriminated UI, mounted against `mod.caseListConfig.searchInputs`) is mounted inline by Task 12 alongside ClaimSection and DisplaySection — Task 12 ships the three-section shell as a single coherent surface.

### Cross-binding verification (Task 4)

- `components/builder/case-search-config/__tests__/searchInputsCrossBinding.test.tsx` (NEW) — Task 4. Test-only task; depends on Task 12's CaseSearchConfigPanel shell. Verifies the contract that case-list and case-search workspaces edit the same `caseListConfig.searchInputs` array round-trip.

### SA tools (Task 5)

- `lib/agent/tools/case-search-config/setCaseSearchClaim.ts` (NEW)
- `lib/agent/tools/case-search-config/setCaseSearchDisplay.ts` (NEW)
- `lib/agent/tools/case-search-config/shared.ts` (NEW) — `snapshotCaseSearchConfig` helper + Zod input schemas for the two tools' bodies (omitting `moduleIndex`).
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchClaim.test.ts` (NEW)
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchDisplay.test.ts` (NEW)
- `lib/agent/tools/case-search-config/__tests__/schema.test.ts` (NEW) — verifies both tools' input schemas pass `scripts/test-schema.ts` (Anthropic 8-optional-ceiling structural defense).
- `lib/agent/tools/shared/moduleNotFoundResult.ts` (NEW) — relocate the helper out of `case-list-config/shared.ts` (first-duplication: caseSearchConfig tools need the same shape; extract before duplicating).
- `lib/agent/tools/case-list-config/shared.ts` (EDIT) — re-export from the new shared location; remove the inline definition.
- `lib/agent/blueprintHelpers.ts` (EDIT) — `setCaseSearchClaimMutation` + `setCaseSearchDisplayMutation` builders (mirror the case-list-config family's narrowed `(mod: Module, ...)` pattern from the reshape's audit-followup).
- `lib/agent/solutionsArchitect.ts` (EDIT) — register the 2 new tools.
- `lib/agent/summarizeBlueprint.ts` (EDIT) — surface `caseSearchConfig` presence + claim shape + display labels in the SA-facing module summary.
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
- `lib/commcare/expander.ts` (EDIT) — Task 8. Thread the case-search wire output into the suite-level emission.

### Validator rules (Task 11)

- `lib/commcare/validator/rules/case-search/searchInputReferences.ts` (NEW) — Task 11.
- `lib/commcare/validator/rules/case-search/claimConditionTypeCheck.ts` (NEW) — Task 11.
- `lib/commcare/validator/rules/case-search/filterSearchInputConflict.ts` (NEW) — Task 11.
- `lib/commcare/validator/rules/case-search/__tests__/searchInputReferences.test.ts` (NEW)
- `lib/commcare/validator/rules/case-search/__tests__/claimConditionTypeCheck.test.ts` (NEW)
- `lib/commcare/validator/rules/case-search/__tests__/filterSearchInputConflict.test.ts` (NEW)
- `lib/commcare/validator/rules/case-search/__tests__/integration.test.ts` (NEW) — three rules wired through `runValidation`.
- `lib/commcare/validator/rules/module.ts` (EDIT) — register the 3 new rules.

### Workspace shell + URL routing (Task 12)

- `components/builder/case-search-config/CaseSearchConfigPanel.tsx` (NEW) — Task 12. Multi-section workspace shell. Mounts ClaimSection (built by Task 2), DisplaySection (built by Task 3), and the Plan 3 `SearchInputsSection` (cross-bound against `mod.caseListConfig.searchInputs`).
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
  // Claim
  // When `claimCondition` is absent, claim happens unconditionally on case
  // selection from search results. When present, it gates the claim — claim
  // fires only if the predicate evaluates true.
  claimCondition?: Predicate;
  // When true, the wire emits a guard that skips the claim if the user
  // already owns the case (avoids redundant claim API calls when re-opening
  // a case in the user's own list).
  dontClaimAlreadyOwned: boolean;
  // ValueExpression returning a space-separated list of owner IDs whose
  // cases are excluded from the search-results scope. Wire form: `<data
  // key="blacklist" ref="..."/>`. Rare; collapses default closed in the UI.
  blacklistedOwnerIds?: ValueExpression;

  // Display
  searchScreenTitle?: string;
  searchScreenSubtitle?: string;            // markdown rendered at runtime
  emptyListText?: string;
  searchButtonLabel?: string;
  searchAgainButtonLabel?: string;
  searchButtonDisplayCondition?: Predicate; // hides/shows the search button
}
```

Notable schema decisions:

- **No `defaultFilters` slot.** `caseListConfig.filter` is the single Predicate source. The wire emitter projects it onto both the case-list `<detail nodeset>` filter and the search-side `<data key="_xpath_query">` slot at emission time (Task 8).
- **No `customSorts` / `sortByRelevance` slots.** `caseListConfig.columns[*].sort` is the single source for display sort; the wire emitter projects identical `<sort>` blocks onto both `m{N}_case_short` and `m{N}_search_short` (Task 7). Nova never emits `<data key="commcare_sort">` (the ES retrieval-sort override); ES's default `_score` ranking is in effect for fuzzy / phonetic match results.
- **`searchInputs` does NOT live here.** It stays on `mod.caseListConfig.searchInputs` per Plan 3 + the v2 reshape, shared between the case-list inline-search experience and the case-search-config workspace.

Schema is `z.object({ ... }).strict()` with all-optional fields except `dontClaimAlreadyOwned`, which is `z.boolean()` (required at the schema level — no default; the panel UI initializes the field as `false` when first creating `caseSearchConfig`, so the persisted shape always carries the boolean).

**Tests:** schema parse round-trip; required-field gate (`dontClaimAlreadyOwned`); optional fields stripped when undefined; `caseSearchConfig: undefined` round-trips as the absent-slot shape on the Module.

### Task 2: Claim section UI

**Files:** `components/builder/case-search-config/ClaimSection.tsx`, tests.

Three sub-controls:

- **Claim condition** — `<PredicateCardEditor predicate={config.claimCondition} onChange={...} caseTypes={...} currentCaseType={...} knownInputs={mod.caseListConfig?.searchInputs ?? []} />` — optional; absent ≡ "always claim."
- **Don't claim already owned** — boolean toggle wired to `config.dontClaimAlreadyOwned`. Default off.
- **Blacklisted owner IDs** — collapsed-by-default `<ExpressionCardEditor expression={config.blacklistedOwnerIds} onChange={...} />`. Returns a space-separated `ValueExpression`. Rare; collapse default closed.

Routes through `useValidityPropagator` for save-gate propagation (mirrors the `FiltersSection` pattern from Plan 3).

**Mount site:** `CaseSearchConfigPanel.tsx::ClaimSection` (Task 12's shell mounts it).

**Tests:** round-trip; toggle persistence; blacklist expression validity; claim condition validity gates the save state via `useValidityPropagator`.

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

- `setCaseSearchClaim({ moduleIndex, claimCondition?, dontClaimAlreadyOwned, blacklistedOwnerIds? })` — sets the entire claim cluster. `null`-clearing convention on the optional fields: pass `null` to clear `claimCondition` / `blacklistedOwnerIds`; omitted = unchanged.
- `setCaseSearchDisplay({ moduleIndex, searchScreenTitle?, searchScreenSubtitle?, emptyListText?, searchButtonLabel?, searchAgainButtonLabel?, searchButtonDisplayCondition? })` — sets the entire display cluster. `null`-clearing convention applies.

Each tool's `execute` returns `MutatingToolResult<R>` per the shared contract; success result is structured `{ message, ... }` carrying the touched-field-count discriminator (mirror `setCaseListFilter`'s structured-success shape — the SA reads the discriminator without re-parsing prose).

**Module-not-found defense** at the tool boundary, using the relocated `moduleNotFoundResult<TSuccess>(doc, moduleIndex, "set the case-search claim")` helper. Elm-style error: "Tried to set the case-search claim on module index N. Found no module at that index. Look at `getModule`'s projection for valid indices."

**Helper relocation (first-duplication discipline).** The reshape's `moduleNotFoundResult` lives at `lib/agent/tools/case-list-config/shared.ts`. Adding case-search-config as a second consumer triggers the first-duplication rule: relocate the helper to `lib/agent/tools/shared/moduleNotFoundResult.ts` BEFORE adding the second copy. The case-list-config tools' `shared.ts` re-exports from the new location to keep the same import path stable for those tools.

**Structured-output ≤8-optional-fields ceiling** applies — `setCaseSearchDisplay` carries 6 optional fields plus `moduleIndex` (required). Verify via `scripts/test-schema.ts` lowering the input schema through `z.toJSONSchema` and feeding it into the Anthropic schema compiler.

**Module addressing.** Both tools take `moduleIndex: number` (0-based), mirroring the existing case-list-config family's pattern (`setCaseListFilter` and the 8 atomic-op tools all use `moduleIndex`).

**Read-tool projection.** `getModule` returns `mod.caseSearchConfig` verbatim when present. `summarizeBlueprint` adds a one-line surface per module: `"caseSearchConfig: claim={kind} display={titleSet/subtitleSet/...}"` so the SA can resume from a fresh-session prompt without re-reading.

**Registration:** `lib/agent/solutionsArchitect.ts` adds the 2 tools to the shared set alongside the case-list-config family. `lib/mcp/server.ts` mirrors the registration.

**Tests:** each tool's input schema passes `scripts/test-schema.ts`; `execute` happy-path + module-not-found error arms; MCP wire envelope projection round-trips.

### Task 6: Platform-aware compilation decision tree

**Files:** `lib/commcare/suite/case-search/compileForPlatform.ts`, tests.

```ts
type PlatformContext = { platform: "android" | "web"; flags: { splitScreenAvailable: boolean } };

interface WireShape {
  autoLaunch: boolean;
  defaultSearch: boolean;
  inlineSearch: boolean;
  splitScreen: boolean;
}

export function compileForPlatform(
  caseListConfig: CaseListConfig,
  caseSearchConfig: CaseSearchConfig,
  ctx: PlatformContext,
): WireShape;
```

Decision tree (no author override; pure inference from content + platform):

1. **Android** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: true, splitScreen: false }`. Android always shows the case list first regardless of any wire flag (per the spec's web-apps-shaped authoring principle).
2. **Web + split-screen available** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: true, splitScreen: true }`. Modern UX: filters in sidebar, results in main panel, inline.
3. **Web, split-screen unavailable, `caseListConfig.filter` configured AND zero search inputs** → `{ autoLaunch: true, defaultSearch: true, inlineSearch: false, splitScreen: false }`. Skip-to-results — author intent is clear (filter narrows the list, nothing for the user to type, show filtered results immediately).
4. **Web fallback** → `{ autoLaunch: false, defaultSearch: false, inlineSearch: false, splitScreen: false }`. List-first. Forcing a user to fill a search form before they see whether they have any local cases is worse UX than letting them see the list first.

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

**Files:** `lib/commcare/suite/case-search/remoteRequest.ts` (NEW), `lib/commcare/suite/case-search/searchSession.ts` (NEW), `lib/commcare/expander.ts` (EDIT), tests.

`remoteRequest.ts` is the top-level orchestrator that produces the `<remote-request>` element. It composes:

- `<post>` claim — from Task 9.
- `<command>` — search command label.
- `<instance>` declarations — from term-walking the AST.
- `<session>` — owned by `searchSession.ts` (this task), wraps `<query>` (which composes `<data>` slots + `<prompt>` slots from Task 10) and `<datum>`.
- `<stack>` — post-claim navigation; owned by `searchSession.ts`.

The XML shell follows `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml` byte-for-byte at the element-tree shape level.

`<query>` attributes:
- `default_search` from Task 6's `WireShape.defaultSearch`.
- `dynamic_search` defaults to `"false"` (out of v1 scope per spec).
- `search_on_clear` defaults to `"false"` (out of v1 scope per spec).
- `inline_search` from Task 6's `WireShape.inlineSearch`.
- `auto_launch` from Task 6's `WireShape.autoLaunch` — emitted on the `<action>` element inside `m{N}_case_short` (per CCHQ's wire layout in `search_command_detail.xml::detail/action[@auto_launch]`), NOT on `<query>`. The orchestrator threads the bool through to the case-list short-detail emitter (Task 7) at integration time.

**`<data>` slots inside `<query>`:**
- `case_type` — required, references `'<case_type>'`.
- `_xpath_query` — single AND-composed CSQL string. Compiles every contributing predicate from one source plus any advanced-arm search inputs:
  - `caseListConfig.filter` (when present) — the unified filter.
  - Each `caseListConfig.searchInputs[i]` whose `kind === "advanced"` — the `predicate` slot.
  - All contributions AND together at the AST level (`and(...)` builder) BEFORE compilation; the CSQL emitter receives one Predicate and emits one CSQL string. The wire layer carries one `<data key="_xpath_query">` element regardless of how many AST predicates contributed.
  - When the AND-composed result is `match-all` (no filter, no advanced inputs) the `<data key="_xpath_query">` element is omitted entirely (CCHQ accepts the absence cleanly).
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

**Tests:** golden-file comparisons against `remote_request.xml`, one fixture per platform × content combination (Android-list-first / Web-split-screen / Web-skip-to-results / Web-list-first fallback). The `<data key="_xpath_query">` emission asserts AND-composition: a fixture with both a `caseListConfig.filter` AND an advanced-arm search input produces ONE `<data>` element whose CSQL is the AND-conjunction of both contributions.

### Task 9: Claim emission

**Files:** `lib/commcare/suite/case-search/claim.ts`, tests.

`<post url="..." relevant="...">` element. `relevant` attribute compiles from:

- The base "case is not already in casedb" guard: `(count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0)`.
- AND `claimCondition` (when present) — compiles via Plan 1's CSQL emitter (the on-device emitter; this attribute is on-device-evaluated).
- AND the standard "not already owned" guard when `dontClaimAlreadyOwned` is true.

Inside `<post>`:
- `<data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>` — required, always present.
- `<data key="blacklist" ref="..."/>` — when `blacklistedOwnerIds` is set; compiles via the on-device emitter on the supplied `ValueExpression`.

**Wire fixture verification gate.** Verify against `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_config_blacklisted_owners.xml` for the `<data key="blacklist">` shape and against `case-search-with-action.xml` / `case-search-again-with-action.xml` for the action-prompted claim flow shape.

**Tests:** golden-file comparisons; `dontClaimAlreadyOwned` toggle modifies the `relevant` attribute correctly; `blacklistedOwnerIds` adds the `<data key="blacklist">` element when set; absent both = minimal `<post>` shape.

### Task 10: Search prompts emission (per-arm dispatch)

**Files:** `lib/commcare/suite/case-search/searchPrompts.ts`, tests.

Each `caseListConfig.searchInputs[i]` becomes a `<prompt key="{input.name}" input="{input.type}">` element with optional `<display>` for label and `<default>` for default value (compiled from `input.default` via Plan 1's CSQL emitter).

**Per-arm dispatch:**

- **`kind: "simple"`** — emits the `<prompt>` element structurally identically. The simple-arm `(property, mode, via)` slots inform the prompt's *runtime semantics* via CCHQ-side machinery (CCHQ matches the prompt value against the property by mode at search execution time); the wire-emitted shape is the same `<prompt key=... input=...>` for every simple-arm row.

- **`kind: "advanced"`** — emits the `<prompt>` element identically AND the row's `predicate` is rolled into Task 8's AND-composition for `<data key="_xpath_query">`. The prompt declares the input slot; the `_xpath_query` CSQL clause references `instance('search-input:results')/input/field[@name='X']` to consume the input value at search time.

**Empty-input boilerplate.** Advanced-arm predicates referencing the input must wrap in the `whenInputPresent(input("name"), predicate)` AST node — the CSQL emitter generates the `if(count(input), predicate, true())` wrapper automatically. Authors don't write this; the validator (Task 11) ensures advanced-arm predicates either (a) don't reference the input at all (constant predicates) or (b) wrap input references through `whenInputPresent`.

**Tests:** each `input.type` (text / select / date / date-range / barcode) emits the right XML for both arms. Simple-arm emits the same shape regardless of `(property, mode, via)`. Advanced-arm `predicate` lowering exercised.

### Task 11: Validator rules

**Files:** `lib/commcare/validator/rules/case-search/*.ts`, `lib/commcare/validator/rules/module.ts` (EDIT), tests.

Three rules registered in `module.ts`:

- **`searchInputReferences`** — every `input("name")` term reference in `caseSearchConfig.claimCondition` / `caseSearchConfig.searchButtonDisplayCondition` must resolve to a declared `mod.caseListConfig.searchInputs[i].name` (across both `simple` and `advanced` arms). Elm-style error names the bad reference and lists declared input names.
- **`claimConditionTypeCheck`** — `caseSearchConfig.claimCondition` (when present) predicate type-checks via Plan 1's predicate type checker against the module's `caseTypes` schema map. The `searchButtonDisplayCondition` and `blacklistedOwnerIds` AST type-checks are covered by the existing predicate / expression typeCheck rules (Plan 3 ships them on the module-walker; Plan 4 leverages them).
- **`filterSearchInputConflict`** — when `caseSearchConfig` is present (i.e., the module emits a `<remote-request>`), no property may appear as both a `prop(...)` term inside `caseListConfig.filter` AND a simple-arm `caseListConfig.searchInputs[i].property`. Both contribute clauses to the same `<data key="_xpath_query">` AND-composition; CCHQ's runtime treats this as a config error. Elm-style error names the conflicting property + both surfaces.

**Tests:** each rule fires on bad input + passes on clean input. Integration test wires all three through `runValidation` against a fixture with overlapping property names.

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

**`CaseSearchConfigPanel.tsx`** — multi-section UI shell. Renders three sections in order: Claim → Display → Search Inputs. Sticky violet-railed section headers (mirror Plan 3's `CaseListSectionHeader` pattern). Single-scroll magazine layout. Reads `mod.caseSearchConfig` (initializing as `{ dontClaimAlreadyOwned: false }` on first edit) and `mod.caseListConfig.searchInputs` from the doc store; writes via `useBlueprintDocApi().updateModule(moduleUuid, ...)`.

**URL routing changes (the load-bearing fix vs the prior plan, which mis-cited `lib/preview/engine/types.ts`):**

- `lib/routing/types.ts` — extend the `Location` discriminated union with `| { kind: "search-config"; moduleUuid: Uuid }`. The full union now: `home | module | cases | form | search-config`.
- `lib/routing/location.ts` — `parsePathToLocation([moduleUuid, "search-config"], doc)` returns `{ kind: "search-config", moduleUuid }`; `serializePath({ kind: "search-config", moduleUuid })` returns `[moduleUuid, "search-config"]`. Mirror the `cases` arm's exact handling (including the `recoverLocation` fallback semantics).
- `lib/routing/hooks.tsx` — add `openSearchConfig(moduleUuid: Uuid)` to the actions returned by `useNavigate()`. Thread the new `kind` through `useBreadcrumbs` (label: `"Search Config"`).
- `lib/routing/CLAUDE.md` — add `/build/[id]/{moduleUuid}/search-config → search config` to the URL schema table.

**`PreviewShell.tsx`** — add a `loc.kind === "search-config"` branch. Edit mode: dispatch to `<CaseSearchConfigPanel moduleUuid={loc.moduleUuid} />`. Live mode: render a typed placeholder `"Live preview lands in Plan 5"`. Plan 5 owns the live-mode dispatch; Plan 4's placeholder is a sentinel that prevents a runtime `Cannot dispatch on kind: "search-config"` throw and gives the user a non-crash path while Plan 5 lands.

**`ModuleScreen.tsx`** — add a "Search Config" affordance card alongside the existing "Case List" card. Card visibility: `mod.caseType !== undefined` (case-search authoring requires a declared case type). Click handler: `useNavigate().openSearchConfig(moduleUuid)`. Disabled-state rendering: when the module has no `caseType`, the card is greyed with a hover hint "Set a case type on this module to enable search authoring."

**Mount site (locked):** dedicated `/search-config` URL alongside `/cases`. The case-list workspace's three-section magazine stays focused on the case list; the case-search workspace lives separately. Two parallel scrolling workspaces is clearer than one mega-workspace, mirrors the spec's separation of "Case list config" and "Case search config" concerns, and respects the user's "no 4th tab in CaseListWorkspace" directive.

**User-runnable acceptance.** User runs `npm run dev`, opens an existing case-typed module, sees the "Search Config" affordance card on the module screen, clicks it. URL changes to `/build/{appId}/{moduleUuid}/search-config`. Sees the multi-section authoring UI (Claim / Display / Search Inputs). Edits the claim condition via `PredicateCardEditor`. Reloads the page. Sees the change persist (route round-trip; `mod.caseSearchConfig.claimCondition` round-tripped through Firestore + the doc store).

**Tests:** Panel round-trip; URL round-trip via `parsePathToLocation` + `serializePath`; `useNavigate().openSearchConfig` triggers the right history-state push; ModuleScreen affordance card visible / disabled / click-dispatches under the three case-type states.

### Task 13: Plan 4 integration test

**Files:** `__tests__/integration/case-search-authoring.test.ts`.

End-to-end against the testcontainer harness:

- Build a fixture blueprint with `caseListConfig` (columns + sort + searchInputs) AND `caseSearchConfig` (claim + display).
- Run the validator; assert clean.
- Construct a synthetic broken predicate (input ref to a non-declared name in `claimCondition`); assert `searchInputReferences` rule fires with Elm-style error.
- Construct a `filterSearchInputConflict` fixture (property `status` in both `caseListConfig.filter` AND a simple-arm `searchInputs[i].property`); assert rule fires.
- Emit `<remote-request>` via `remoteRequest.ts`; compare against golden file.
- Emit dual `<detail>` blocks via the case-list emitter (Task 7); compare against `search_command_detail.xml` golden file.
- Round-trip via `compileForPlatform` for Android + Web (split-screen-available + split-screen-unavailable + skip-to-results); verify the four `WireShape` outputs.
- SA path: call `setCaseSearchClaim` and `setCaseSearchDisplay` through the agent layer; assert mutation effects on the doc store; assert the structured success result discriminator.
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
- 12 depends on 1, 2, 3 (the shell mounts ClaimSection, DisplaySection, and the cross-bound SearchInputsSection from Plan 3).
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
- [ ] **User-runnable acceptance:** User runs `npm run dev`, opens an existing case-typed module, clicks the "Search Config" affordance card on the module screen. URL changes to `/build/{appId}/{moduleUuid}/search-config`. Sees the three-section authoring UI (Claim / Display / Search Inputs). Edits a claim condition via `PredicateCardEditor`. Reloads the page. Sees the change persist (the AST round-tripped through the doc store + Firestore + the route).

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

Landed across three commits: `f10a82e6` (initial schema + 9 tests) → `4915690f` (CR round-1 fix-pass — JSDoc rewritten in authoring voice; dropped the `<data key="blacklist">` XML literal from `blacklistedOwnerIds`'s field comment; trimmed the schema header) → `86f7e18d` (CR round-2 fix-pass — dropped wire-emission narration from header + `blacklistedOwnerIds` test comment; renamed historical CCHQ-leak field names in the strict-rejection test to `__unknown_a/_b/_c`).

**Final shape:**
- `caseSearchConfigSchema` is `z.object({ ... }).strict()` with 9 fields. `dontClaimAlreadyOwned: z.boolean()` is required at the schema level (no default); other fields are optional (`claimCondition`, `blacklistedOwnerIds` for claim; six display labels for the display cluster).
- `caseSearchConfig: caseSearchConfigSchema.optional()` added to `moduleSchema` — modules without case-search authoring don't carry the slot.
- `CaseSearchConfig` type derived via `z.infer<>`. Re-exported through `lib/domain/index.ts`'s wildcard barrel — no explicit edit needed.
- No builder helper added (matches the existing `caseListConfig` pattern, which has no top-level builder).

**Test count:** 564 / 564 green in `lib/domain` (8 new tests for caseSearchConfig: full-populated round-trip, minimal round-trip, missing-required rejection, type-error rejection, strict-mode unknown-key rejection, explicit-undefined optional handling, module-without-slot, module-with-both-configs).

**Acceptance gates landed:**
- `npm run lint -- lib/domain` clean.
- `npm test -- lib/domain` green (deterministic two runs).
- `npx tsc --noEmit` clean (purely additive change — no consumer breakage).
- Sweeps clean: zero line-number citations, zero CCHQ-leak field name references, zero external-doc references.

**Deltas from the planned shape:** none structural. Voice/clarity iterations across two CR rounds shaped the JSDoc + test comments to match the project's authoring-vs-wire-emission separation.

**Whole-repo build state:** green throughout (the schema addition is purely additive; consumers ignore the new optional slot until Task 12 mounts the workspace).

**Next:** Task 2 — Claim section UI.

### Task 2 — Claim section UI — 2026-05-08

Landed across six commits: `fa6ef683` (initial ClaimSection + 8 tests) → `a8de7358` (extract `PredicateSlotCard` primitive; refactor `FiltersSection` + `ClaimSection` to use it) → `27d3bbcb` (relocate `useValidityPropagator` from `components/builder/case-list-config/useInnerValidityShadow.ts` to `components/builder/shared/useInnerValidityShadow.ts`; 8 consumer import-path updates) → `0440b471` (doc-only cleanup of stale path references post-relocation) → `083a1e79` (CR-round-1 cleanup: snapshot consumer lists reframed as scope descriptions, filter-branded action icons swapped to generic glyphs, `expectedType="text"` wired on the blacklist editor, round-trip test split into per-invariant blocks, preservation test added) → `286703c5` (CR-round-2 cleanup: wire-narration dropped from authoring-voice surfaces in Task 2 scope).

**Final shape:**

- `components/builder/case-search-config/ClaimSection.tsx` (NEW) — three sub-controls authoring `mod.caseSearchConfig`'s claim cluster: claim condition (mounts `<PredicateSlotCard>`), don't-claim-already-owned toggle (default `false`), blacklisted owner IDs (collapsed-by-default `<ExpressionCardEditor>` with `expectedType="text"`). The blacklist editor stays mounted unconditionally when the slot is defined; collapse toggles visibility via the `hidden` attribute, not unmount, so backend-loaded invalid expressions surface their type-check verdict on first render. The `nextConfig` helper seeds `{ dontClaimAlreadyOwned: false }` on first edit so the parent never sees a partial config that fails strict parse, and spreads unrelated slots so a per-slot mutator doesn't lose the rest. Section validity = `predicateValid && (!blacklistPresent || expressionValid)`; the toggle is always valid.

- `components/builder/shared/PredicateSlotCard.tsx` (NEW) — extracted shared primitive owning the "optional `Predicate` slot with section-header chrome + add-clear affordance + slot-presence body switch" shape. Two consumers at landing time: `FiltersSection`'s filter slot, `ClaimSection`'s claim-condition slot. Add affordance emits `matchAll()`; clear emits `undefined` (matches the schema's `.optional()` slot type). Mounts `<PredicateCardEditor>` when the slot is defined; threads validity through `useValidityPropagator` with a slot-presence short-circuit (`!slotPresent || predicateValid`). Action-button glyphs are generic `tabler/plus` + `tabler/x` so the primitive isn't filter-branded.

- `components/builder/shared/useInnerValidityShadow.ts` (MOVED via `git mv`) — relocated from `components/builder/case-list-config/`. Eight consumers across two workspaces (`FiltersSection`, `DisplaySection`, `SearchInputsSection`, `ColumnEditor`, `ExpressionCardEditor`, `PredicateCardEditor`, `ClaimSection`, `PredicateSlotCard`) import from the new shared/ home. The `useValidityPropagator` hook + the `useInnerValidityShadow` (WeakMap-backed sibling for per-row validity) are the canonical validity-propagation utilities for any editor with an `onValidityChange` prop.

- `components/builder/case-list-config/FiltersSection.tsx` (REFACTORED) — chrome moved into the `PredicateSlotCard` primitive; the section shrank from 249 to 142 lines. The section's existing observable behavior is preserved (top-level wrapper + status-density line + preview affordance stay).

- `components/builder/CLAUDE.md` (UPDATED) — new "shared primitives" content describes `PredicateSlotCard`'s role-and-shape (not a snapshot consumer list), the `useInnerValidityShadow` hook home, and how the case-list-config workspace section consumes both. The case-list-config section's `useValidityPropagator` references now point at the shared/ home.

**Test count:** 3858 / 3858 green across 227 test files (deterministic two runs). +3 from Task 2's introduction (ClaimSection +8, PredicateSlotCard +8, FiltersSection unchanged at 8 — the round-trip test split added 2; the preservation test added 1).

**Acceptance gates landed:**

- `npm run lint` clean.
- `npx tsc --noEmit` clean.
- `npm test` 3858 / 14 skipped.
- Drift sweeps clean: zero `case-list-config/useInnerValidityShadow` references after the relocation; zero `tablerFilter` glyphs in the cross-section primitive or the inline blacklist chrome; zero `Today's consumers|Currently used by` snapshot lists in `shared/`; zero `wire emitter|wire layer` references in the Task 2-scope authoring-voice surfaces (the cross-layer wire-coordination comments in `DisplaySection` and `SearchInputsSection` stay — they name load-bearing contracts the authoring code's correctness depends on).

**Deltas from the planned shape:**

The plan's literal file list named `ClaimSection.tsx` + tests. The supervisor expanded scope mid-loop, applying the first-duplication rule to extract `PredicateSlotCard` (FiltersSection had the duplicate chrome shape) and the no-scope-excuses rule to relocate `useValidityPropagator` to its right cross-family home. Both expansions were structurally justified and the implementer correctly stress-tested a third over-broad expansion (a workspace-wide grep that would have stripped load-bearing wire-coordination comments in DisplaySection and SearchInputsSection). The corrected discipline: gratuitous wire-narration in authoring-voice surfaces violates Rule 9; load-bearing wire-contract comments where the authoring code's correctness depends on the wire's order/shape stay (tightened phrasing if needed).

**Acknowledged structural debt:** `PredicateCardEditor` itself wasn't relocated to `shared/` — its transitive import graph (~25-30 files: `cards/ChildPredicateEditor` → all 13 predicate cards → `editorContext` + `path` + `editorSchemas` + `expressionEditorSchemas` + `ExpressionCardEditor` + `primitives/`) is a half-directory rename, not a Task 2 follow-up commit. Tracked at the supervisor's task list as a separate item slated to land between Plan 4 Task 12 (workspace mount) and Task 13 (integration test). The `OptionalSlotCard<T>` generalization that would unify `PredicateSlotCard`'s chrome with `ClaimSection`'s inline `ValueExpression` blacklist chrome is part of the same reorg's scope.

**Whole-repo build state:** green throughout. Task 2's deliverables compose into Task 12's workspace shell when that lands.

**Next:** Task 3 — Display section UI.

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

**Why this section, not its own plan.** The reshape's pattern (`docs/superpowers/plans/2026-05-07-case-list-schema-reshape.md`'s "Audit-driven follow-ups" section) is the precedent: foundation fixes that surface during a plan's CR loop and that the supervisor lands as their own commits stay attached to the plan as followups, not as a separate plan. This section documents the four foundation commits so a fresh-session supervisor reading Plan 4 sees the foundation that Plan 4's later tasks compose against.
