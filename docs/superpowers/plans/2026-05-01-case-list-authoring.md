# Case List Authoring Implementation Plan (Plan 3 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use frontend-design and superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 3 of 5. Depends on Plan 1 (Foundation) and Plan 2 (Case data layer). Independent of Plans 4 and 5 — Plan 4 (search authoring) is ordered after this for review momentum, not architectural dependency.

**Goal:** Ship the full case-list authoring experience end-to-end. Module schema migration to typed columns + always-on filter + calculated columns. Case-list-config builder UI: Display section (columns + sort + calculated columns) + Filters section (typed Predicate AST cards) + Search Inputs section. SA tools accept typed AST. Validator rules including field-kind-vs-property-type. Wire emission for case-list short detail + long detail. After Plan 3 ships, users can author typed case lists end-to-end including preview rendering against Plan 2's `CaseStore`.

**Architecture summary:** Module schema gains a structured `caseListConfig` shape replacing the legacy `caseListColumns: { field, header }[]`. The card-based UI is registry-driven (mirrors the existing `fieldEditorSchemas.ts` pattern at `components/builder/editor/`). SA tools accept Predicate / ValueExpression AST shapes via Zod. Validator runs the Plan 1 type checker plus new rules for column field references, field-kind-vs-property-type writers, and search-input-mode-matches-property-type. Wire emission generates suite XML `<detail>` blocks using Plan 1's case-list-filter emitter for filters and the expression emitter for calculated columns. Per the foundation lock (`feedback_max_subset_no_dimagi_litter.md`), there is no representability checker — wire emission is faithful and per-runtime-player capability gaps are Dimagi's structural concern, not Nova's authoring rejection layer.

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
├── searchInputModeMatchesPropertyType.ts
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

### Task 1: Extend `Module` schema with typed `caseListConfig` — SHIPPED

SHIPPED 2026-05-06 in commits `bf44fb42` (schema replacement) → `5597ed36` (saga + classifier) → `5b75219e` (retype mid-migration rollback test) → `84b83b02` (saga compensates case-type addition by direct schema drop + auto-save dual-read collapse + `withOwnerContext` dedup) → `e65692b8` (test name + comment alignment with silent-strip behavior) on branch `feat/case-list-search`.

**Schema replacement (`lib/domain/modules.ts`):** `caseListColumns: { field, header }[]` and `caseDetailColumns: ...` removed from the Zod schema entirely; one structured `caseListConfig?: CaseListConfig` slot replaces both. The shape:

- `Column` is a Zod `discriminatedUnion("kind")` over the seven format kinds (`plain`, `date`, `time-since-until`, `phone`, `id-mapping`, `late-flag`, `search-only`). Per-kind config arms carry their required fields verbatim from the spec — date `pattern`, time-since-until `threshold`/`unit`/`displayLabel`, id-mapping `mapping: { value: string; label: string }[]`, late-flag `threshold`/`unit`/`flagDisplayValue`. The implementer made `field: string` required across every arm (the plan sketch had `field?: string`); the case-list-config builder UI surfaces in Tasks 6-8 default the property reference at column-add time. Search-only is a "declared searchable, not displayed" column, so `field` is always meaningful.
- `CalculatedColumn` carries `id`, `header`, `expression: valueExpressionSchema`, optional `sort: sortConfigSchema`.
- `SortKey.source` is a `discriminatedUnion("kind")` over `{ kind: "property"; property }` and `{ kind: "calculated"; columnId }`.
- `SearchInputMode` is a `discriminatedUnion("kind")` over the seven mode shapes.
- `SearchInputDef` carries `name`, `label`, `type`, optional `property`, optional `via: relationPathSchema`, optional `mode: searchInputModeSchema`, optional `default: valueExpressionSchema`, optional `xpath: predicateSchema`.
- `Predicate` / `ValueExpression` / `RelationPath` schemas import from the predicate package (NOT inlined).

When `caseListConfig` is present, `columns` / `sort` / `calculatedColumns` / `searchInputs` are present arrays (possibly empty) — no nullable arms inside the populated shape.

