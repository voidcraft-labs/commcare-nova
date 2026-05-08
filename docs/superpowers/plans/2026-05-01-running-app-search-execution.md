# Running-App Search Execution Implementation Plan (Plan 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 5 of 5. Depends on Plans 1, 2, 3 (case-list authoring shipped end-to-end at v2 shape per the 2026-05-07 reshape), Plan 4 (case-search authoring, including platform-aware compilation + `<remote-request>` emission). After Plan 5 ships, the flipbook's running-app view executes searches end-to-end against the typed case data; forms write through `CaseStore` so the user can walk through full registration → search → followup workflows on the same `cases` rows the editor inspects.

**Goal:** Wire Plans 1-4 into the running-app view of the flipbook. The case-list screen reads through `CaseStore.query(...)` with runtime-bound search-input values; the case-search screen renders as split-screen with inline filter — the canonical web-apps shape, which is Nova's authoring target. Forms write through `CaseStore` so subsequent searches see new cases. "Generate sample data" / "Reset sample data" buttons wire Plan 2's actions to the UI.

**Architecture summary:** Running-app rendering is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule. Authors see one canonical rendering — split-screen with filters in the sidebar, results in the main panel, inline-search; the modern UX. There is no Android-vs-Web toggle and no per-platform preview surface; CCHQ's runtime fragmentation is a CCHQ-side concern that the export adapter handles silently when the app ships. There is no separate preview lifecycle — the running-app view operates on the same `cases` rows the editor inspects, and form submissions write to the same Cloud SQL Postgres rows that case-list editing reads.

**Already shipped (foundation that Plan 5 extends):**
- `lib/preview/engine/caseDataBindingHelpers.ts` (server-only) — `readCases`, `readCaseListPreview`, `readFilterPreview`, `seedSampleCases`, `apply{Registration,Followup,Close,Survey}Mutation` over `CaseStore.query(...)` (post-pattern-A-fix, the helpers accept `caseTypeSchemas` directly).
- `lib/preview/engine/caseDataBindingClient.ts` (client-safe) — pure projections + typed-error mappers + `pickBlueprintDoc`.
- `lib/preview/engine/caseDataBinding.ts` (Server Actions) — `loadCasesAction`, `populateSampleCasesAction`, `submitFormAction`, etc.
- `components/preview/screens/CaseListScreen.tsx` — v2 case-list rendering (module-name heading, visibility-filtered columns, calc cell rendering via `evaluateColumnValue`).
- `components/preview/screens/FormScreen.tsx` — running-app form rendering (forms render against case data via `useCaseData`).
- `components/preview/PreviewShell.tsx` — edit-vs-live mode dispatcher mounting `CaseListWorkspace` (edit) and `CaseListScreen` (live) for `screen.kind === "cases"`.

Plan 5 EXTENDS this foundation; it does not rewrite it. The v2 shape is in place. The work below adds the runtime-bindings layer, the split-screen search rendering, the form write-through wiring at the running-app form-completion path, the sample-data buttons, and a `PreviewSurface` shell that wraps live-mode rendering with shared affordances.

**Tech Stack:** Plans 1-4 + the existing preview engine + `motion/react` for transitions, `@base-ui/react` for split-screen layout primitives.

---

## File Structure

```
lib/preview/engine/
├── runtimeBindings.ts                                       # NEW — search-input values → predicate context
├── caseDataBindingHelpers.ts                                # EXTEND — readCases takes runtime input values

components/preview/
├── PreviewSurface.tsx                                       # NEW — shell wrapping live-mode rendering with shared affordances
├── shared/
│   ├── SearchInputForm.tsx                                  # NEW — collects search-input values; handles both arms
│   ├── SampleDataActions.tsx                                # NEW — generate / reset sample-data buttons
│   └── ResetPreviewButton.tsx                               # NEW — clears any per-session in-memory state (no-op for v1; placeholder)
├── screens/
│   ├── CaseListScreen.tsx                                   # EXTEND — inline filter bar when search inputs configured + no split-screen
│   └── SplitScreenSearchScreen.tsx                          # NEW — sidebar filters + main-panel results
└── __tests__/
```

Existing files in `components/preview/screens/` stay at their current paths; the reshape's Task 7 already brought them to v2. Plan 5 extends rather than relocates.

---

## Tasks

