# Preview Search Execution Implementation Plan (Plan 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 5 of 5. Depends on Plans 1, 2, 3, 4 (full prior stack). After Plan 5 ships, preview executes searches end-to-end against the typed case data, surfaces platform-divergence visually, and forms write through `CaseStore` so the user can walk through full registration → search → followup workflows in the builder.

**Goal:** Wire Plans 1-4 into the preview UI. The case-list screen integrates the AST evaluator. The case-search screen renders as split-screen on web-shape preview and inline-filter on mobile-shape preview. Forms write through `CaseStore` so subsequent searches see new cases. A platform simulator toggle lets the author preview as Android vs Web; the platform-aware compiler from Plan 4 drives the rendering. Reset Preview Data button wires Plan 2's reset to the UI.

**Architecture summary:** Preview rendering is platform-shape-driven, not config-shape-driven. The author picks a "preview as Android" or "preview as Web" mode; the platform-aware compiler from Plan 4 produces a `WireShape` for that platform; the preview UI renders the shape. Lossy expansions surface visually (the case-list filter that becomes nested OR-clauses on Android renders the same data as the CSQL `selected-any` would, but the UI surfaces "this is what runs on Android — N OR-clauses" so the author understands the cost).

**Tech Stack:** Plans 1-4 + existing preview engine + `motion/react` for transitions, `@base-ui/react` for split-screen layout primitives, the existing CaseListScreen patterns at `components/preview/screens/`.

---

## File Structure

```
components/builder/preview/
├── PreviewSurface.tsx                                   # shell that mounts platform-specific layouts
├── PlatformToggle.tsx                                   # Android / Web toggle
├── android/
│   ├── CaseListScreen.tsx                               # Android-shape: case-list with inline filter
│   └── InlineFilterBar.tsx                              # the inline-filter UI
├── web/
│   ├── CaseListScreen.tsx                               # Web-shape: case-list-only OR split-screen
│   ├── SplitScreenSearchScreen.tsx                      # filters left, results right
│   └── SearchInputForm.tsx                              # collects search input values
├── shared/
│   ├── CaseRow.tsx                                      # one row in any case-list rendering
│   ├── FormHandoff.tsx                                  # form-completion → CaseStore.writeThrough
│   └── ResetPreviewButton.tsx
└── __tests__/

lib/preview/engine/
├── caseListBinding.ts                                   # binds module's caseListConfig to live CaseStore queries
├── caseSearchBinding.ts                                 # binds search config to CaseStore via runtime bindings
├── platformSimulator.ts                                 # picks the right binding for the chosen platform
└── runtimeBindings.ts                                   # Search-input values → Predicate runtime context
```

---

## Tasks

### Task 1: Platform simulator + toggle

**Files:** `lib/preview/engine/platformSimulator.ts`, `components/builder/preview/PlatformToggle.tsx`, tests.

Author picks Android or Web; Web sub-toggles for "with split-screen" vs "without." The simulator passes the chosen `PlatformContext` to Plan 4's `compileForPlatform` to produce a `WireShape`; the preview surface renders the shape.

Tests: toggling re-derives the shape; toggling re-renders the surface.

**Effort:** 1 day. **Dependencies:** Plan 4 Task 8.

### Task 2: Case-list binding

**Files:** `lib/preview/engine/caseListBinding.ts`, tests.

Translates `caseListConfig` + current platform-context + current search-input values into a `CaseStore.query(...)` call. Resolves runtime bindings (search inputs become typed terms in the predicate context). Returns the rendered case rows.

Tests: filtering and sort behave correctly; calculated columns evaluate; search inputs filter live.

**Effort:** 2 days. **Dependencies:** Plan 1 + Plan 2 + Plan 3.

### Task 3: Web — case-list screen

**Files:** `components/builder/preview/web/CaseListScreen.tsx`, tests.

Renders the case list with calculated columns + sort + filter applied. Web-shape default (no split-screen, no inline filter) shows just the list.

Tests: golden-output rendering against fixture cases.

**Effort:** 2 days. **Dependencies:** Tasks 1, 2 + Plan 3.

### Task 4: Web — split-screen search

**Files:** `components/builder/preview/web/SplitScreenSearchScreen.tsx`, `SearchInputForm.tsx`, tests.

When the platform-context produces split-screen, render filters in a left sidebar + results in the main panel. The sidebar mounts `SearchInputForm` (collecting input values) + a collapsed view of the default filters (read-only, since they apply automatically). The main panel shows the live-filtered case list. Typing in the input form re-runs the query (debounced).

