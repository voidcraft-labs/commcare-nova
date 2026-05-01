# Case List Authoring Implementation Plan (Plan 3 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 3 of 5. Depends on Plan 1 (Foundation) and Plan 2 (Case data layer). Independent of Plans 4 and 5 — Plan 4 (search authoring) is ordered after this for review momentum, not architectural dependency.

**Goal:** Ship the full case-list authoring experience end-to-end. Module schema migration to typed columns + always-on filter + calculated columns. Case-list-config builder UI: Display section (columns + sort + calculated columns) + Filters section (typed Predicate AST cards) + Search Inputs section. SA tools accept typed AST. Validator rules including field-kind-vs-property-type. Wire emission for case-list short detail + long detail. After Plan 3 ships, users can author typed case lists end-to-end including preview rendering against Plan 2's `CaseStore`.

**Architecture summary:** Module schema gains a structured `caseListConfig` shape replacing the legacy `caseListColumns: { field, header }[]`. The card-based UI is registry-driven (mirrors the existing `fieldEditorSchemas.ts` pattern at `components/builder/editor/`). SA tools accept Predicate / ValueExpression AST shapes via Zod. Validator runs the Plan 1 type checker plus new rules for column field references, field-kind-vs-property-type writers, and representability per platform. Wire emission generates suite XML `<detail>` blocks using Plan 1's case-list-filter emitter for filters and the expression emitter for calculated columns.

**Tech Stack:** Plan 1's AST + emitters + type checker, Plan 2's CaseStore (for preview integration), existing `@base-ui/react` UI primitives, `motion/react` for animations, the existing field-editor patterns.

---

## File Structure

```
lib/domain/modules.ts                                    # extended schema
lib/domain/migrations/2026-list-config.ts                # one-shot migration script (deleted post-run)

components/builder/case-list-config/
├── CaseListConfigPanel.tsx                              # the three-section UI shell
├── DisplaySection.tsx                                   # columns + sort + calculated columns
├── FiltersSection.tsx                                   # always-on filter (Predicate cards)
├── SearchInputsSection.tsx                              # search input definitions
├── ColumnEditor.tsx                                     # per-kind column config
├── CalculatedColumnEditor.tsx                           # ValueExpression composer
├── PredicateCardEditor.tsx                              # Predicate AST composer
├── ExpressionCardEditor.tsx                             # ValueExpression composer
├── SortKeyEditor.tsx                                    # multi-key sort with direction + type
├── editorSchemas.ts                                     # declarative schema → cards
└── __tests__/

lib/agent/tools/case-list-config/
├── setColumns.ts
├── setFilter.ts
├── setSort.ts
├── setCalculatedColumns.ts
├── setSearchInputs.ts
└── __tests__/

lib/commcare/validator/rules/case-list/
├── columnReferences.ts
├── filterTypeCheck.ts
├── sortTypeCheck.ts
├── calculatedColumnTypeCheck.ts
├── fieldKindMatchesPropertyType.ts
├── representability.ts
└── __tests__/

lib/commcare/suite/case-list/
├── shortDetail.ts                                       # case-list <detail> emission
├── longDetail.ts                                        # case-detail <detail> emission
├── columns.ts                                           # per-format-kind column emission
├── sortKeys.ts                                          # <sort> emission
└── __tests__/

scripts/migrate-case-list-config.ts                      # one-shot operator-run migration
```

---

## Tasks

### Task 0: Platform toggle (moved here from Plan 5)

**Files:** `lib/preview/engine/platformSimulator.ts`, `components/builder/preview/PlatformToggle.tsx`, tests.

Move what was Plan 5 Task 1 here. Plans 3 and 4 both have live-preview surfaces that need to render against a chosen platform; without the toggle present from Plan 3 onward, the live preview defaults to one platform's rendering and the author can't see lossy on-Android expansions or web-vs-mobile divergence at edit time. Default to "Web with split-screen" (the most-permissive target). Plan 4's PlatformDivergencePanel reuses this toggle. Plan 5's preview surface composition reuses it again.

Tests: toggling re-derives the WireShape from Plan 4 Task 8's `compileForPlatform` (note: Task 8 is a Plan 4 task; Plan 3 imports the function once Plan 4 ships, but the toggle UI itself can ship in Plan 3 with a stub `compileForPlatform` that returns Web/split-screen by default).


