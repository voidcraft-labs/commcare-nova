# Case List Schema Reshape

Status: open
Branch: feat/case-list-search
Origin: 2026-05-07 supervisor audit found CCHQ shape leaks + Nova-internal asymmetries shipped through Plan 3.
Absorbs: Plan 3 Task 15 (legacy v0 → v1 migration, never run in production). The new migration handles v0 → v2 AND v1 → v2 in one pass; the prior `scripts/migrate-case-list-config.ts` script (with its `f3be407d` safety fix-pass) is deleted. No operator-level coordination across two migrations.
Blocks: Plan 4 (search authoring), Plan 5 (running-app search execution).
Reviewer pass 1: 2026-05-07 fresh-eyed opus review applied — path hedges resolved, eight unmapped consumers mapped, Task 1 split, calc-column comparator fallback specified, migration idempotency strengthened, sort tie-break specified at every layer.
Reviewer pass 2: 2026-05-07 fresh-eyed opus review applied — v0 → v2 migration arm added (production data still on v0 shape per Plan 3 Task 15 pending), `resolveColumnSortType` covers both `ANY_TYPE` AND `undefined`, three-way idempotency for corrupt v1 docs, historical event-log `toolName` note, Plan 4 / Plan 5 family-fix tasks correctly described as re-baseline-not-obsolete, scoped per-task build gate named.

## Why

Plan 3 shipped `caseListConfig` with parallel top-level arrays — `columns[]`, `sort: SortKey[]`, `calculatedColumns[]`, `searchInputs[]`, `detailColumns?: Column[]`, `filter?: Predicate`. Six leaks + five Nova-internal smells were identified by audit:

**CCHQ shape leaks (the wire format is the only inheritance; the authoring layer is Nova's):**
1. `sort: SortKey[]` parallel array — modern table apps (Linear / Notion / Airtable) bind sort to columns. The `findSortKey` silent-drop bug at wire emission is the structural symptom.
2. `calculatedColumns: CalculatedColumn[]` parallel array — Notion / Airtable model formula columns as a column kind. The cross-reference (`SortKey.calculated.columnId` → `CalculatedColumn.id`) only exists because of the wrong shape.
3. `detailColumns?: Column[]` parallel array — no SA tool, no UI, no editor authors this slot. Dead schema is conclusive proof of the wrong shape. Modern apps use per-column visibility flags.
4. `searchOnlyColumn` as a column kind — visibility flag wearing a kind costume, AND the case-store does not read search-only declarations to decide what to index (index set is `data_type`-driven). The kind is fully redundant.
5. `searchInputDef.xpath?: Predicate` field name — wire-format vocabulary leaking into authoring.
6. `SortKey.type` user-authored — `applicableSortTypes(dataType)` already encodes the derivation rule. Notion / Airtable / Linear derive the comparator from column type.

**Nova-internal architectural smells:**
7. Display columns lack a stable `uuid` (asymmetric with `Field.uuid` + `Field.id`). Renames and reorders are fragile.
8. `time-since-until` and `late-flag` are near-duplicate kinds — both `(field, header, threshold, unit) + display-text`. Duplicated kinds for one rendering choice.
9. `SearchInputDef.name` is referenced by AST nodes as a string — same pre-split pain Field had. Note: adding `uuid` mirrors the Field shape but does NOT eliminate rename-rewrite cost — predicates referencing the input by `name` still need rewriting on rename. The fix solves UI identity, not AST reference brittleness; the latter is the existing Field shape's accepted cost.
10. `SearchInputDef` has two parallel ways to express the predicate — `(property, mode, via)` vs `xpath`. Mutually-exclusive optional slots is a discriminated-union smell.
11. `CaseListScreen.tsx::heading` renders `firstFormName ?? "Cases"` — the screen heading shows the FIRST FORM's name as the case-list title. Module name is the canonical Linear / Notion / Airtable / CCHQ choice.

## The reshape, end to end

### caseListConfig collapses to three slots

```ts
caseListConfig: {
  columns: Column[];          // display + sort + calc + visibility, all here
  filter?: Predicate;         // unchanged
  searchInputs: SearchInputDef[];  // shape changes (see below)
}
```

### Column gains uuid, sort, visibility, calculated arm; loses search-only

```ts
type Column =
  | { uuid: Uuid; kind: "plain";       field: string; header: string; sort?: ColumnSort; visibleInList?: boolean; visibleInDetail?: boolean }
  | { uuid: Uuid; kind: "date";        field: string; header: string; pattern: string; sort?: ColumnSort; visibleInList?: boolean; visibleInDetail?: boolean }
  | { uuid: Uuid; kind: "phone";       field: string; header: string; sort?: ColumnSort; visibleInList?: boolean; visibleInDetail?: boolean }
  | { uuid: Uuid; kind: "id-mapping";  field: string; header: string; mapping: IdMappingEntry[]; sort?: ColumnSort; visibleInList?: boolean; visibleInDetail?: boolean }
  | { uuid: Uuid; kind: "interval";    field: string; header: string; threshold: number; unit: TimeSinceUnit; display: "always" | "flag"; text: string; sort?: ColumnSort; visibleInList?: boolean; visibleInDetail?: boolean }
  | { uuid: Uuid; kind: "calculated";  header: string; expression: ValueExpression; sort?: ColumnSort; visibleInList?: boolean; visibleInDetail?: boolean };

type ColumnSort = {
  direction: "asc" | "desc";
  priority: number;  // non-negative integer
};
```

Six kinds, closed set. Calculated columns have no `field` (the expression is the source). Every column carries its own uuid (UI identity, drag/drop keys, undo/redo, AST references). Visibility defaults to true on both surfaces; absent slot ≡ visible.

The `interval` kind merges `time-since-until` + `late-flag`. `display: "always"` always shows the relative interval; `display: "flag"` shows `text` only when the threshold is exceeded (otherwise empty cell). Same `(threshold, unit)` mechanics on both.

### Sort priority tie-break is uniform across every layer

Two columns with the same `sort.priority` tie-break to **column display order** (the column appearing earlier in `caseListConfig.columns` wins). This rule binds at THREE layers:

- **Saga** — when the SA fires multiple `updateColumn` ops in sequence, the priority field may transiently collide. The saga preserves the user's explicit priority intent.
- **Preview** — the live-preview's `CaseListScreen` sorts rows using the same tie-break.
- **Wire emission** — `sortKeys.ts` emits `<sort>` blocks in resolved priority order.

Editor maintains uniqueness on save; the tie-break exists for transient (undo/partial-save) and migration states. No layer assumes uniqueness.

### Wire-emission comparator type is derived, not authored

`Column.sort` carries direction + priority only. The comparator type (`plain | date | integer | decimal`) is derived at wire emission from:
- Non-calculated columns: the case property's declared `data_type` via `applicableSortTypes(dataType)[0]`.
- Calculated columns: the result type of the column's `expression` via `lib/domain/predicate/typeChecker.ts::checkExpression`.

**Fallback rule** — `lib/domain/predicate/typeChecker.ts::checkExpression` returns `ResolvedType | undefined`. Three failure shapes route to comparator type `plain` (lexicographic):
1. The checker returns `undefined` (resolution failure — e.g. unresolvable property reference).
2. The checker returns `ANY_TYPE` (e.g. on a `null` literal arm).
3. The checker returns a `ResolvedType` whose mapping to a `SortType` is undefined (defensive — should not occur if the type checker's domain matches `applicableSortTypes`'s, but the fallback covers schema drift).

This rule is implemented in `lib/commcare/suite/case-list/sortKeys.ts::resolveColumnSortType` and tested explicitly with three separate test cases — one per failure shape — to prevent the implementation collapsing them.

The `applicableSortTypes(dataType)` table moves from `lib/domain` into the wire emitter (`lib/commcare/suite/case-list/sortKeys.ts`) since it's wire-emission concern. The `SORT_TYPES` enum stays exported from `lib/domain` for the wire layer to reference.

### SearchInputDef gains uuid, becomes a discriminated union, renames `xpath` → `predicate`

```ts
type SearchInputDef =
  | { uuid: Uuid; name: string; label: string; type: SearchInputType; default?: ValueExpression; kind: "simple"; property: string; via?: RelationPath; mode?: SearchInputMode }
  | { uuid: Uuid; name: string; label: string; type: SearchInputType; default?: ValueExpression; kind: "advanced"; predicate: Predicate };
```

Common fields (`uuid`, `name`, `label`, `type`, `default`) on every arm; per-arm fields gated by `kind`. `property` is REQUIRED in the simple arm (no escape hatch). The slot named `xpath` is renamed to `predicate` and lives only on the advanced arm.

### SA tool surface — atomic ops, uuid in returns

Five wholesale-replace tools collapse and atomic ops take their place:

**Out (deleted):** `setCaseListSort`, `setCalculatedColumns`, `setCaseListColumns`, `setCaseListSearchInputs`.

**In (new — atomic):** `addCaseListColumn`, `updateCaseListColumn`, `removeCaseListColumn`, `reorderCaseListColumns`, `addSearchInput`, `updateSearchInput`, `removeSearchInput`, `reorderSearchInputs`. Each mutation tool returns the affected `uuid`.

**Unchanged:** `setCaseListFilter` — filter is one Predicate; wholesale fits.

Read tools (`getModule`, `searchBlueprint`) project column + search-input uuids in their summaries so the SA can reference uuids without a separate read after edits.

**SA concurrency.** Multi-call edits are race-free per `lib/agent/CLAUDE.md::solutionsArchitect.ts`: "Tool execution is serialized via a promise-chain mutex so parallel `tool_use` blocks see a consistent working `doc`." No additional concurrency control needed at the case-list-config tools.

### Module name is the case-list title

The runtime preview `CaseListScreen.tsx::heading` switches from `firstFormName ?? "Cases"` to `mod?.name ?? "Cases"`. No new schema slot. CCHQ wire emission is unchanged (`<title><locale id="cchq.case"/></title>` stays — that's CCHQ's runtime concern, not Nova's authoring concern).

## File structure

Every file mapped to its owning task. NEW / EDIT / DELETE annotated. UI components include their mount site.

### Task 1 — Schema reshape (foundation)

Schema-only commit. Whole-repo build is intentionally broken at the end of this task — every consumer surface fails TypeScript until its task lands. End-of-task gate: schema files compile, schema tests pass.

- `lib/domain/modules.ts` (EDIT) — `caseListConfigSchema` collapses to three slots. `columnSchema` discriminated union: drop `searchOnlyColumnSchema`; merge `timeSinceUntilColumnSchema` + `lateFlagColumnSchema` → `intervalColumnSchema` with `display: "always" | "flag"`; add `kind: "calculated"` arm; every arm gains `uuid`, `sort?`, `visibleInList?`, `visibleInDetail?`. Drop `sortKeySchema`, `sortKeySourceSchema`, `calculatedColumnSchema`, `applicableSortTypes` (the table moves to the wire emitter in Task 4). Builders updated for every arm. `searchInputDefSchema` becomes a discriminated union (`simple` / `advanced`) with `uuid`; rename `xpath` → `predicate`; common slots in both arms. Drop `searchOnlyColumn` builder.
- `lib/domain/index.ts` (EDIT) — re-export sweep: drop `SortKey`, `SortKeySource`, `applicableSortTypes`, `searchOnlyColumn`, `timeSinceUntilColumn`, `lateFlagColumn`, `CalculatedColumn` (the type, since calc is a column-kind arm now). Add `intervalColumn`, `calculatedColumn` (column-kind builder), `ColumnSort`.
- `lib/domain/__tests__/modules.test.ts` (EDIT) — schema-roundtrip tests for every column arm + every SearchInputDef arm; sort-on-column round-trip; visibility defaults; discriminated SearchInputDef simple↔advanced.

**Tests:** `lib/domain` package compiles; schema tests green.

### Task 2 — Doc-store + case-store consumer updates

Brings doc-store, case-store, and the doc summary hook to compile + behavior-correct against the new schema.

- `lib/db/applyBlueprintChange.ts` — UNCHANGED (verified: this saga diffs `caseTypes` only, not `caseListConfig`). Listed here for completeness.
- `lib/doc/mutations/fields.ts` (EDIT) — the `columnsRewritten` field-rename path currently walks `caseListConfig.columns` AND `caseListConfig.detailColumns`. Drop the `detailColumns` branch (slot gone). The `columns` branch becomes uuid-aware: rewriting a column entry preserves its `uuid`, `sort`, `visibleInList`, `visibleInDetail` slots. Calc-arm columns have no `field` slot to rewrite — branch on `kind: "calculated"` and skip.
- `lib/doc/hooks/useCaseListSummary.ts` (EDIT) — `useCaseListWorkspaceState` projects from new shape: `sortedColumnCount` + `firstSortedColumn` instead of `sortKeyCount` + `firstSortKey`. Status-line builders updated.
- `lib/case-store/store.ts` (EDIT) — drop `import { CalculatedColumn }`; replace with `Extract<Column, { kind: "calculated" }>` or equivalent local type alias. The case-store's own `interface SortKey` is its runtime sort interface (distinct from authoring; UNCHANGED). The `calculated: ReadonlyArray<CalculatedColumn>` parameter becomes `calculated: ReadonlyArray<Extract<Column, { kind: "calculated" }>>` — call sites pass column-arm filtered results.
- `lib/case-store/postgres/store.ts` (EDIT) — same import update; call-site verification.
- `lib/case-store/index.ts` (EDIT) — barrel re-export update.

**Tests:** `lib/doc` and `lib/case-store` package builds + tests green.

### Task 3 — Validator rules

- `lib/commcare/validator/rules/case-list/sortTypeCheck.ts` (DELETE) — sort type derived; no authored type to validate.
- `lib/commcare/validator/rules/case-list/__tests__/sortTypeCheck.test.ts` (DELETE).
- `lib/commcare/validator/rules/case-list/columnReferences.ts` (EDIT) — single columns array; no `detailColumns` slot. Calc-column arm validation (no `field` reference, expression-based property resolution).
- `lib/commcare/validator/rules/case-list/__tests__/columnReferences.test.ts` (EDIT).
- `lib/commcare/validator/rules/case-list/calculatedColumnTypeCheck.ts` (EDIT) — operates on `kind: "calculated"` column arm rather than separate array.
- `lib/commcare/validator/rules/case-list/__tests__/calculatedColumnTypeCheck.test.ts` (EDIT).
- `lib/commcare/validator/rules/case-list/searchInputModeMatchesPropertyType.ts` (EDIT) — discriminates on SearchInputDef `kind: "simple"` vs `kind: "advanced"` (advanced bypasses mode/property checks; predicate AST has its own type checker).
- `lib/commcare/validator/rules/case-list/__tests__/searchInputModeMatchesPropertyType.test.ts` (EDIT).
- `lib/commcare/validator/rules/case-list/shared.ts` (EDIT) — augmented case-types resolver gains a unified column-property-source helper that handles plain/date/etc. + calculated.
- `lib/commcare/validator/rules/case-list/__tests__/integration.test.ts` (EDIT).
- `lib/commcare/validator/rules/case-list/filterTypeCheck.ts` — UNCHANGED (filter is unchanged).
- `lib/commcare/validator/rules/module.ts` (EDIT) — top-level module rule entrypoint: drop the deleted `sortTypeCheck` registration; ensure remaining rules are registered against new shape.

**Tests:** five remaining rules + integration suite green.

### Task 4 — Wire emitters

- `lib/commcare/suite/case-list/sortKeys.ts` (REWRITE) — read sort directives from columns where `column.sort` is set; sort by `priority` ascending (tie-break to column display order); derive comparator type via `resolveColumnSortType(column, caseTypeSchema)` which dispatches:
  - Plain/date/phone/id-mapping/interval columns → `applicableSortTypes(propertyDataType)[0]`.
  - Calculated columns → `mapExpressionResultTypeToSortType(checkExpression(column.expression).resultType)`.
  - `ANY_TYPE` / unresolved → fallback to `plain` (the explicit fallback rule).
- `lib/commcare/suite/case-list/__tests__/sortKeys.test.ts` (EDIT) — column-sort emission, calc-column-sort emission, priority ordering with tie-break, comparator-type derivation per data type, ANY_TYPE fallback case, multi-column priority collisions tie-broken to display order.
- `lib/commcare/suite/case-list/shortDetail.ts` (EDIT) — emit columns where `visibleInList ?? true`. No more `searchOnlyColumn` invisible-template branch.
- `lib/commcare/suite/case-list/__tests__/shortDetail.test.ts` (EDIT).
- `lib/commcare/suite/case-list/longDetail.ts` (EDIT) — emit columns where `visibleInDetail ?? true`. The `config.detailColumns ?? config.columns` fallback gone.
- `lib/commcare/suite/case-list/__tests__/longDetail.test.ts` (EDIT).
- `lib/commcare/suite/case-list/columns.ts` (EDIT) — drop `search-only` arm + the `Invisible` template path. Add `kind: "calculated"` arm (verify exact CCHQ shape during implementation by reading the canonical CCHQ emitter at `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor`). Merge `time-since-until` + `late-flag` arms into one `interval` arm dispatching on `display`. The `DisplayedColumn` exclusion type goes away.
- `lib/commcare/suite/case-list/__tests__/columns.test.ts` (EDIT).
- `lib/commcare/suite/case-list/types.ts` (EDIT) — type updates per shape change.
- `lib/commcare/suite/case-list/nodesetFilter.ts` — UNCHANGED (nodeset filter on entry is filter-only).
- `lib/commcare/expander.ts` (EDIT) — drop the `mod.caseListConfig?.detailColumns` access path.
- `lib/commcare/compiler.ts` (EDIT) — JSDoc cleanup if it references deleted slots; behavior unchanged.
- `lib/commcare/session.ts` — UNCHANGED (touches only `caseListConfig.filter`, which is unchanged). Listed for completeness.

**Tests:** wire-emission test suite green; XML golden-file diffs reviewed.

### Task 5 — SA tool surface (atomic ops + uuid surfacing + helpers + prompt)

- `lib/agent/tools/case-list-config/setCaseListSort.ts` (DELETE) + tests (DELETE).
- `lib/agent/tools/case-list-config/setCalculatedColumns.ts` (DELETE) + tests (DELETE).
- `lib/agent/tools/case-list-config/setCaseListColumns.ts` (DELETE) + tests (DELETE).
- `lib/agent/tools/case-list-config/setCaseListSearchInputs.ts` (DELETE) + tests (DELETE).
- `lib/agent/tools/case-list-config/setCaseListFilter.ts` — UNCHANGED.
- `lib/agent/tools/case-list-config/addCaseListColumn.ts` (NEW) + tests (NEW). Input: `moduleIndex`, column shape (without uuid; tool generates one). Output: success string + the new column's `uuid`. Tagged `module:M:caseList:column:add`.
- `lib/agent/tools/case-list-config/updateCaseListColumn.ts` (NEW) + tests (NEW). Input: `moduleIndex`, `columnUuid`, partial column patch. Output: touched uuid + summary.
- `lib/agent/tools/case-list-config/removeCaseListColumn.ts` (NEW) + tests (NEW). Input: `moduleIndex`, `columnUuid`. Output: removed uuid + count.
- `lib/agent/tools/case-list-config/reorderCaseListColumns.ts` (NEW) + tests (NEW). Input: `moduleIndex`, `columnUuids: Uuid[]` (the new order). Output: confirmation.
- `lib/agent/tools/case-list-config/addSearchInput.ts` (NEW) + tests (NEW). Mirrors `addCaseListColumn` shape.
- `lib/agent/tools/case-list-config/updateSearchInput.ts` (NEW) + tests (NEW).
- `lib/agent/tools/case-list-config/removeSearchInput.ts` (NEW) + tests (NEW).
- `lib/agent/tools/case-list-config/reorderSearchInputs.ts` (NEW) + tests (NEW).
- `lib/agent/tools/case-list-config/shared.ts` (EDIT) — `baseCaseListConfig` simplified (three slots). Uuid generation helper. Common patch-by-uuid + remove-by-uuid + reorder-by-uuid helpers shared across columns and search inputs.
- `lib/agent/tools/case-list-config/__tests__/schema.test.ts` (EDIT if exists, NEW otherwise) — verifies all new tool input schemas pass the Anthropic schema compiler at `scripts/test-schema.ts`.
- `lib/agent/solutionsArchitect.ts` (EDIT) — replace 5-tool registration with 8 atomic-op tools + 1 wholesale (filter).
- `lib/agent/summarizeBlueprint.ts` (EDIT) — surface column + search-input uuids in the SA-facing module summary.
- `lib/agent/blueprintHelpers.ts` (EDIT) — `updateModuleMutations` accepts the new `caseListConfig` shape (type-derived from `Module["caseListConfig"]`, so this is implicit). New helper builders for atomic column / search-input mutations: `addColumnMutation`, `updateColumnMutation`, `removeColumnMutation`, `reorderColumnsMutation`, and the search-input parallels.
- `lib/agent/prompts.ts` (EDIT) — replace the SA system-prompt line referencing old tool names (`setCaseListColumns / setCaseListSort / setCalculatedColumns / setCaseListSearchInputs`) with the new atomic-ops names + a one-line note that columns carry sort/calc/visibility on themselves.
- `lib/agent/tools/getModule.ts` (EDIT) — projection includes column + search-input uuids.
- `lib/agent/tools/updateModule.ts` (EDIT) — JSDoc references to deleted tool names updated to the atomic-op names. No behavioral change (this tool stays name-only).
- `lib/doc/searchBlueprint.ts` (EDIT) — search results surface column / search-input uuids when matching against case-list config; the `...(config?.detailColumns ?? [])` line goes away.
- `lib/mcp/server.ts` (EDIT — verify scope during implementation) — MCP server's tool list registration sweep for the 8 new atomic tools + 4 deleted tools. The shared adapter handles wire-envelope projection.
- `lib/agent/CLAUDE.md` (EDIT) — tool list, atomic-ops semantics, uuid-as-handle pattern documented.

**Historical event-log compatibility.** `lib/log/types.ts` event records persist `toolName: z.string()` (and `tool_use` blocks in chat threads carry the tool name). The four deleted tool names (`setCaseListColumns`, `setCaseListSort`, `setCalculatedColumns`, `setCaseListSearchInputs`) survive as inert string display data in event-log replay surfaces — log viewers render the historical name as text. Verify during implementation that no chat-replay path executes against the live tool registry by name; if a replay path exists, the deleted names need a registered no-op stub (with a deprecation note) to prevent runtime errors. The implementer flags this explicitly in their commit if any replay-by-name path is found.

**Tests:** every new tool has unit tests (happy path + error arms — module not found, column not found, uuid not found). MCP adapter projection tests for representative new tools. `scripts/test-schema.ts` passes for every new tool's input schema.

### Task 6 — UI workspace + ColumnEditor

- `components/builder/case-list-config/SortKeyEditor.tsx` (DELETE) + tests (DELETE).
- `components/builder/case-list-config/CalculatedColumnEditor.tsx` (DELETE) + tests (DELETE).
- `components/builder/case-list-config/ColumnEditor.tsx` (EDIT) — gains: per-column sort affordance (direction toggle + priority indicator + drag-to-reorder priority); per-column visibility toggles (visible-in-list, visible-in-detail); calc arm rendering. Kind picker includes `calculated`; selecting it switches the editor body to expression-card editing.
- `components/builder/case-list-config/columnEditorSchemas.ts` (EDIT) — per-kind schema gains common entries (sort, visibility); calc kind has expression entry; interval kind absorbs former time-since-until + late-flag schemas with a `display` mode picker.
- `components/builder/case-list-config/cards/column/CalculatedColumnCard.tsx` (NEW) — calc arm body. Mounts the `ExpressionCardEditor` for the column's `expression` slot. **Mount site:** `ColumnEditor`'s kind-dispatch.
- `components/builder/case-list-config/cards/column/IntervalCard.tsx` (NEW) — replaces TimeSinceUntilCard + LateFlagCard. Carries `(field, header, threshold, unit, display, text)` with `display` toggle (`"always"` show interval / `"flag"` show text when threshold exceeded). **Mount site:** `ColumnEditor`'s kind-dispatch.
- `components/builder/case-list-config/cards/column/TimeSinceUntilCard.tsx` (DELETE) + tests (DELETE).
- `components/builder/case-list-config/cards/column/LateFlagCard.tsx` (DELETE) + tests (DELETE).
- `components/builder/case-list-config/cards/column/SearchOnlyCard.tsx` (DELETE) — kind gone.
- `components/builder/case-list-config/cards/column/ColumnFieldRow.tsx` (EDIT) — gains visibility toggles + sort affordance row that surfaces on every column kind.
- `components/builder/case-list-config/columnCellRenderer.tsx` (EDIT) — column-cell rendering accepts new column union; calc arm renders evaluated expression value; interval arm dispatches on `display` mode; search-only arm gone.
- `components/builder/case-list-config/DisplaySection.tsx` (EDIT) — sort and calc no longer separate sub-sections; columns are the only list. Simpler structure.
- `components/builder/case-list-config/__tests__/DisplaySection.test.tsx` (EDIT).
- `components/builder/case-list-config/DisplayPreview.tsx` (EDIT) — preview filters by `visibleInList`; interval display dispatch; calc cell rendering.
- `components/builder/case-list-config/__tests__/DisplayPreview.test.tsx` (EDIT).
- `components/builder/case-list-config/FiltersPreview.tsx` (EDIT) — preview row rendering accepts new column union (filter slot itself is unchanged, but the row-rendering code touches column shape).
- `components/builder/case-list-config/__tests__/FiltersPreview.test.tsx` (EDIT).
- `components/builder/case-list-config/SearchInputsSection.tsx` (EDIT) — discriminated UI: `kind: "simple"` row uses property/mode/via inputs; `kind: "advanced"` row uses PredicateCardEditor on the `predicate` slot. Add a "convert to advanced" / "convert to simple" affordance per row.
- `components/builder/case-list-config/__tests__/SearchInputsSection.test.tsx` (EDIT).
- `components/builder/case-list-config/CaseListWorkspace.tsx` (EDIT) — status-line builders updated. `buildDisplayStatus` no longer references `sortKeyCount`; surfaces `sortedColumnCount` instead. Empty-state seeds use new builders. **Mount site (existing):** `PreviewShell` activity boundary for case-list edit mode.
- `components/builder/case-list-config/__tests__/CaseListWorkspace.test.tsx` (EDIT).
- `components/builder/appTree/ModuleCard.tsx` (EDIT) — sidebar's column preview filters by `visibleInList ?? true`; column kind list updated to drop `search-only` and add `calculated` / merged `interval`.
- `components/builder/appTree/__tests__/ModuleCard.test.tsx` (EDIT if exists).

**Tests:** every editor component test green; smoke tests cover all six kinds; round-trip tests cover sort + visibility persistence; sidebar preview filters correctly.

### Task 7 — Preview heading bug + calculated column rendering

- `components/preview/screens/CaseListScreen.tsx` (EDIT) — heading uses `mod?.name ?? "Cases"` (not `firstFormName`). Display columns filtered by `column.visibleInList ?? true` (no more `kind !== "search-only"` exclusion). Calculated columns evaluate the `expression` AST against each row's case data; the result renders in the cell.
- `components/preview/screens/__tests__/CaseListScreen.test.tsx` (EDIT or NEW).
- `lib/preview/engine/caseDataBindingHelpers.ts` (EDIT) — gains `evaluateColumnValue(column, caseRow): string` which dispatches on column kind: plain/date/phone/id-mapping/interval read the property; calculated evaluates the expression. Used by `CaseListScreen` for cell rendering.
- `lib/preview/engine/caseDataBinding.ts` (EDIT) — Server Action that loads case rows; type-level updates for new column shape if the projection touches column types.
- `lib/preview/engine/caseDataBindingTypes.ts` (EDIT) — type updates per the column-shape change.
- `components/preview/PreviewShell.tsx` (EDIT) — Activity boundary mounts `CaseListWorkspace` (edit mode) and `CaseListScreen` (live mode); type-level updates for new column shape if the dispatch touches column types.

**Tests:** preview renders with the new heading + calculated columns + visibility filtering.

### Task 8 — Migration script v2 (v0 → v2 + v1 → v2)

- `scripts/migrate-case-list-config.ts` (DELETE) — old v0 → v1 script. The `f3be407d` safety fix-pass survives in git history; its safety patterns are reproduced in the new script.
- `scripts/__tests__/migrate-case-list-config.test.ts` (DELETE).
- `scripts/migrate-case-list-schema-reshape.ts` (NEW) — reads all app docs in Firestore.

  **Three-way idempotency decision tree.** For each module:
  1. Attempt `caseListConfigSchema.safeParse(mod.caseListConfig)` against the NEW (v2) schema. Success ≡ already migrated → skip.
  2. Detect v0 source by `Array.isArray(mod.caseListColumns) || Array.isArray(mod.caseDetailColumns)` (legacy top-level fields). If v0 → run the v0 → v2 arm.
  3. Attempt v1-schema parse against `mod.caseListConfig` (a snapshot of the v1 `caseListConfigSchema` shape kept inline in the migration script as `legacyV1ConfigSchema` for parse-only use, since the live `caseListConfigSchema` is now v2). Success ≡ v1 source → run the v1 → v2 arm.
  4. Neither — log warning at WARN level, increment `failedCount`, exit non-zero at end-of-run. Distinct from per-`searchInput` corrupt-input warnings (which are a separate counter, since the doc was otherwise migratable).

  **v0 → v2 transformation arm.** Production source state (Plan 3 Task 15 never ran).
  - Read `mod.caseListColumns?: { field, header }[]` and `mod.caseDetailColumns?: { field, header }[]`.
  - Compute the unified column set: every entry in `caseListColumns` gets a v2 column with `kind: "plain"`, fresh `uuid`, `visibleInList: true`. If the same `field` also appears in `caseDetailColumns`, the column gets `visibleInDetail: true`; otherwise `visibleInDetail: false`.
  - Every entry in `caseDetailColumns` whose `field` is NOT in `caseListColumns` gets an additional v2 column with `kind: "plain"`, fresh `uuid`, `visibleInList: false`, `visibleInDetail: true`.
  - **Header collision.** When the same `field` appears in both legacy arrays with DIFFERENT `header` values, the v0 `caseListColumns` header wins (more visible surface). The migration logs an INFO at this collision so the operator knows the legacy detail header was dropped.
  - `caseListConfig.columns` array order: legacy `caseListColumns` order first, then any detail-only columns in legacy `caseDetailColumns` order.
  - `caseListConfig.filter`, `searchInputs[]` start empty.
  - Delete `mod.caseListColumns` and `mod.caseDetailColumns` from the doc.

  **v1 → v2 transformation arm.** Snapshot of the prior plan's per-doc transformation, unchanged in shape:
  - Maps `columns[]` → new shape: every column gets a fresh `uuid`; `searchOnlyColumn` rows convert to `kind: "plain"` + `visibleInList: false`; `time-since-until` and `late-flag` rows convert to `kind: "interval"` with `display: "always"` / `display: "flag"` respectively (the `displayLabel` / `flagDisplayValue` slot maps to `text`).
  - Maps `sort[]` → distributes onto columns: each `SortKey` finds its target column by source (property name or calculated id), sets `column.sort = { direction, priority }` with priority assigned by sort-array order (0, 1, 2, ...). Calculated columns referenced by sort keys become `kind: "calculated"` columns in the new array (carrying their expression).
  - Maps `calculatedColumns[]` → appends as `kind: "calculated"` columns; the prior `id` becomes the column's `uuid`. Sort-key references resolve to the new column uuids.
  - Maps `detailColumns[]` (when present) → distributes `visibleInList: false` flags onto columns NOT in `detailColumns`; adds calc/interval columns from `detailColumns` that aren't in `columns` as `visibleInList: false`.
  - Maps `searchInputs[]`:
    - Inputs with `xpath` set → `kind: "advanced"` with `predicate: <xpath value>`. The `property`, `mode`, `via` slots are DROPPED on the advanced arm (they don't exist on the discriminated arm; preserving them would fail new-schema parse).
    - Inputs without `xpath` → `kind: "simple"` with the existing `(property, mode, via)` slots; `property` is required on the simple arm — a doc with a `xpath`-less input lacking `property` is a corrupt input; the migration logs WARN, increments `corruptInputCount`, and skips that input.
    - Every input gets a fresh `uuid`.
  - Filter preserved verbatim (no shape change).

  **Safety patterns** (inherited from the deleted script): `--dry-run` default; `--app-id` filter; status / `deleted_at` filter; per-app try/catch; per-doc OUTPUT validates against new schema before writing (assertion fails the migration for that doc, doesn't silently emit corruption); verbose progress logging including per-doc source-version tag (`v0` / `v1` / `v2-skipped` / `corrupt`).

- `scripts/__tests__/migrate-case-list-schema-reshape.test.ts` (NEW) — coverage:
  - v0-shape input fixture → v2 output (with header-collision INFO captured in a test log spy).
  - v1-shape input fixture → v2 output.
  - v2-shape input fixture → skipped (idempotency).
  - Corrupt input fixture (neither v0, v1, nor v2 parse) → WARN logged, `failedCount` incremented, non-zero exit.
  - Per-`searchInput` corrupt-input fixture (`xpath`-less, no `property`) → `corruptInputCount` incremented, input skipped, doc still migrated.
  - Dry-run output integrity (no Firestore writes).
  - `--app-id` filter restricts the scan correctly.
- `scripts/inspect-app.ts` (EDIT) — dev tool reads `caseListConfig`; type updates for new shape.
- `scripts/lib/blueprint-stats.ts` (EDIT) — dev tool reads `caseListConfig`; type updates for new shape (column-kind histogram drops `search-only`, adds `calculated` / `interval`).
- `scripts/test-schema.ts` (EDIT) — verifies the new SA tool input schemas pass the Anthropic schema compiler. Smoke test that runs the schema compiler against every new tool's input schema.

**Tests:** migration test suite green. Dry-run executed against the dev Firestore project produces expected diff shape; spot-check three migrated docs round-trip through `caseListConfigSchema.safeParse`.

### Task 9 — Integration test rewrite

- `__tests__/integration/case-list-authoring.test.ts` (EDIT) — rewrite against new shape. Coverage:
  - End-to-end column add/update/remove/reorder via SA tool path; uuids surfaced in returns and reused on subsequent calls.
  - Sort-on-column emission to wire (golden-file).
  - Calculated column emission to wire (golden-file).
  - Calc-column with ANY_TYPE result type → wire emits comparator `plain` (one of the three fallback shapes).
  - Calc-column with `undefined` result type → wire emits comparator `plain` (separate test from the ANY_TYPE arm).
  - Migration v0 → v2 fixture: a module with `caseListColumns` + `caseDetailColumns` parallel arrays migrates to v2 with correct column kinds, visibility flags, and header-collision resolution.
  - Visibility filtering (visibleInList false → not in short detail; visibleInDetail false → not in long detail).
  - Discriminated SearchInputDef round-trip (simple ↔ advanced conversion via the editor + via the SA tool path).
  - **Search-input rename + AST predicate reference rewrite** (smell #9 acknowledgment): renaming a search input by `name` requires the predicate AST in any input's `kind: "advanced"` arm AND the `caseListConfig.filter` to be rewritten if they reference the renamed input. Test that the rename mutation rewrites all references; test that an orphan reference surfaces a validator error.
  - Validator rejection of broken references (column-uuid not found, sort-priority-collision behavior, etc.).
  - Sort-priority collision on two columns at runtime → tie-break to display order at preview AND wire AND saga (three assertions covering each layer).
  - Postgres testcontainer + setupPerTestDatabase (existing shape).

**Tests:** integration suite green against the testcontainer.

### Task 10 — Docs / spec / plan sync

- `docs/superpowers/specs/2026-04-30-case-list-search-design.md` (EDIT) — rewrite the "Three sections" / "Display owns columns, sort, calculated columns" sentence to describe the new shape (one columns array carrying display + sort + calc + visibility). The V1-IN feature list stays accurate (every wire feature is still emitted); the SHAPE description updates.
- `docs/superpowers/plans/2026-05-01-case-list-authoring.md` (EDIT) — append a "RESHAPED 2026-05-07" footer linking to this plan; per-task SHIPPED blocks stay (history); top-of-doc note flags the schema is no longer current.
- `docs/superpowers/plans/2026-05-01-search-authoring.md` (EDIT) — Plan 4's family-fix Task 13 is NOT schema-shaped and is not obsoleted by the reshape; it stays as scoped. Append a top-of-doc note that any task touching `Column` / `SearchInputDef` / sort shape must re-baseline against the v2 `caseListConfig` shape before implementer dispatch. The implementer of this Task 10 reads each Plan 4 task and lists the specific tasks that need re-baselining (likely the SA-tool-touching and search-input-editing tasks; not Task 13).
- `docs/superpowers/plans/2026-05-01-running-app-search-execution.md` (EDIT) — Plan 5's family-fix Task 7 (`PreviewSurface shell`) same situation: not schema-shaped, not obsoleted. Same top-of-doc re-baseline note. Implementer enumerates which Plan 5 tasks need re-baselining (likely the search-execution wire path that consumes `caseListConfig.searchInputs`).
- `lib/commcare/CLAUDE.md` (EDIT) — case-list emission section reflects new shape.
- `components/builder/CLAUDE.md` (EDIT) — case-list-config workspace section reflects new shape.
- `docs/superpowers/plans/2026-05-07-case-list-schema-reshape.md` (THIS DOC) — final SHIPPED blocks per task land here in lockstep with implementation per the per-phase SHIPPED-sync discipline.

**Tests:** none — doc-only task. Drift sweep before commit: `rg ':[0-9]+(-[0-9]+)?' docs/superpowers/2026-05-07*` and the touched CLAUDE.md files find zero line-number citations (per the supervisor's no-line-numbers rule).

## Sequencing

Tasks land strictly in order:

1. **Task 1 (schema)** lands. Whole-repo build BREAKS — every consumer surface fails TypeScript. This is by design; intermediate skip markers are forbidden per the no-skip discipline.
2. **Tasks 2 → 7** each bring ONE consumer surface to green. Build remains partially broken between tasks (only consumers not yet landed). Each task's end state: that surface compiles, that surface's tests pass.
3. **Task 8 (migration)** depends on the whole-repo schema being settled.
4. **Task 9 (integration tests)** depends on every consumer surface being green.
5. **Task 10 (docs)** lands last.

**Per-task gate** (Tasks 1–8): `npm run lint` + `npm test -- <touched-paths>`. Both tolerate broken siblings (Biome is file-scoped; Vitest with swc compiles per-file). The implementer does NOT run `npm run build` or `npm run typecheck` until Task 9 — those run whole-graph TypeScript and will fail on un-migrated consumer surfaces, which is expected and not actionable mid-sequence.

**Whole-repo gate** (Task 9 onwards): `npm run lint && npm run typecheck && npm test && npm run build` all green. Integration tests against the testcontainer (`__tests__/integration/case-list-authoring.test.ts`) pass. By Task 9 every consumer surface has landed; whole-graph TypeScript reflects the consistent v2 shape.

This sequence preserves the no-skip discipline at the cost of intermediate broken whole-graph TypeScript in the feature branch. Acceptable in a feature branch; would not ship to main mid-sequence. The implementer's per-task feedback loop (lint + scoped vitest) is fast and accurate even while whole-graph tsc is failing.

## Plan-sync discipline

After each task's implementer commits + spec review approves + CR rounds approve, the supervisor commits a `docs(plan): sync Task N SHIPPED — <summary>` commit to this file. The SHIPPED block summarizes what landed (files touched, test counts), any deltas from the planned shape with rationale, and the next task's stub.

A fresh-session supervisor reads SHIPPED blocks + the next task stub to resume.

## Acceptance gates

Each task is "done" only when:
- Implementer commit lands + tests green for the task's scope.
- Spec review (sonnet, once) approves.
- Code-quality review (opus, fresh agent per round) approves.
- `npm run build / lint / test` green for the touched packages (whole-repo from Task 9 on).
- No `// TODO Task N:` markers remain that this task owns.
- No `.skip` markers remain that this task owns.

## Final verification (user-runnable)

After all 10 tasks land, the user runs:

```bash
npm run dev
```

Opens `/build/<existing-appId>/<moduleUuid>/cases` in the browser and verifies:

1. **Display section renders** with the column list. Each column row shows: header, kind picker, per-kind config, sort affordance (direction + priority indicator), visibility toggles (visible-in-list, visible-in-detail), drag handle.
2. **Add column** opens the kind picker with six kinds: Plain, Date, Phone, ID Mapping, Interval, Calculated. Selecting Calculated opens the expression-card editor on a fresh column.
3. **Sort affordance** on a column header sets direction + priority. Toggling direction on multiple columns assigns distinct priorities; the live preview's case list re-sorts in response.
4. **Sort priority collision test** — two columns with `sort.priority: 0` set via direct doc-store mutation (e.g. via undo state). Live preview still renders without crash; column appearing earlier in `caseListConfig.columns` is the primary sort.
5. **Visibility toggles** flip `visibleInList` and `visibleInDetail`. Toggling list-off hides the column from the live preview's case list; toggling detail-off hides it from the case-detail panel.
6. **Search section renders** the discriminated SearchInputDef list. Adding a search input defaults to `kind: "simple"`. The "Convert to advanced" affordance switches the row to `kind: "advanced"` with a PredicateCardEditor on the `predicate` slot.
7. **Live preview's case list heading** shows the module's name (not the first form's name). Switching modules updates the heading.
8. **Calculated columns render correctly** in the live preview — each row evaluates the column's expression against the row's case data.
9. **Compile + upload to CCHQ HQ succeeds** for an app with the new column shape, sort, calc, visibility, and discriminated search inputs. The uploaded app's case list, case detail, sort, and search behave as authored.
10. **Migration script** dry-run against the dev Firestore project produces a non-empty diff for at least one prior-shape app and zero diff (skipped) for any apps already in the new shape.

The full SA chat path is exercised by:

- User opens chat: "Add a calculated column showing days since last visit."
- SA calls `addCaseListColumn` with the calc arm + expression. Returns the new column's uuid.
- User: "Sort by it ascending."
- SA calls `updateCaseListColumn` with the returned uuid + `sort: { direction: "asc", priority: 0 }`. The live preview re-sorts.

## Open questions resolved

1. **Sort priority shape** — Notion-style `Column.sort?: { direction, priority }`. (User decision.)
2. **SA tool surface** — atomic ops; uuids surfaced in mutation tool returns + in read-tool projections. (User decision.)
3. **Case-list title slot** — none. Module name is the title; preview heading bug fixed in Task 7. Verified against CCHQ source `id_strings.py::_case_detail_title_locale` and against the existing Nova preview which currently shows `firstFormName` incorrectly.

## What this plan does NOT change

- Predicate / ValueExpression AST families and their card-based editors.
- The seven `SearchInputMode` arms.
- `filter?: Predicate` single optional slot — single Predicate with `match-all` / `match-none` sentinels stays the canonical filter shape.
- Bundling every case-list concern onto one `caseListConfig` slot on Module.
- Three-section workspace layout (Display / Filter / Search) with sticky violet-railed headers and single-scroll magazine.
- `Column.field: string` flat property name (relation walks belong inside calc-column expressions).
- `SearchInputDef.via?: RelationPath` for relation walks on simple inputs.
- The doc store's `updateModule(uuid, { caseListConfig })` surface (atomic column ops decompose to the same coarse mutation under the hood).
- Saga pattern, WeakMap-keyed validity shadow, declarative editor-schema pattern.
- Spec V1-IN coverage list. The shape changes; the feature set stays.
- `lib/db/applyBlueprintChange.ts` (verified: diffs `caseTypes` only).
- `lib/commcare/session.ts` (touches only `caseListConfig.filter`, which is unchanged).
- `lib/commcare/suite/case-list/nodesetFilter.ts` (filter-only emission).

## SHIPPED

### Task 1 — Schema reshape (foundation) — 2026-05-07

Landed across four commits: `608625c3` (initial reshape) → `48582c0f` (CR round 1 fix-pass — search-input builder factoring + JSDoc voice + display rename `"interval" | "flag"` → `"always" | "flag"`) → `b32b7056` (CR round 2 fix-pass — drop product citation + drop migration forward-ref + generalize strip-test names) → `7f210d26` (CR round 3 fix-pass — `.merge()` → `.extend()` package-canonical composition + drop `WritableColumnCommonSlots` alias for cross-helper symmetry + trim test header voice).

**Final shape:**
- `caseListConfig` collapsed to three slots: `columns`, `filter?`, `searchInputs`.
- `Column` discriminated union over six kinds — `plain`, `date`, `phone`, `id-mapping`, `interval` (merged from `time-since-until` + `late-flag` with `display: "always" | "flag"` discriminator + `text` slot), `calculated` (no `field`; expression is the source).
- Every column carries `uuid: Uuid`, optional `sort?: { direction, priority }`, optional `visibleInList?` / `visibleInDetail?`.
- `SearchInputDef` discriminated union: `kind: "simple"` (requires `property`; optional `via`, `mode`) vs `kind: "advanced"` (requires `predicate`). Common slots `uuid`, `name`, `label`, `type`, `default?` on both arms. The legacy `xpath` slot rejects on parse.
- `SORT_TYPES` enum stays exported (wire-emitter binding); the `applicableSortTypes` table relocates to the wire emitter in Task 4.
- `sortKeySchema`, `SortKey`, `SortKeySource`, `propertySortSource`, `calculatedSortSource`, `sortKey`, top-level `CalculatedColumn` type, `searchOnlyColumn`, `timeSinceUntilColumn`, `lateFlagColumn`, `sortConfigSchema` / `SortConfig`, `applicableSortTypes` — all deleted from `lib/domain/modules.ts` and the `lib/domain/index.ts` barrel.

**Builder factoring:** `withCommonSlots` (column common slots), `withSearchInputCommonSlots` (search-input common slot — `default`), `withSimpleSearchInputSlots` (simple-arm-only `via` + `mode`, with the `via.kind === "self"` carve-out). All three helpers OMIT optional slots when undefined; the `builders omit absent optional slots` test pins the contract.

**Test count:** 48 schema-roundtrip tests in `modules.test.ts`. Whole-package: 556 / 556 green.

**Acceptance gate landed:**
- `npm run lint` green.
- `npm test -- lib/domain` green (deterministic two runs).
- `rg ':[0-9]+(-[0-9]+)?' lib/domain/modules.ts lib/domain/__tests__/modules.test.ts lib/domain/index.ts` zero hits.

**Deltas from the planned shape:** none.

**Whole-repo build state:** intentionally broken on consumer surfaces (validator, wire emitters, SA tools, UI, preview, doc-store, case-store, scripts) per the planned sequencing. Tasks 2-9 bring each surface to green.

**Next:** Reshape Task 2 — Doc-store + case-store consumer updates.