Tests: typing filters results; clearing inputs reverts to default-filter-only results.

**Effort:** 4 days. **Dependencies:** Tasks 1, 2, 3 + Plan 4 search config.

### Task 5: Android — case-list with inline filter

**Files:** `components/builder/preview/android/CaseListScreen.tsx`, `InlineFilterBar.tsx`, tests.

Mobile-shape: case list with inline filter at the top. The filter applies via the search-inputs the author configured (re-runs the query on each keystroke, debounced). The lossy-on-mobile multi-select-contains expansions surface in a "what's actually running" debug pane (collapsed by default).

Tests: typing in the inline filter narrows results; the lossy expansion debug panel shows the expanded XPath.

**Effort:** 2 days. **Dependencies:** Tasks 1, 2.

### Task 6: Form preview write-through wiring

**Files:** `components/builder/preview/shared/FormHandoff.tsx`, tests.

When a preview form completes, route through Plan 2's `writeThrough`. The case list re-queries automatically (cache invalidation by app-id + case-type). The author can walk through registration → list → followup → list and see their changes.

Tests: registration form adds a case to the list; followup form's update shows in the list; close removes the case from default-open queries.

**Effort:** 2 days. **Dependencies:** Plan 2 Task 7 + Tasks 3, 5.

### Task 7: Reset preview data UI

**Files:** `components/builder/preview/shared/ResetPreviewButton.tsx`, tests.

Wires Plan 2's `reset` to a button. Resets store, re-seeds via `HeuristicCaseGenerator`, re-renders the active screen.

Tests: button triggers reset; rendering reflects the regenerated data.

**Effort:** 0.5 days. **Dependencies:** Plan 2 Task 8.

### Task 8: Plan 5 integration test

**Files:** `__tests__/integration/`.

End-to-end: build a fixture blueprint with full caseListConfig + caseSearchConfig; mount the preview surface; toggle platforms; verify each platform's rendering matches the WireShape; complete a form; verify the case persists through subsequent queries.

**Effort:** 2 days. **Dependencies:** All prior + Plans 1-4.

---

## Dependencies between tasks

- 1 standalone (depends on Plan 4)
- 2 depends on 1 + Plans 1-3
- 3, 4, 5 depend on 1, 2 + Plan 3 + Plan 4
- 6 depends on Plan 2 + Tasks 3, 5
- 7 depends on Plan 2
- 8 depends on all prior + Plans 1-4

## Final verification

- [ ] `npm run test` green
- [ ] `npm run lint` clean
- [ ] Integration test (Task 8) passes
- [ ] Manual smoke: full registration → search → followup workflow round-trips through preview
- [ ] Platform toggle visibly changes the rendered UX between Android and Web

## Effort estimate

~13 days. Bulk of the cost is in the split-screen search screen (Task 4 = 4 days) and the form-completion / write-through wiring (Task 6 = 2 days). After Plan 5 ships, the case-list-and-search foundation is end-to-end testable in the builder.

---

## Program-level summary (after Plan 5 ships)

Total program effort across Plans 1-5: ~78 days of focused engineering. Calendar time at typical utilization: ~16-20 weeks.

What ships:
- Typed Predicate AST + Expression AST (Plan 1)
- Three per-dialect wire emitters + Postgres compiler (Plan 1)
- In-memory `CaseStore` with parity-tested predicate / expression / relation evaluators (Plan 2)
- `HeuristicCaseGenerator` (Plan 2)
- Case-list authoring UI with typed cards (Plan 3)
- Wire emission for case-list short / long detail (Plan 3)
- Case-search authoring UI (Plan 4)
- Wire emission for `<remote-request>` (Plan 4)
- Platform-aware compilation (Plan 4)
- Preview surface with platform toggle, split-screen search, inline filter, write-through forms (Plan 5)

What ships in follow-up specs:
- Cloud SQL Postgres deploy + `PostgresCaseStore` swap (Phase-2 deploy spec)
- Visual / geo formats + case tiles (visual/geo formats spec)
- Related-case detail tabs (advanced detail spec)
- Multi-select case lists (multi-select spec)
- Data registries, lookup tables, geocoder receivers (advanced search spec)
- LLM-powered sample data generator (sample-data sources spec; Haiku backlog item)
- Firestore retirement (independent spec)