### Task 1: Extend `Module` schema with typed `caseListConfig`

**Files:** `lib/domain/modules.ts`, `lib/domain/migrations/2026-list-config.ts`, `__tests__/`.

Replace `caseListColumns: { field, header }[]` and `caseDetailColumns: ...` with a structured shape:

```ts
type Column = { kind: ColumnKind; field?: string; header: string; ...per-kind config };
type ColumnKind = "plain" | "date" | "time-since-until" | "phone" | "id-mapping" | "late-flag" | "search-only";

type CalculatedColumn = { id: string; header: string; expression: ValueExpression; sort?: { type: SortType; direction: "asc" | "desc" } };

type SortKey = { source: { kind: "property"; property: string } | { kind: "calculated"; columnId: string }; type: SortType; direction: "asc" | "desc" };
type SortType = "plain" | "date" | "integer" | "decimal";

type SearchInputDef = { name: string; label: string; type: "text" | "select" | "date" | "date-range" | "barcode"; default?: ValueExpression; xpath?: Predicate };

interface CaseListConfig {
  columns: Column[];
  sort: SortKey[];
  filter?: Predicate;                       // always-on filter
  calculatedColumns: CalculatedColumn[];
  searchInputs: SearchInputDef[];
  detailColumns?: Column[];                 // long-detail (case detail) override; null/absent = mirror short
}
```

`module.caseListColumns` and `caseDetailColumns` fields are removed entirely from the Zod schema.