**Migration script (`scripts/migrate-case-list-config.ts`):** reads each Firestore app doc, transforms `{ field, header }[]` into `Column[]` with `kind: "plain"`, leaves `filter` / `calculatedColumns` / `searchInputs` empty arrays. Idempotent at both per-module and per-blueprint granularities. `--dry-run` flag prints the diff without writing. Companion test suite at `scripts/__tests__/migrate-case-list-config.test.ts` (9 tests) covers legacy, already-migrated, never-had-columns, mixed shape, blueprint-level idempotency. Operator-run; Task 15 owns the live execution; the script archives after that.

**Saga (`lib/db/applyBlueprintChange.ts` + `lib/db/classifyCaseTypeChanges.ts`):** wraps the Firestore-blueprint-write boundary. The classifier diffs prior vs prospective `caseTypes[].properties[]` and emits one of three entry shapes per case-type:

- **Schema-sync-only entry** (no `property`/`change`) — for additive changes (property add, option add, case-type addition) or removal (Phase A re-derives the schema; Phase B drops the now-orphaned property index).
- **Discriminated `change` entry** — for caller-supplied per-row migration hints (`rename` / `retype` / `narrow-options`).
- **No entry** — for non-property-surface mutations (case-type rename without property change, etc.) so the classifier short-circuits the saga.

The saga's flow:

1. Load prior `AppDoc` (or accept a caller-supplied snapshot via the optional `priorBlueprint` parameter — the auto-save PUT route uses this to collapse the dual Firestore read).
2. Compute classifier entries from prior vs prospective.
3. Forward-apply each entry via `store.applySchemaChange({ appId, caseType, blueprint: prospective, ...entry })`.
4. On success, commit Firestore via `updateApp` / `updateAppForRun`.
5. On any failure (Postgres mid-loop, Firestore commit), run `compensate(applied, prior)` — which discriminates: a case-type present in the prior blueprint compensates via `applySchemaChange(prior)`; a case-type added in the prospective state compensates via `dropSchema` (the new `CaseStore` interface arm — Phase A deletes the `case_type_schemas` row, Phase B drops per-property indexes via the empty-set diff). The two-arm discrimination delivers genuine "exactly the prior state" — no orphan rows from compensated additions.

A single `withOwnerContext` allocation covers both forward and compensation paths.

**`CaseStore.dropSchema`:** new interface arm at `lib/case-store/store.ts`, implemented in `lib/case-store/postgres/store.ts`. Idempotent on absence (Phase A's DELETE is a no-op when the row is gone; Phase B's `DROP INDEX CONCURRENTLY IF EXISTS` is a no-op when the index is gone). The contract test pair at `lib/case-store/__tests__/storeContract.ts` pins remove + idempotency.

**Auto-save call sites:** `app/api/apps/[id]/route.ts` PUT (loads `AppDoc` once, asserts ownership, threads `app.blueprint` into the saga) and `lib/mcp/context.ts` `saveBlueprint` (loads internally, the saga handles ownership through `withOwnerContext`). Chat-side `generationContext.saveBlueprint` stays fire-and-forget by design (per `lib/agent/CLAUDE.md`); the SA fix-retry loop covers missed saves.

**Tests:** schema parse (12 tests covering empty / populated / per-kind invalid combinations / silent-strip of legacy keys), classifier (14 tests covering every diff branch), migration script (9 tests), saga integration (7 tests using `setupPerTestDatabase` against real Postgres testcontainer — happy-path additive, runId routing to `updateAppForRun`, fast-path on non-case-type mutations, retype-with-quarantine via hint, Firestore-commit-failure compensation on additive change, retype mid-migration rollback proof per spec line 129, case-type-addition compensation via `dropSchema`).

**Cross-store coordination — saga pattern with compensation.** Firestore and Postgres are independent commit boundaries; without orchestration, the two stores can drift after a partial failure. The shipped saga closes the gap — the "apps are always in a valid state" lock holds end-to-end across the boundary.

