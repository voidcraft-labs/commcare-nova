# Case Data Layer Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 2 of 5. Depends on Plan 1 (Foundation) — needs the Predicate AST, Expression AST, JSON Schema generator, and the Postgres compiler. Does NOT need Plans 3-5.

**Goal:** Stand up the `CaseStore` interface that case-list authoring (Plan 3), search authoring (Plan 4), and preview execution (Plan 5) consume. Ship an in-memory implementation that mirrors the future Postgres compiler operator-by-operator. Replace the existing `lib/preview/engine/dummyData.ts` with a typed `CaseStore`-backed flow that handles forms (registration / followup / close) writing through the same interface as auto-generated sample data.

**Architecture summary:** One interface (`CaseStore`) with two implementations (`InMemoryCaseStore` for V1, `PostgresCaseStore` deferred to Phase-2). The in-memory predicate / expression / relation evaluators mirror Plan 1's Postgres compiler structure operator-by-operator so a future bug-fix in one is easy to port. `HeuristicCaseGenerator` produces deterministic schema-driven sample data per `(app, case-type, seed)` with parent-linkage population so `case_indices` populates and relational previews work end-to-end.

**Tech Stack:** TypeScript (strict), Vitest. Plan 1's AST + Postgres compiler imported but not exercised at runtime.

---

## File Structure

```
lib/case-store/
├── store.ts                          # CaseStore interface — the single seam
├── inMemory/
│   ├── store.ts                      # InMemoryCaseStore implementation
│   ├── predicate.ts                  # AST → in-memory predicate evaluator
│   ├── expression.ts                 # AST → in-memory expression evaluator
│   ├── relation.ts                   # AST → in-memory relation walker
│   └── caseIndices.ts                # in-memory case_indices materialization
├── sample/
│   ├── generator.ts                  # SampleCaseGenerator interface
│   ├── heuristic.ts                  # HeuristicCaseGenerator
│   └── pools/                        # typed value pools per data_type
│       ├── names.ts
│       ├── addresses.ts
│       ├── geopoints.ts
│       └── dates.ts
├── form-bridge/
│   ├── writeThrough.ts               # form → CaseStore mutation
│   └── deriveFromForm.ts             # extract case data from a completed form
├── reset.ts                          # per-session reset
└── __tests__/
    ├── store.test.ts                 # interface compliance harness
    ├── parity.test.ts                # in-memory vs Postgres compiler parity
    └── ...

lib/preview/engine/
├── dummyData.ts                      # DELETED — replaced by case-store/inMemory
└── caseDataBinding.ts                # NEW — preview reads CaseStore via this binding
```

---

## Tasks

### Task 1: `CaseStore` interface

**Files:** `lib/case-store/store.ts`, `__tests__/store.test.ts`

Define the single seam used by every consumer. Methods:
- `query` (predicate + sort + limit + offset)
- `insert`, `update`, `close`, `getById`
- `traverse` (RelationPath walk)
- `syncSchemaForCaseType(appId, caseType)` — re-derives the JSON Schema from the current blueprint and upserts the `case_type_schemas` row. Called by the blueprint-write pipeline (Plan 3 wires it). Synchronous on the write path so the database always reflects the blueprint's current schema before any case-store write evaluates against it.
- `migrateProperty(appId, caseType, property, change)` — schema-migration policy per the spec. `change` is a discriminated union: `rename` (atomic key-copy in same transaction), `retype` (migrate-or-quarantine), `narrow-options` (existing rows with removed values move to `cases_quarantine`).

Return shapes use `Promise<...>` even for in-memory implementations so the Postgres swap is invisible. `migrateProperty` returns a `MigrationReport` with counts of migrated, quarantined, skipped rows plus per-row failure reasons for any quarantined items.

Tests: an interface-compliance harness as a reusable suite — every implementation runs it and gets the same coverage. Validates that `query` honors `predicate`, `sort`, `limit`, `offset`; `insert` populates `case_indices` for parent linkages; `update` preserves untouched properties; `close` marks `closed_on` and excludes from default queries; `syncSchemaForCaseType` upserts the right shape; `migrateProperty` rename / retype / narrow-options paths each behave correctly.


### Task 2: `InMemoryCaseStore` skeleton

**Files:** `lib/case-store/inMemory/store.ts`, tests.

Map-keyed-by-app, holds `cases` and `case_indices` arrays. `insert` / `update` / `close` mutate the maps; `case_indices` is rebuilt on insert/update (no triggers needed in memory). Write predictability matches the spec's Option B materialization — direct edges only, transitive closure computed at read time via the relation walker (Task 5).