The migration script at `scripts/migrate-case-list-config.ts` reads each app doc in Firestore, transforms `{ field, header }[]` into `Column[]` with `kind: "plain"`, leaves `filter` / `calculatedColumns` / `searchInputs` empty, writes back. Idempotent. Operator-run, archived after run (per the spec's migration policy).

The Module schema mutator wires `CaseStore.syncSchemaForCaseType(appId, caseType)` (Plan 2 Task 1) into every blueprint mutation that affects a case-type's property surface (`data_type` change, property add/remove/rename, option add/remove). The sync runs synchronously on the blueprint write path before the mutation returns success. For changes requiring data migration (retype, narrow-options, rename), the mutator additionally calls `migrateProperty` — sync first, then migrate, so the migration evaluates against the current schema.

Tests: schema parse, migration script idempotent on fixture docs, blueprint mutation triggers `syncSchemaForCaseType`, retype mutation triggers `migrateProperty` after sync.


### Task 2: Predicate card editor

**Files:** `components/builder/case-list-config/PredicateCardEditor.tsx`, `editorSchemas.ts`, tests.

Renders a Predicate AST as composable cards. AND/OR groups with drag-drop add/remove (using the existing `pragmatic-drag-and-drop` infra). Each card type maps to a Predicate kind:
- Comparison card: property dropdown + operator dropdown + value input (typed by property)
- Multi-select card: property dropdown (multi-select-typed only) + value picker + quantifier (Any / All)
- Text-match card: property dropdown (text-typed only) + value input + mode (Fuzzy / Phonetic / Date variants / Starts with)
- Geo card: property dropdown (geopoint-typed only) + center input + distance + unit
- Range card: property + lower/upper bounds + inclusive/exclusive toggles
- Null check card: property dropdown
- Sentinel cards: "Match all cases" / "Match no cases" (used for explicit empty filter or default-disabled state)
- Relation card: typed RelationPath builder (one step or multi-hop ancestor / single-step subcase) + nested filter card group + quantifier (any/all/none/count comparison)
- Conditional card: search input + nested clause

Cards type-check against the case-type schema at construction; invalid configurations cannot be saved (the save button is disabled until type-check passes).

Editor schemas live as a declarative table mirroring the field editor pattern at `components/builder/editor/fieldEditorSchemas.ts` — each Predicate kind has an entry mapping to its card component. Adding a new operator means adding one entry.

Tests: building common predicates round-trips through the AST; rejecting type-mismatched literals shows inline error; drag-drop reordering preserves AST structure.


### Task 3: Expression card editor

**Files:** `components/builder/case-list-config/ExpressionCardEditor.tsx`, tests.

Same shape as Task 2 but for ValueExpressions. Calculated-column UX is a sub-mode of this editor. Cards:
- Term card: property / input / session-context / literal / value-expression-of-... picker
- Date constant cards: today / now (zero-arg)
- Date arithmetic card: date input + interval picker + quantity input
- Coercion cards: date-coerce / datetime-coerce / double
- Arithmetic card: left + op + right
- Concat card: list of value-expression parts
- Conditional card: cond Predicate (delegates to the predicate editor) + then expression + else expression
- Switch card: on expression + case rows (when literal + then expression) + fallback
- Count card: RelationPath + optional filter (nested predicate editor)
- Format-date card: date expression + pattern picker

Tests: same shape as predicate editor.


### Task 4: Column editor (per-format-kind)

**Files:** `components/builder/case-list-config/ColumnEditor.tsx`, tests.

Discriminated UI per `ColumnKind`. Plain shows `field` picker + header input. Date shows field + format pattern. Time Since/Until shows field (date-typed) + interval unit + threshold + display label. Phone Number shows field. ID Mapping shows field + a table of value→label rows. Late Flag shows field (date-typed) + threshold (interval picker) + flag display value. Search Only is field-only — declares the field is searchable but not displayed.

Tests: each kind round-trips through the schema; invalid combinations (e.g., Late Flag on a non-date property) surface inline errors.


### Task 5: Sort key editor

**Files:** `components/builder/case-list-config/SortKeyEditor.tsx`, tests.

Multi-key, drag-orderable list. Each key has source (property pick / calculated column pick) + type (Plain / Date / Integer / Decimal) + direction (Ascending / Descending).

Tests: round-trip; conflicting types surface as errors (sorting an `int` property as Date type).


### Task 6: Display section composition

**Files:** `components/builder/case-list-config/DisplaySection.tsx`, tests.

Shell that mounts `ColumnEditor` (drag-orderable column list) + `SortKeyEditor` + `CalculatedColumnEditor` (which uses Task 3's expression editor). Renders a live-preview panel showing what the case list looks like with the current configuration (uses Plan 2's `InMemoryCaseStore` to query against generated sample data).

Tests: editing a column updates the preview; reordering columns reorders the preview; adding a calculated column shows the computed values.


### Task 7: Filters section composition

**Files:** `components/builder/case-list-config/FiltersSection.tsx`, tests.

Mounts `PredicateCardEditor` for the always-on filter. Live-preview panel re-runs the case-list query through Plan 2's `InMemoryCaseStore` showing how many cases pass the filter.

Tests: editing the filter updates the result count and visible rows; clearing the filter shows all cases.


### Task 8: Search Inputs section composition

**Files:** `components/builder/case-list-config/SearchInputsSection.tsx`, tests.

List of input definitions. Per-input: type picker (text / select / date / date-range / barcode), label input, optional default-value `ExpressionCardEditor`, optional advanced XPath via `PredicateCardEditor`.

Tests: round-trip; type-coupling warnings (a `Date` input declared on a text property surfaces a warning).


### Task 9: SA tools

**Files:** `lib/agent/tools/case-list-config/*.ts`, tests.

One tool per surface: `setCaseListColumns`, `setCaseListFilter`, `setCaseListSort`, `setCalculatedColumns`, `setCaseListSearchInputs`. Each accepts the typed AST shape via Zod (no strings). The structured-output schema constraint (≤8 optional fields per array item from CLAUDE.md) lives at the case-list level — the typed AST schemas come from the shared `lib/domain/predicate` source, never inlined into tool defs.

Tests: schema parse via `scripts/test-schema.ts`; each tool's effect on the doc verified via integration test against a fixture blueprint.


### Task 10: Validator rules

**Files:** `lib/commcare/validator/rules/case-list/*.ts`, tests.

Five new rules:
- `columnReferences` — every `Column.field` resolves to a known case property on the module's case type.
- `filterTypeCheck` — `caseListConfig.filter` type-checks via Plan 1's checker.
- `sortTypeCheck` — every `SortKey` source resolves; the declared sort type is compatible with the source's data type.
- `calculatedColumnTypeCheck` — every CalculatedColumn's expression type-checks; the resulting type is appropriate for the column's display kind.
- `fieldKindMatchesPropertyType` — for every form field with `case_property_on` set: the field's kind matches the property's declared `data_type`. Multiple writers must agree. The mapping table lives in this rule (text↔text, single_select↔single_select, geopoint↔geopoint, etc.; explicit reject list for incompatible coercions).
- `representability` — runs Plan 1's representability checker against case-list-filter and search-filter dialects, surfacing per-platform warnings.

Tests: each rule fires on bad input, doesn't fire on good input. Cross-rule integration: a multi-writer property with conflicting kinds surfaces one error per writer.


### Task 11: Wire emission — case-list short detail

**Files:** `lib/commcare/suite/case-list/shortDetail.ts`, `columns.ts`, `sortKeys.ts`, tests.

Walks `module.caseListConfig` and produces the suite XML `<detail id="m{n}_case_short">` block:
- `<title>` from module
- `<lookup>` if module has external lookup config (deferred — V1 emits without)
- `<no_items_text>` from `caseListConfig.searchInputs.emptyListText` if defined
- `<variables>` from calculated columns (each becomes a `<calculated-property>` with the Plan 1 expression emitter's output)
- One `<field>` per `Column`:
  - `<style>` (per kind defaults)
  - `<header>` with locale id
  - `<template>` with the property reference or computed-column reference
  - `<sort>` per matching SortKey (using Plan 1 expression emitter for sort-calc cases)
- `<no_items_text>` if `searchInputs.emptyListText` is defined

Filter: not emitted in `<detail>` (it's a nodeset filter on the `<entry>`'s session datum); emitted via `lib/commcare/suite/case-list/nodesetFilter.ts` separately at the entry-construction site.

Tests: golden-file comparisons against expected suite XML for each format kind. Cross-check fragment structure against `commcare-hq/.../tests/data/suite/` fixtures.


### Task 12: Wire emission — case-list long detail

**Files:** `lib/commcare/suite/case-list/longDetail.ts`, tests.

Same shape as Task 11 for the long-detail (case detail) view. Uses `caseListConfig.detailColumns` if present, falls back to `columns` if absent.

Static tabs included; nodeset-driven related-case tabs deferred to follow-up spec per the v2 spec's V1-OUT list.

Tests: golden-file comparisons.


### Task 13: Wire emission — nodeset filter on entry

**Files:** `lib/commcare/suite/case-list/nodesetFilter.ts`, tests.

The case-list filter (`caseListConfig.filter`) compiles via Plan 1's case-list-filter emitter and is appended to the case-list nodeset on the module's `<entry>` session datum: `instance('casedb')/casedb/case[@case_type='X'][<filter>]`.

When `caseListConfig.filter` is `match-all` or absent, no filter is appended.

Tests: golden-file comparison; verifies the filter precedence (`@case_type` filter always first, then user filter).


### Task 14: Plan 3 integration test

**Files:** `__tests__/integration/`.

End-to-end: build a fixture blueprint with case-list-config; run the validator; emit suite XML; compare against golden file; run preview rendering against `InMemoryCaseStore` and verify the rendered case list matches expected.


### Task 15: Migration script run + archive

**Files:** `scripts/migrate-case-list-config.ts`, run procedure documented.

Execute the migration in a dry-run against prod Firestore; review diff; execute live; archive script. This is operator work, not a code task — but worth scheduling in the plan so it doesn't get missed.


---

## Dependencies between tasks

- 1 standalone (schema)
- 2, 3, 4, 5 depend on 1 + Plan 1 + Plan 2's CaseStore (for live-preview)
- 6 depends on 1, 3, 4, 5 + Plan 2
- 7 depends on 2 + Plan 2
- 8 depends on 2, 3
- 9 depends on 1 + Plan 1
- 10 depends on 1 + Plan 1
- 11 depends on 1 + Plan 1
- 12 depends on 11
- 13 depends on 1 + Plan 1
- 14 depends on all prior + Plan 2
- 15 standalone (operator run)

## Final verification

- [ ] `npm run test` green
- [ ] `npm run lint` clean
- [ ] Integration test (Task 14) passes
- [ ] Migration script dry-run produces no surprises
- [ ] No `TODO` / `FIXME` in new code

## Plan shape

The bulk of work is in the card-based UI (Tasks 2 + 3, the predicate and expression card editors) — the typed predicate / expression UX is the user-facing differentiator. Tasks 6, 7, 8 compose the three sections of the case-list config panel. Tasks 9, 10 ship the SA tools and validator rules. Tasks 11, 12, 13 emit suite XML for the case list nodeset + short detail + long detail. Task 14 is the integration test; Task 15 is the operator-run migration.
