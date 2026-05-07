# Running-App Search Execution Implementation Plan (Plan 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 5 of 5. Depends on Plans 1, 2, 3, 4 (full prior stack). After Plan 5 ships, the flipbook's running-app view executes searches end-to-end against the typed case data, and forms write through `CaseStore` so the user can walk through full registration → search → followup workflows on the same `cases` rows the editor inspects.

**Goal:** Wire Plans 1-4 into the running-app view of the flipbook. The case-list screen integrates the AST → Kysely compiler. The case-search screen renders as split-screen with inline filter — the canonical web-apps shape, which is Nova's authoring target. Forms write through `CaseStore` so subsequent searches see new cases. "Generate sample data" / "Reset sample data" buttons wire Plan 2's actions to the UI.

**Architecture summary:** Running-app rendering is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule. Authors see one canonical rendering — split-screen with filters in the sidebar, results in the main panel, inline-search; the modern UX. There is no Android-vs-Web toggle and no per-platform preview surface; CCHQ's runtime fragmentation is a CCHQ-side concern that the export adapter handles silently when the app ships. There is no separate preview lifecycle — the running-app view operates on the same `cases` rows the editor inspects, and form submissions write to the same Cloud SQL Postgres rows that case-list editing reads.

**Tech Stack:** Plans 1-4 + existing preview engine + `motion/react` for transitions, `@base-ui/react` for split-screen layout primitives, the existing CaseListScreen patterns at `components/preview/screens/`.

---

## File Structure

```
components/builder/preview/
├── PreviewSurface.tsx                                   # shell that mounts the running-app surface
├── CaseListScreen.tsx                                   # web-apps-shape case list (with optional inline filter + split-screen)
├── SplitScreenSearchScreen.tsx                          # filters left, results right
├── SearchInputForm.tsx                                  # collects search input values
├── shared/
│   ├── CaseRow.tsx                                      # one row in the case-list rendering
│   ├── FormHandoff.tsx                                  # engine.computeSubmissionMutation() → submitFormAction()
│   └── ResetPreviewButton.tsx
└── __tests__/

lib/preview/engine/
├── caseListBinding.ts                                   # binds module's caseListConfig to live CaseStore queries
├── caseSearchBinding.ts                                 # binds search config to CaseStore via runtime bindings
└── runtimeBindings.ts                                   # Search-input values → Predicate runtime context
```

---

## Tasks

### Task 1: Case-list binding

**Files:** `lib/preview/engine/caseListBinding.ts`, tests.

Translates `caseListConfig` + current search-input values into a `CaseStore.query(...)` call. Resolves runtime bindings (search inputs become typed terms in the predicate context). Returns the rendered case rows.

Tests: filtering and sort behave correctly; calculated columns evaluate; search inputs filter live.


### Task 2: Case-list screen

**Files:** `components/builder/preview/CaseListScreen.tsx`, tests. **Replaces** the existing `components/preview/screens/CaseListScreen.tsx` — Plan 2 Task 7 already deleted that screen + its `dummyData.ts` import path during the binding cutover, so this task creates the new screen at the new path against the typed `caseDataBinding` from Plan 2. Verify no surviving import of the old path before declaring done (`rg "from .*components/preview/screens/CaseListScreen"`).

Renders the case list with calculated columns + sort + filter applied. Web-apps shape: when search inputs are configured, an inline filter bar at the top of the list collects values and re-runs the query (debounced). When the case-list module also carries a search config, the screen escalates to split-screen via Task 3 (filters in sidebar, results in main panel).

Tests: golden-output rendering against fixture cases.


### Task 3: Split-screen search

**Files:** `components/builder/preview/SplitScreenSearchScreen.tsx`, `SearchInputForm.tsx`, tests.

When a module's case-search-config carries default filters or search inputs, the case-list escalates to split-screen: filters in a left sidebar + results in the main panel. The sidebar mounts `SearchInputForm` (collecting input values) + a collapsed view of the default filters (read-only, since they apply automatically). The main panel shows the live-filtered case list. Typing in the input form re-runs the query (debounced).

Tests: typing filters results; clearing inputs reverts to default-filter-only results.


### Task 4: Form running-app write-through wiring

**Files:** `components/builder/preview/shared/FormHandoff.tsx`, tests.

When a running-app form completes, the consumer calls `controller.validateAll()`; on validate-pass, calls `controller.computeSubmissionMutation({ caseId, caseTypes })` with `caseTypes` from the session-store and `caseId` from the URL nav stack, then dispatches the result to `submitFormAction(mutation, appId)` (Server Action; resolves session, constructs `withOwnerContext`, routes to the matching `CaseStore` method per `mutation.kind`). The case list re-queries automatically (cache invalidation by app-id + case-type). The author can walk through registration → list → followup → list and see their changes — operating on the same `cases` rows the editor inspects.

Tests: registration form adds a case to the list; followup form's update shows in the list; close removes the case from default-open queries.


### Task 5: Generate / Reset sample data UI

**Files:** `components/builder/preview/shared/SampleDataActions.tsx`, tests.

Wires Plan 2's `generateSampleData` and `resetSampleData` actions to UI buttons. "Generate sample data" populates an empty case-type via `HeuristicCaseGenerator`. "Reset sample data" deletes existing rows for the case-type and regenerates with a fresh seed. Neither implies a mode switch — the user is still in the running app, just with seeded data.

Tests: each button triggers the corresponding action; rendering reflects the regenerated data.


### Task 6: Plan 5 integration test

**Files:** `__tests__/integration/`.

End-to-end: build a fixture blueprint with full caseListConfig + caseSearchConfig; mount the running-app surface; verify the rendering matches the web-apps split-screen-with-inline-filter shape; complete a form; verify the case persists through subsequent queries against the live Cloud SQL Postgres `cases` rows.