Tests: round-trip a case, then traverse its parent. Multi-app isolation (an insert into app A doesn't show up in queries against app B). Update preserves untouched properties.


### Task 3: In-memory predicate evaluator

**Files:** `lib/case-store/inMemory/predicate.ts`, tests.

Direct AST walker. Each Predicate kind has an evaluator that takes a case row + a context (caseTypes, runtime bindings) and returns a boolean. Mirror the Postgres compiler's structure operator-by-operator — same control flow, same type dispatch — so cross-compiler parity tests catch divergence.

Operator coverage: every Plan 1 Predicate operator (sentinels, logical, comparison, in, between, is-null, multi-select-contains, match, within-distance, exists, missing, when-input-present).

Tests: each operator evaluated against fixture cases. Cross-check against Plan 1's Kysely compiler output via parity tests in Task 9.


### Task 4: In-memory expression evaluator

**Files:** `lib/case-store/inMemory/expression.ts`, tests.

Same shape as Task 3 but for ValueExpressions. Operator coverage: every Plan 1 ValueExpression (today, now, date-add, date-coerce, datetime-coerce, double, arith, concat, if, switch, count, format-date, term lifter).

Tests: each operator's value evaluation. `count` exercises Task 5's relation walker.


### Task 5: In-memory relation walker

**Files:** `lib/case-store/inMemory/relation.ts`, `caseIndices.ts`, tests.

Walks RelationPath against the in-memory `case_indices` representation. Self → returns the case itself. Ancestor → walks up via the index identifiers in order. Subcase → finds cases that index this one. Any-relation → child OR extension semantics.

`caseIndices.ts` maintains the in-memory `(case_id, ancestor_id, identifier, depth)` tuples. On insert/update of a case, derives direct edges from the case's `parent_case_id` + any other index references in its properties; the walker computes transitive closure on read via in-memory recursion.

Tests: each RelationPath shape resolves correctly. Multi-hop ancestors. Subcase queries return the right cases. Any-relation excludes neither child nor extension.


### Task 6: `HeuristicCaseGenerator`

**Files:** `lib/case-store/sample/generator.ts`, `heuristic.ts`, `pools/*.ts`, tests.

Implements the `SampleCaseGenerator` interface from the spec. Schema-driven, deterministic per `(app, case-type, seed)`. Generates realistic-but-fake values per `data_type`:
- `text` → name pool (regional names if app context hints at locale, otherwise global)
- `int` → bounded integer pool (age-shaped if property name contains "age", count-shaped otherwise)
- `date` / `datetime` → plausible ranges (DOB pool, registration-date pool, recent-event pool — selected by property-name heuristic)
- `single_select` / `multi_select` → uniform sample over the property's option set
- `geopoint` → cluster around city centers (NYC, Lagos, Mumbai, etc. — varied so search-by-location demos work)
- `time` → reasonable working-hours range

Default count 30 per case type. Generates parent linkages from the case-type relationship graph: child case types get a `parent_case_id` pointing at a randomly-selected parent case. The generated `case_indices` populates from these linkages.

Tests: deterministic output (same seed → same data); valid against the case-type's JSON schema (Plan 1 generator); parent linkages create `case_indices` rows; the relation walker can traverse them.


### Task 7: Form preview write-through

**Files:** `lib/case-store/form-bridge/writeThrough.ts`, `deriveFromForm.ts`, tests.

Routes form completion through `CaseStore`. `deriveFromForm` extracts the case operations a completed form implies (registration → insert; followup → update; close → close), using the existing `lib/commcare/deriveCaseConfig.ts` logic but at runtime per form-completion rather than build-time per blueprint.

Tests: completing a registration form inserts the right shape; followup updates the bound case; close marks closed.


### Task 8: Reset preview data

**Files:** `lib/case-store/reset.ts`, tests.

Two reset modes: per-session reset (auto on tab close) + explicit "Reset preview data" button (UI integration in Plan 5). The function clears the in-memory store for an app and re-seeds via `HeuristicCaseGenerator`.

Tests: reset clears all cases for the app; re-seed produces deterministic data matching the previous seed.


### Task 9: Cross-implementation parity tests

**Files:** `lib/case-store/__tests__/parity.test.ts`.

For a battery of golden AST fixtures, run Plan 1's Postgres compiler against the testcontainers Postgres harness (built in Plan 1 Task C7.5) + the InMemoryCaseStore. Assert the result sets are identical. Catches divergence between the two implementations early; the parity guard becomes a regression net for both.

Tests: every Plan 1 operator + a handful of complex compositions (relational + expression-with-count + nested when-input-present).


### Task 10: Replace `lib/preview/engine/dummyData.ts` with `caseDataBinding.ts`

**Files:** `lib/preview/engine/caseDataBinding.ts` (new), `lib/preview/engine/dummyData.ts` (delete).

`caseDataBinding.ts` exposes the same surface as `dummyData.ts` did (`getCases(caseTypeName)`, `getCaseData(caseTypeName, caseId)`) but routes through `InMemoryCaseStore`. Existing call-sites in the preview engine continue to work; the implementation underneath is now the typed CaseStore.

Tests: existing dummyData tests pass against the new binding (rename + minor adjust). Existing CaseListScreen rendering continues to work.


### Task 11: Barrel exports + CLAUDE.md

**Files:** `lib/case-store/index.ts`, `lib/case-store/CLAUDE.md`.

Document the interface contract, the in-memory vs Postgres swap-pattern, and the parity-test discipline.


---

## Dependencies between tasks

- 1 → 2 → 3, 4, 5 (parallel after 2)
- 5 → 6 (generator needs relation walker for parent linkages)
- 6 → 7 (write-through needs the generator's case shapes)
- 1, 2, 6 → 8
- All → 9, 10, 11

## Final verification

- [ ] `npm run test` green
- [ ] `npm run lint` clean
- [ ] Parity tests pass (Task 9)
- [ ] Existing CaseListScreen still renders against the new binding (Task 10)
- [ ] No `TODO` / `FIXME` in `lib/case-store/`

## Plan shape

Plan 2 is mid-weight relative to the program: smaller than the foundation (which has the AST + three emitters + compiler), larger than the visual / preview-only work. Tasks 1-2 establish the interface; 3-5 build the in-memory evaluator family that mirrors Plan 1's Postgres compiler structure operator-by-operator; 6-7 wire sample data and form completion; 8 ships reset; 9 establishes the cross-implementation parity guard; 10-11 swap the dummyData consumer and finalize barrels.