### Task 1: Runtime bindings layer

**Files:** `lib/preview/engine/runtimeBindings.ts` (NEW), tests.

Translates current search-input values into a runtime context the predicate compiler consumes. The contract:

```ts
export interface SearchInputValues {
  // Map from input.name → user-typed string value (empty string ≡ user has not filled).
  readonly values: ReadonlyMap<string, string>;
}

// Compose default-filter + per-input runtime contributions into one Predicate
// that flows to store.query(...). Per-arm dispatch:
//
//   - kind: "simple" — value flows through (property, mode, via) into a per-mode
//     comparison (eq / fuzzy / starts-with / etc.) AND'd into the composed result.
//   - kind: "advanced" — value is bound to the input(name) term reference inside
//     the input's predicate; the predicate is AND'd into the composed result.
//
// Empty values short-circuit per the search-input default-mode contract — an
// input whose value is "" contributes no predicate clause (per-mode behavior
// follows the wire-emission contract Plan 4 Task 12 ships).
export function composeRuntimeFilter(
  defaultFilters: Predicate | undefined,
  searchInputs: ReadonlyArray<SearchInputDef>,
  inputValues: SearchInputValues,
): Predicate;
```

`composeRuntimeFilter` returns a single Predicate that the case-list screen passes to `readCases` / `readCaseListPreview` as the `predicate` slot. The case-list's own `caseListConfig.filter` is composed in by the helper layer; this function adds the search-config layer (default filters + per-input contributions) on top.

Tests: simple-arm `(property, mode, via)` mapping per mode (exact / fuzzy / starts-with / phonetic / fuzzy-date / range / multi-select-contains); advanced-arm `input(name)` term substitution; empty-value short-circuit per input.

### Task 2: Extend `readCases` for runtime values

**Files:** `lib/preview/engine/caseDataBindingHelpers.ts` (EDIT), tests.

`readCases` currently takes `caseListConfig?: CaseListConfig` and threads `config?.filter` into `store.query(...)`. Extend it to accept `inputValues?: SearchInputValues`. When supplied, the helper composes `composeRuntimeFilter(caseSearchConfig.defaultFilters, caseListConfig.searchInputs, inputValues)` (or similar — verify the exact arg shape during implementation; the helper may need `caseSearchConfig` threaded in for the default filters) and AND's the result into the predicate that flows to `store.query(...)`.

The Server Action `loadCasesAction` accepts the typed values from the running-app surface, projects them through `pickBlueprintDoc` + `buildCaseTypeMap` (the post-pattern-A-fix shape), and forwards.

Tests: case-list with no search inputs reads as before; case-list with simple-arm inputs filters correctly; case-list with advanced-arm inputs filters correctly; mixed-arm composition AND's clauses.

### Task 3: SearchInputForm component

**Files:** `components/preview/shared/SearchInputForm.tsx` (NEW), tests.

Renders one widget per `SearchInputDef` based on `input.type` (text / select / date / date-range / barcode):
- `type: "text"` → text input.
- `type: "select"` → option dropdown sourced from the case property's declared `options` (resolved via case-type schema).
- `type: "date"` → single date picker.
- `type: "date-range"` → two date pickers.
- `type: "barcode"` → text input + camera/scanner affordance (placeholder for v1; renders as text input with a camera icon).

The widget shape is the same regardless of `input.kind` — a user filling in a search input doesn't see the simple-vs-advanced distinction. The arm distinction is purely about how the value binds to the predicate at runtime (Task 1).

Debounced onChange (300ms) emits a fresh `SearchInputValues` map up to the parent (CaseListScreen or SplitScreenSearchScreen).

**Mount sites:**
- `components/preview/screens/CaseListScreen.tsx` — inline filter bar when `searchInputs.length > 0` and no case-search-config / split-screen.
- `components/preview/screens/SplitScreenSearchScreen.tsx` — sidebar in split-screen mode.

Tests: each `type` renders the right widget; debounced onChange fires per typed character; empty value clears the input.

### Task 4: Extend CaseListScreen with inline filter bar

**Files:** `components/preview/screens/CaseListScreen.tsx` (EDIT), tests.

When the module's `caseListConfig.searchInputs.length > 0` AND the module has no `caseSearchConfig` (or has one that doesn't escalate to split-screen per Plan 4 Task 8's decision tree), render `<SearchInputForm />` at the top of the list. The form's onChange updates the screen's state; the screen re-runs the case-list query with the new runtime-bound predicate (debounced).