**Plan 2 follow-up — chat-completion materialization (CLOSED).** The chat-side fire-and-forget save path didn't run the saga, so the window between SA generation and the user's first awaited edit produced `SchemaNotSyncedError` on every case-store insert (sample-data populate, form submit, live-preview reads). Closed in commits `73fe1d5d` (initial) → `c5db53f8` (CR fix-pass: reorder + classify on throw) → `9ee72463` (test-mock guard comments). The new awaited helper `lib/db/materializeCaseStoreSchemas.ts` runs once in `validateApp`'s success arm — `await materialize → emit data-done → fire-and-forget completeApp` — so any user-initiated case-store action subsequent to the completion celebration sees a synced schema. Materialization throws classify through the existing classified-error path (`emitError` + `failApp`) so the SA loop fails cleanly instead of retry-storming into the staleness reaper. Pure additive — no saga, no compensation; case-type rows don't exist yet at first run, so `applySchemaChange` is straight UPSERT (Phase A) + parallel `CREATE INDEX CONCURRENTLY` (Phase B). The chat-side `generationContext.saveBlueprint` (per-emit-mutation save) stays fire-and-forget for SSE timing.

Final state: 3144/3144 tests pass, 14 skipped, 0 failed; tsc + biome lint clean.


### Task 2: Predicate card editor — SHIPPED

SHIPPED 2026-05-06 in commits `84b967eb` (initial feat) → `24bc922c` (CR fix-pass: drop dead imports + suppressed-warnings dead code) → `4410ace9` (CR fix-pass: MatchCard value-term path listening + dead-export cleanup) → `cdc43459` (CR fix-pass: custom drag preview + collapse self-alias + ref discipline) → `0bd81602` (CR fix-pass: align ref-update with useRowDnd convention) → `ce4cd786` (CR fix-pass: preserve non-canonical AST shapes in pickers + tighten validity) → `62357d25` (CR fix-pass: preserve non-Term left slots + complete structural-twin operand swap) → `a39356a7` (CR fix-pass: preserve prop.via in property pickers via shared primitive) → `c5c00f29` (final polish: selfPath canonical tests + hoisted filters + JSDoc precision) on branch `feat/case-list-search`.

**What landed:**

The registry-driven Predicate AST card editor at `components/builder/case-list-config/`. Twelve card types (Comparison, MultiSelectContains, Match, WithinDistance, Between, In, IsNull, IsBlank, MatchAll, MatchNone, Exists+Missing, WhenInputPresent, LogicalGroup for and/or/not) plus per-card primitives, plus tests. Cards type-check against the case-type schema via `checkPredicate` on every change; invalid configurations propagate validity to the parent through `onValidityChange`. Inline errors render at the offending node's path via `useEditorErrorsAt` (exact) or `useEditorErrorsAtOrBelow` (prefix capture for the deeper-emitting `match.value.term` path).

The editor schema lives as a declarative table mirroring `components/builder/editor/fieldEditorSchemas.ts`: `predicateCardSchemas` is `Record<Predicate["kind"], PredicateCardSchema<K>>` so a new Predicate kind without an entry fails to compile.

AND/OR group drag-drop reorder uses `@atlaskit/pragmatic-drag-and-drop` mirroring the form-list pattern at `components/preview/form/virtual/useRowDnd.ts` — typed payload helpers (`dragData.ts`), custom drag preview via `setCustomNativeDragPreview` (clause label + icon), per-group monitor scoped by `containerKey`, render-time ref writes for stable monitor deps, cycle guard via per-group `canMonitor`. Recursive editor: `exists.where`, `not.clause`, `when-input-present.clause` all recurse through `ChildPredicateEditor`. `WithCurrentCaseType` flips the type-checker's destination scope for `exists`/`missing` inner where-clauses.

**Round-trip preservation discipline.** The editor receives schema-blessed AST shapes the picker cannot edit: higher-order ValueExpressions (`arith` / `if` / `count` / etc.), non-canonical RelationPaths (multi-hop ancestor walks, qualified ancestors, qualified subcases, `any-relation`), and `prop` terms carrying a non-self `via: RelationPath` walk. Every property and value-expression picker routes through one shared primitive — `PropertyRefPicker` — that detects non-canonical shapes (non-Term ValueExpression, Term-non-prop, Term-prop-with-via) and renders them as read-only badges with an explicit "Replace" affordance. Bypassing the primitive is structurally impossible because the eight property-picking sites all consume it. Same shape applies to `RelationPathBuilder` for non-canonical relation walks.