### Task 7: PreviewSurface shell + mount site

**Origin.** Plan 5's File Structure (line 19) lists `PreviewSurface.tsx` as "shell that mounts the running-app surface." Tasks 1-5 build the inner pieces (case-list binding, case-list screen, split-screen search, form write-through, sample-data UI). No Task in the original plan explicitly builds the SHELL or names its mount site. This is the same gap class that bit Plan 3 (case-list authoring) and Plan 4 (case-search authoring); discovered during the family audit on 2026-05-07. This task closes it BEFORE Plan 5 dispatch.

**Files:**
- `components/builder/preview/PreviewSurface.tsx` (NEW) — shell that mounts the running-app surface. The implementation REPLACES the existing `components/preview/screens/CaseListScreen.tsx` consumed by `PreviewShell` in live mode (per Plan 3 Task 8.5's edit-vs-live split: `CaseListWorkspace` handles edit, `CaseListScreen` handles live; Plan 5 replaces `CaseListScreen` with the new builder-context running-app rendering).
- `components/builder/preview/__tests__/PreviewSurface.test.tsx` (NEW).
- `components/preview/PreviewShell.tsx` (EDIT) — replace `CaseListScreen` import + dispatch with `PreviewSurface` for live-mode `kind === "cases"` (and `kind === "form"` if Plan 5 covers form running-app rendering — per Tasks 2-4 it does).
- `components/preview/screens/CaseListScreen.tsx` (DELETE) — replaced by `PreviewSurface` + Task 2's `CaseListScreen` at the new path `components/builder/preview/CaseListScreen.tsx`.

**Mount site (named explicitly per the audit gate).** `PreviewSurface` renders inside `PreviewShell` for live-mode `kind === "cases"` (and `kind === "form"` for live-mode form rendering per Tasks 2-4). The URL schema is unchanged from Plan 3 Task 8.5; only the live-mode dispatcher target changes. Plan 3 Task 8.5 ships:
- Edit + `kind === "cases"` → `CaseListWorkspace` (Plan 3 surface, authoring).
- Live + `kind === "cases"` → existing `CaseListScreen` (Plan 5 will replace this arm).

Plan 5 Task 7 changes the live-mode arm to `PreviewSurface`. After Plan 5 ships, the routing is symmetric:
- Edit + `kind === "cases"` → `CaseListWorkspace` (authoring; Plan 3).
- Live + `kind === "cases"` → `PreviewSurface` (running-app; Plan 5).

**User-runnable acceptance.** User runs `npm run dev`, opens an existing case-typed app, navigates to a module's case list at `/build/{appId}/{moduleUuid}/cases`. Toggles to live mode (existing builder toolbar). Sees actual case rows from `CaseStore` rendering with the configured columns/sort/filter applied (replaces today's stub `CaseListScreen` rendering). Submits a registration form for that case type via the running-app surface. Returns to the case list. Sees the new case appear in the list. Clicks "Generate sample data" (Task 5). Sees additional rows appear. Clicks "Reset sample data". Sees the cases collection clear back to its prior state. End-to-end running-app loop is reachable from a fresh `npm run dev` session WITHOUT any "configure first" handholding.


---

## Dependencies between tasks

- 1 standalone (depends on Plans 1-3)
- 2 depends on 1 + Plan 3
- 3 depends on 2 + Plan 4
- 4 depends on 2 + Plan 2
- 5 depends on Plan 2
- 6 depends on all prior
- 7 depends on 2, 3, 4, 5 + Plan 3 Task 8.5 (the edit-mode split that Plan 5's live mode mirrors)

## Final verification

- [ ] `npm run test` green
- [ ] `npm run lint` clean
- [ ] Integration test (Task 6) passes
- [ ] Manual smoke: full registration → search → followup workflow round-trips through the running-app view against live Cloud SQL Postgres
- [ ] Web-apps split-screen rendering verified end-to-end (no platform toggle; this is the only rendering)
- [ ] **User-runnable acceptance:** User runs `npm run dev`, navigates to `/build/{appId}/{moduleUuid}/cases` in live mode, sees actual case rows. Submits a registration form via the running-app surface. Returns to case list. Sees the new case appear. End-to-end running-app loop reachable from a fresh `npm run dev` session WITHOUT any "configure first" handholding.

## Plan shape

The bulk of work is in the split-screen search screen (Task 3) and the form-completion / write-through wiring (Task 4). After Plan 5 ships, the case-list-and-search foundation is end-to-end exercised in the flipbook's running-app view against live Cloud SQL Postgres rows. The running-app view is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule — Plans 4 and 5 do not produce per-platform preview affordances; CCHQ runtime fragmentation is handled silently by the export adapter when the app ships.

---

## Program-level summary (after Plan 5 ships)

The five plans together produce: typed Predicate AST + typed Expression AST, three per-dialect wire emitters, Postgres compiler via Kysely, Cloud SQL Postgres `CaseStore` (the live runtime from v1), schema-driven sample data generator, case-list authoring UI with typed cards + wire emission for short/long detail, case-search authoring UI + wire emission for `<remote-request>`, platform-aware compilation (export-adapter-side, silent), and the flipbook's web-apps-shaped running-app surface with split-screen search, inline filter, and write-through forms. Each plan ships separately-reviewable, separately-testable software.

What ships:
- Typed Predicate AST + Expression AST (Plan 1)
- Three per-dialect wire emitters + Postgres compiler (Plan 1)
- Cloud SQL Postgres `PostgresCaseStore` — the live runtime (Plan 2)
- `HeuristicCaseGenerator` writing through `PostgresCaseStore` (Plan 2)
- Case-list authoring UI with typed cards (Plan 3)
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