When the module has `caseSearchConfig` AND the platform compilation says split-screen, the screen escalates to `<SplitScreenSearchScreen />` (Task 5) instead of the inline filter bar.

Existing v2 rendering stays: module-name heading, visibility-filtered columns, calc cell rendering via `evaluateColumnValue`, sort directives via `buildCaseStoreSortKeys`.

Tests: inline filter bar renders when `searchInputs.length > 0` and no split-screen; typing filters live; clearing inputs reverts to filter-only results.

### Task 5: Split-screen search screen

**Files:** `components/preview/screens/SplitScreenSearchScreen.tsx` (NEW), tests.

When the module has `caseSearchConfig` AND `caseListConfig.searchInputs` (or `caseSearchConfig.defaultFilters` is non-empty), render the split-screen layout: filters in a left sidebar, results in the main panel. The sidebar mounts:
- `<SearchInputForm />` (Task 3) for the inputs.
- A collapsed read-only summary card for `caseSearchConfig.defaultFilters` ("4 default filters always apply" with an expand affordance to view; not editable from the running-app surface).

The main panel renders the case-list rows (the same rendering CaseListScreen produces) against the runtime-bound predicate. Typing in the sidebar re-runs the query (debounced).

`@base-ui/react` provides the split-screen layout primitive (verify the canonical Base UI component during implementation; may use `@base-ui/react/dialog`'s split layout pattern or a plain CSS grid).

Tests: typing filters results; clearing inputs reverts to default-filter-only results; collapsed default-filter card expands on click.

### Task 6: Form running-app write-through wiring

**Files:** `components/preview/screens/FormScreen.tsx` (EDIT — verify which file owns the form-submit path), tests, `components/preview/shared/FormHandoff.tsx` (NEW if extraction is justified).

When a running-app form completes, the consumer:
1. Calls `controller.validateAll()`; on validate-pass:
2. Calls `controller.computeSubmissionMutation({ caseId, caseTypes })` with `caseTypes` from the session-store and `caseId` from the URL nav stack.
3. Dispatches the resulting mutation to `submitFormAction(mutation, appId)` (Server Action; resolves session, constructs `withOwnerContext`, routes to the matching `CaseStore` method per `mutation.kind`).
4. Invalidates the case-list query for the affected `(appId, caseType)` so the case list re-queries on next render.

The author can walk through registration → list → followup → list and see their changes — operating on the same `cases` rows the editor inspects.

If `FormScreen.tsx` already has partial wiring from prior work, verify against the current code and extend; don't duplicate.

Tests: registration form adds a case to the list; followup form's update shows in the list; close form transitions the case to status `closed` and removes from default-open queries.

### Task 7: Generate / Reset sample data UI

**Files:** `components/preview/shared/SampleDataActions.tsx` (NEW), tests.

Two buttons:
- **Generate sample data** — calls `populateSampleCasesAction(appId, caseType, blueprint, count)`. On empty case-type, the action populates via `HeuristicCaseGenerator`.
- **Reset sample data** — calls `resetSampleCasesAction(appId, caseType, blueprint, count)`. Deletes existing rows and regenerates with a fresh seed.

Buttons surface with disabled-state UX during the action's pending phase. Toast on success/error (use the project's existing toast primitive — verify path during implementation).

**Mount site:** `components/preview/PreviewSurface.tsx` (Task 8) — shared affordances overlay anchored at a corner of the live-mode surface, visible across both `CaseListScreen` and `SplitScreenSearchScreen`.

Tests: each button triggers the corresponding action; rendering reflects the regenerated data after re-query.

### Task 8: PreviewSurface shell + mount site

**Files:**
- `components/preview/PreviewSurface.tsx` (NEW) — shell that wraps the live-mode rendering with shared affordances. Mounts `<SampleDataActions />` + the screen-specific component routed via `screen.kind`:
  - `screen.kind === "cases"` → render `<CaseListScreen />` (which itself escalates to `<SplitScreenSearchScreen />` per Task 5).
  - `screen.kind === "form"` → render `<FormScreen />`.