**Operand-preserving kind swap.** The "Change kind" menu detects four structural-twin pairs (`and ↔ or`, `is-null ↔ is-blank`, comparison ↔ comparison, `exists ↔ missing`) and routes operand-preserving swaps through canonical builders. Non-twin transitions (e.g. `eq → between`) fall through to `defaultValue`. The `KindReplaceMenu` disables the current kind so a no-op click can't fire spurious onChange.

**Hard constraints honored:** No textareas, no string editing of predicate text. Field uuid (`nodeId()`) for UI identity, Path for blueprint mutations + `checkPredicate` lookups. Base UI primitives (`@base-ui/react`) with glass styles on Positioner. `@iconify/react/offline` icons. `motion/react` animation. `pragmatic-drag-and-drop` + custom previews. SA tool prompts/schemas untouched.

**Tests (113 in this task's suite):** round-trip preservation per shape (8 picker surfaces + RelationPathBuilder × 4 non-canonical shapes), `selfPath()` canonical case symmetry, `preservedOperandSwap` per twin pair (incl. absent-not-undefined `exists.where` contract), drag-drop reduction-shape preservation, recursive nesting (`exists.where` containing LogicalGroup containing nested exists), per-card smoke, type-mismatch inline error rendering. The editor's eight rounds of fresh-CR review uncovered four progressively-narrower classes of round-trip destruction (right-slot ValueExpression → left-slot ValueExpression → right-slot non-prop terms → property-with-via); each was closed structurally rather than at the offending site, so the bug class is now impossible by construction.

Final state: 3180 tests pass (104 from the test files in this task + the case-store + chat-completion suites carried forward), 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 3: Expression card editor — SHIPPED

SHIPPED 2026-05-06 in commits `4aebe572` (initial feat) → `f487b7b5` (CR fix-pass: preserve literal.data_type in switch rebuild + ref-callback identity + applicability docs) → `d28302f0` (CR fix-pass: qualifiedLiteral builder + JSDoc and comment drift sweep) → `9f7cab9e` (CR fix-pass: align applicability with operand-driven results + extract resolveDestination + drop redundant casts) → `a527ca95` (CR fix-pass: drop unused useEditorErrorsAtOrBelow helper + correct JSDoc consumer reference) → `91bcf09d` (final polish: UnwrapList recovery path + FormatDate validation + JSDoc precision) on branch `feat/case-list-search`.

**What landed:**

The registry-driven ValueExpression card editor at `components/builder/case-list-config/`. 13 cards covering all 15 `ValueExpression` arms (Term, Today, Now, DateAdd, DateCoerce, DatetimeCoerce, Double, Arith, Concat, Coalesce, If, Switch, Count, UnwrapList, FormatDate). Cards type-check via `checkValueExpression` on every change; invalid configurations propagate validity to the parent through `onValidityChange`. Inline errors render at the offending node's path via the same exact-match / strict-descendant lookup helpers Task 2 established.

The editor schema mirrors Task 2's pattern: `expressionEditorSchemas.ts` is `{ readonly [K in ValueExpression["kind"]]: ExpressionCardSchema<K> }` so a new ValueExpression kind without an entry fails to compile. `applicableForX` helpers gate kind-picker / Change-menu applicability per slot's `expectedType`; date-typed kinds (`date-add`, coercion pair) accept BOTH `date` AND `datetime` since their result type follows the operand.

This task also replaces Task 2's Term-only `ValueExpressionPicker` stub with the full `ExpressionPicker` and migrates 4 Predicate-side cards (Comparison, Match, Between, WithinDistance) to consume it. ComparisonCard's right-slot intentionally omits `expectedType` (comparison's ordered-types rules + numeric promotion / select-to-text widenings admit any compatible type); the JSDoc cross-references the parallel cases.

**Cross-family recursion.** `IfCard.cond` and `CountCard.where` route through the same `ChildPredicateEditor` that Task 2's predicate cards already use. `WithCurrentCaseType` flips the type-checker's destination scope for `count.where` so property references inside resolve against the relation walk's destination. The shared `resolveRelationDestination` helper (extracted to `relationDestination.ts`) is consumed by both `ExistsCard` and `CountCard`.

**Drag-and-drop.** Three reorderable surfaces — `concat.parts`, `coalesce.values`, `switch.cases` — share the new `useReorderableExpressionList` hook. Custom drag preview via `setCustomNativeDragPreview`; per-list monitor scoped by `containerKey`; ref-stash during render (matching the canonical `useRowDnd` pattern); adjacency suppression.

**Round-trip preservation.** Every literal-rebuild site routes through `rebuildLiteralPreservingDataType` (and its `parseInputTextToLiteral` peer), which threads through the new `qualifiedLiteral` builder added to `lib/domain/predicate/builders.ts`. The temporal builders (`dateLiteral` / `datetimeLiteral` / `timeLiteral`) are now thin specializations on top. Switch's `when` literal, Term's literal arms, FormatDate's pattern literal, and Task 2's `LiteralValueInput` (TextInput / NumericInput / SelectOptionInput) all preserve `data_type` qualifiers through edits and blur.

**UnwrapList lossless recovery.** Saved `unwrap-list(<inner>)` ASTs surface as a read-only badge with a Replace affordance that swaps to `<inner>` reference-identical. The kind isn't authored from the picker (round-trip-only — CSQL emitter wraps via the AST); the Replace path lets users repair the wrapped expression without losing operands.

**Hard constraints honored:** No textareas, no string editing of expression text. Field uuid (`nodeId()`) for UI identity; path for blueprint mutations + `checkValueExpression` lookups. Base UI primitives (`@base-ui/react`) with glass styles on Positioner. `@iconify/react/offline` icons. `motion/react` animation. `pragmatic-drag-and-drop` + custom previews. SA tool prompts/schemas untouched.

**Tests (114 in this task's suite, +37 net to the suite from Task 2's baseline):** round-trip per kind (15 kinds), type-mismatch inline error rendering (not just `onValidityChange(false)`), drag-drop reduction-shape preservation, cross-family integration (`if.cond` / `count.where` containing Predicate operands that reference properties), `expectedType` gating, `qualifiedLiteral` builder contract (general-purpose primitive, value union consistency, temporal-specialization equivalence), `parseInputTextToLiteral` symmetric empty-input behavior across qualified vs unqualified sources, UnwrapList Replace round-trip preservation. Six rounds of fresh-CR review locked progressively-narrower issue classes (literal.data_type destruction → applicability registry / JSDoc divergence → builder discipline → dead-code hygiene → recovery-path completeness).

Final state: 3294 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


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

Shell that mounts `ColumnEditor` (drag-orderable column list) + `SortKeyEditor` + `CalculatedColumnEditor` (which uses Task 3's expression editor). Renders a live-preview panel showing what the case list looks like with the current configuration (uses Plan 2's `PostgresCaseStore` to query against generated sample data).

Tests: editing a column updates the preview; reordering columns reorders the preview; adding a calculated column shows the computed values.


### Task 7: Filters section composition

**Files:** `components/builder/case-list-config/FiltersSection.tsx`, tests.

Mounts `PredicateCardEditor` for the always-on filter. Live-preview panel re-runs the case-list query through Plan 2's `PostgresCaseStore` showing how many cases pass the filter.

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
- `searchInputModeMatchesPropertyType` — for every `SearchInputDef.mode`: the mode is valid for the targeted property's `data_type`. `fuzzy` / `starts-with` / `phonetic` / `fuzzy-date` are text-only; `range` requires numeric/date/datetime/time; `multi-select-contains` requires `multi_select`. The Plan 2 index-DDL emission depends on this rule passing — an unindexed `range` mode on a text property would be undefined behavior.

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

End-to-end: build a fixture blueprint with case-list-config; run the validator; emit suite XML; compare against golden file; run preview rendering against `PostgresCaseStore` and verify the rendered case list matches expected.


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