- `components/preview/__tests__/PreviewSurface.test.tsx` (NEW).
- `components/preview/PreviewShell.tsx` (EDIT) — live-mode dispatcher mounts `<PreviewSurface screen={screen} />` instead of the bare screen-specific component. Edit-mode dispatcher unchanged (`CaseListWorkspace` for cases, `CaseSearchConfigPanel` for search-config per Plan 4 Task 14, etc.).

**Mount site (locked):** `PreviewSurface` mounts inside `PreviewShell` for live-mode arms. The URL schema is unchanged — the dispatcher target changes from `<CaseListScreen />` → `<PreviewSurface screen={screen} />`. After Plan 5 ships, the routing is:
- Edit + `kind === "cases"` → `CaseListWorkspace` (Plan 3 surface, authoring).
- Edit + `kind === "search-config"` → `CaseSearchConfigPanel` (Plan 4 surface, authoring).
- Live + `kind === "cases"` or `kind === "form"` → `PreviewSurface` (Plan 5 surface, running-app).

`PreviewSurface` keeps the live-mode rendering composable: any future shared affordance (a "running app help" panel, a session inspector, etc.) lands in `PreviewSurface` once and surfaces everywhere live-mode renders.

**User-runnable acceptance.** User runs `npm run dev`, opens an existing case-typed app, navigates to a module's case list at `/build/{appId}/{moduleUuid}/cases`. Toggles to live mode (existing builder toolbar). Sees actual case rows from `CaseStore` rendering with the configured columns / sort / filter / calc applied. If the module has search inputs, sees an inline filter bar above the list (or a split-screen sidebar if the module has case-search-config). Types into a search input; sees the list filter live (debounced). Clicks "Generate sample data" (Task 7); sees additional rows appear. Submits a registration form for that case type via the running-app surface. Returns to the case list. Sees the new case appear. Clicks "Reset sample data". Sees the cases collection clear back to its prior state. End-to-end running-app loop reachable from a fresh `npm run dev` session WITHOUT any "configure first" handholding.

### Task 9: Plan 5 integration test

**Files:** `__tests__/integration/case-list-search-running-app.test.ts` (NEW).

End-to-end against the testcontainer harness:
- Build a fixture blueprint with full `caseListConfig` (columns + sort + searchInputs) + `caseSearchConfig` (default filters + claim + display).
- Mount `<PreviewSurface />` against the fixture (use React Testing Library's `render` against a test-wrapped `PreviewShell`).
- Verify the rendering matches the web-apps split-screen-with-inline-filter shape.
- Type values into the search inputs; assert the filtered list re-renders via the runtime-bindings layer.
- Submit a registration form via the running-app surface; assert the case persists through subsequent `CaseStore.query(...)` calls against the live Cloud SQL Postgres `cases` rows.
- Reset sample data; assert the case-list re-queries to the regenerated rows.
- Cover all four `WireShape` arms from Plan 4 Task 8 implicitly (the running-app surface always renders the web-apps split-screen shape regardless of platform compilation; the integration test verifies the rendering doesn't accidentally branch on platform context).

---

## Dependencies between tasks

- 1 standalone (depends on Plan 1 + the v2 reshape's `SearchInputDef` discriminated union).
- 2 depends on 1 + Plan 2's `CaseStore.query(...)` shape (post-pattern-A-fix `caseTypeSchemas` parameter).
- 3 depends on 1 + the v2 `SearchInputDef` discriminated union.
- 4 depends on 2 + 3 + Plan 3's reshape Task 7 (the v2 `CaseListScreen` foundation).
- 5 depends on 3 + 4 + Plan 4 Task 8 (the platform-aware decision tree).
- 6 depends on 2 + Plan 2's `CaseStore` write methods + the form engine's `computeSubmissionMutation`.
- 7 depends on Plan 2's `generateSampleData` / `resetSampleData` actions.
- 8 depends on 4, 5, 6, 7 + Plan 3 reshape Task 7 (the live-mode dispatch pattern).
- 9 depends on all prior.

## Final verification

- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean.
- [ ] `npm run build` clean.
- [ ] `npm test` green (full suite, deterministic two consecutive runs).
- [ ] Integration test (Task 9) passes.
- [ ] Manual smoke: full registration → search → followup workflow round-trips through the running-app view against live Cloud SQL Postgres.
- [ ] Web-apps split-screen rendering verified end-to-end (no platform toggle; this is the only rendering).
- [ ] **User-runnable acceptance:** User runs `npm run dev`, navigates to `/build/{appId}/{moduleUuid}/cases` in live mode, sees actual case rows. Submits a registration form via the running-app surface. Returns to case list. Sees the new case appear. Types into a search input; sees the list filter live. Clicks "Generate sample data"; sees additional rows. End-to-end running-app loop reachable from a fresh `npm run dev` session WITHOUT any "configure first" handholding.

## ⚠️ Pre-deploy: run the migration script BEFORE the v2 code goes live

The branch ships v2 `caseListConfig`. Production Firestore holds existing apps on v0 (most) and v1 (the brief Plan-3 window). The v2 code cannot read v0 / v1 shapes — every app will fail to load until those docs are migrated.

The migration script at `scripts/migrate-case-list-schema-reshape.ts` is idempotent and three-way-aware (v0 → v2, v1 → v2, v2-skipped). Run it at deploy time, not before.

**Deploy sequence:**

1. **Dry-run against prod Firestore** (no writes; default mode):

   ```
   npx tsx scripts/migrate-case-list-schema-reshape.ts
   ```

   Inspect the per-doc `version=v0|v1|v2-skipped|corrupt` log lines. Confirm `failedCount === 0` (corrupt-doc count) and `corruptInputCount === 0` (per-input corrupt count). If either is non-zero, investigate the named app(s) before proceeding — the script exits non-zero on `failedCount > 0`.

2. **Live-write** (writes to prod Firestore):

   ```
   npx tsx scripts/migrate-case-list-schema-reshape.ts --write
   ```

3. **Deploy the v2 code IMMEDIATELY after the live-write completes.** The gap between migration-write and v2-deploy is the only window of broken prod (v2 data + v1 code). Keep it minutes, not hours.

4. **Verify** a few apps load post-deploy; confirm the case-list workspace + case-search-config surfaces render against migrated data.

Re-running the live migration after deploy is safe — already-v2 docs skip cleanly via the schema-parse idempotency check. Use the `--app-id <id>` flag for surgical retry against any single app that was flagged corrupt.

## Plan shape

The bulk of work is in the runtime-bindings layer (Task 1), the split-screen search screen (Task 5), and the form-completion / write-through wiring (Task 6). After Plan 5 ships, the case-list-and-search foundation is end-to-end exercised in the flipbook's running-app view against live Cloud SQL Postgres rows. The running-app view is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule — Plans 4 and 5 do not produce per-platform preview affordances; CCHQ runtime fragmentation is handled silently by the export adapter when the app ships.

---

## Program-level summary (after Plan 5 ships)

The five plans together produce: typed Predicate AST + typed Expression AST, three per-dialect wire emitters, Postgres compiler via Kysely, Cloud SQL Postgres `CaseStore` (the live runtime from v1), schema-driven sample data generator, case-list authoring UI with typed cards + wire emission for short/long detail, case-search authoring UI + wire emission for `<remote-request>`, platform-aware compilation (export-adapter-side, silent), and the flipbook's web-apps-shaped running-app surface with split-screen search, inline filter, and write-through forms. Each plan ships separately-reviewable, separately-testable software.

What ships:
- Typed Predicate AST + Expression AST (Plan 1)
- Three per-dialect wire emitters + Postgres compiler (Plan 1)
- Cloud SQL Postgres `PostgresCaseStore` — the live runtime (Plan 2)
- `HeuristicCaseGenerator` writing through `PostgresCaseStore` (Plan 2)
- Case-list authoring UI with typed cards + the v2 schema reshape (Plan 3 + 2026-05-07 reshape)
- Wire emission for case-list short / long detail (Plan 3)
- Case-search authoring UI (Plan 4)
- Wire emission for `<remote-request>` (Plan 4)
- Platform-aware compilation, export-adapter-side (Plan 4)
- Flipbook running-app surface — web-apps-shaped, with split-screen search, inline filter, write-through forms (Plan 5)

What ships in follow-up specs:
- Visual / geo formats + case tiles (visual/geo formats spec)
- Related-case detail tabs (advanced detail spec)
- Multi-select case lists (multi-select spec)
- Data registries, lookup tables, geocoder receivers (advanced search spec)
- LLM-powered sample data generator (sample-data sources spec; Haiku backlog item)
- Firestore retirement (independent spec)
