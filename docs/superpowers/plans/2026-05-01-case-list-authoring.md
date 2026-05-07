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

**Drag-and-drop.** Three reorderable surfaces — `concat.parts`, `coalesce.values`, `switch.cases` — share the new `useReorderableList` hook. Custom drag preview via `setCustomNativeDragPreview`; per-list monitor scoped by `containerKey`; ref-stash during render (matching the canonical `useRowDnd` pattern); adjacency suppression.

**Round-trip preservation.** Every literal-rebuild site routes through `rebuildLiteralPreservingDataType` (and its `parseInputTextToLiteral` peer), which threads through the new `qualifiedLiteral` builder added to `lib/domain/predicate/builders.ts`. The temporal builders (`dateLiteral` / `datetimeLiteral` / `timeLiteral`) are now thin specializations on top. Switch's `when` literal, Term's literal arms, FormatDate's pattern literal, and Task 2's `LiteralValueInput` (TextInput / NumericInput / SelectOptionInput) all preserve `data_type` qualifiers through edits and blur.

**UnwrapList lossless recovery.** Saved `unwrap-list(<inner>)` ASTs surface as a read-only badge with a Replace affordance that swaps to `<inner>` reference-identical. The kind isn't authored from the picker (round-trip-only — CSQL emitter wraps via the AST); the Replace path lets users repair the wrapped expression without losing operands.

**Hard constraints honored:** No textareas, no string editing of expression text. Field uuid (`nodeId()`) for UI identity; path for blueprint mutations + `checkValueExpression` lookups. Base UI primitives (`@base-ui/react`) with glass styles on Positioner. `@iconify/react/offline` icons. `motion/react` animation. `pragmatic-drag-and-drop` + custom previews. SA tool prompts/schemas untouched.

**Tests (114 in this task's suite, +37 net to the suite from Task 2's baseline):** round-trip per kind (15 kinds), type-mismatch inline error rendering (not just `onValidityChange(false)`), drag-drop reduction-shape preservation, cross-family integration (`if.cond` / `count.where` containing Predicate operands that reference properties), `expectedType` gating, `qualifiedLiteral` builder contract (general-purpose primitive, value union consistency, temporal-specialization equivalence), `parseInputTextToLiteral` symmetric empty-input behavior across qualified vs unqualified sources, UnwrapList Replace round-trip preservation. Six rounds of fresh-CR review locked progressively-narrower issue classes (literal.data_type destruction → applicability registry / JSDoc divergence → builder discipline → dead-code hygiene → recovery-path completeness).

Final state: 3294 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 4: Column editor (per-format-kind) — SHIPPED

SHIPPED 2026-05-06 in commits `44cf0c13` (initial feat) → `941d4bf4` (CR fix-pass: extract shared CustomDatePatternInput + BlurCommitTextInput + tighten dateColumnSchema) → `bd482b8e` (CR fix-pass: id-mapping label proportional + builder discipline + dedup property-type sets) → `0bc326dc` (CR fix-pass: finish per-card dedup + lift propertyTypeSets to lib/domain + aria-live unconditional + builder parity) → `55e6dd50` (final polish: effectiveDataType sweep) on branch `feat/case-list-search`.

**What landed:**

The registry-driven Column editor at `components/builder/case-list-config/`. Seven cards covering all `ColumnKind` arms (`plain`, `date`, `time-since-until`, `phone`, `id-mapping`, `late-flag`, `search-only`). Per-kind UI: Plain (field + header), Date (field + header + preset/custom pattern), Time Since/Until (field date-typed + header + threshold + unit + display label), Phone (field text-typed + header), Id Mapping (field + header + drag-orderable mapping table), Late Flag (field date-typed + header + threshold + unit + flag display value), Search Only (field + header for the authoring label; wire layer skips emission).

Cards type-check via `applicableForProperty` predicates against the case-type schema; invalid combinations (Late Flag on text, Phone on date, etc.) surface inline errors and propagate validity through `onValidityChange`. The kind-replace menu disables / de-emphasizes inapplicable kinds. Operand-preserving swap: `field` + `header` carry across every kind transition; `(threshold, unit)` carries across the `time-since-until ↔ late-flag` twin; non-twin transitions fall through to `defaultValue`.

The editor schema mirrors Tasks 2 / 3's pattern: `columnEditorSchemas.ts` is `Record<ColumnKind, ColumnCardSchema<K>>` so a new `ColumnKind` without an entry fails to compile. Mounts `PredicateEditProvider` (reuses Task 2/3's context) so `PropertyPicker` reads `currentCaseType` from one place; the column editor supplies an empty validity index since applicability errors flow through the `errors` prop.

**Column construction discipline.** Every Column AST mutation routes through builders (`plainColumn` / `dateColumn` / `timeSinceUntilColumn` / `phoneColumn` / `idMappingColumn` / `lateFlagColumn` / `searchOnlyColumn`) added to `lib/domain/modules.ts`. The builders are the single construction surface for Column AST nodes — every mutation in the editor, the SA tools (`addModule` / `createModule` / `updateModule`), the migration script, and test helpers route through them. SA tool input shapes stay legacy (`{field, header}[]`) per `feedback_never_touch_agent.md`; the internal mapping uses `plainColumn(...)`. `idMappingEntry(value, label)` builder added for parity at the inner level.

**Shared primitives.** `CustomDatePatternInput` consolidates the preset toggle + free-text custom input + empty-pattern signal (aria-invalid + visible inline error + refused commit) used by both `FormatDateCard` (Task 3) and `DateColumnCard` (Task 4). `BlurCommitTextInput` consolidates the draft/commit text-input pattern across `ColumnFieldRow`, `TimeSinceUntilCard`, `LateFlagCard`, and `IdMappingCard`. `IntervalThresholdRow` shared between `TimeSinceUntilCard` and `LateFlagCard`. The `monospace` prop on `BlurCommitTextInput` correctly applied: monospace on the wire-code value cell, proportional on the display-label cell.

**Domain consolidation.** `lib/domain/casePropertyTypes.ts` consolidates `DATE_DATA_TYPES` / `TEXT_SHAPED_DATA_TYPES` / `NUMERIC_DATA_TYPES` / `ORDERED_DATA_TYPES` plus the `isDateTyped` / `isTextShaped` / `isOrdered` / `effectiveDataType` helpers. Re-exported through `@/lib/domain`. Replaces 11 sites of duplicate Sets / inline `data_type ?? "text"` fallbacks across the case-list-config tree. Adding a `CasePropertyDataType` variant now cascades through every consumer via the helpers — the bug class "future variant added but only updated in N of M places" is structurally impossible.

**`TIME_SINCE_UNITS` exported** from `lib/domain/modules.ts` so `IntervalThresholdRow` iterates the canonical array directly. The previous local `UNITS: readonly TimeSinceUnit[]` would silently drop new variants — now structurally protected.

**Schema tightening.** `dateColumnSchema.pattern: z.string().min(1)` — symmetric with `formatDateSchema.pattern`. Empty patterns rejected at parse time, with the inline UX gate from `CustomDatePatternInput` as the user-facing surface.

**Accessibility.** `aria-live="polite"` + `aria-atomic="true"` on `CardShell`'s footer error region and `InlineError`. Wrappers render unconditionally with `sr-only` collapse when empty (WCAG canonical pattern — live regions must be monitored before content arrives).

**Hard constraints honored:** No textareas. Field uuid (`nodeId()`) for UI identity, path for blueprint mutations. Base UI primitives with glass on Positioner. `@iconify/react/offline` icons. `motion/react` animation. SA tool prompts/schemas untouched.

**Tests (66 in this task's suite):** round-trip per kind via the schema, type-mismatch inline error rendering, applicability errors per kind (Late Flag / Date / Time-Since / Phone), kind-replace twin-pair preservation (`time-since-until ↔ late-flag` carries `threshold + unit`), non-twin transitions fall through to default, per-card edit emission shapes (Date preset click, Date custom blur-commit, Time-Since display label + threshold, Late Flag flag value + threshold, Phone header), id-mapping table mutations (add / move-up / move-down / remove / disabled boundaries / blur-commit on value+label). Four rounds of fresh-CR review uncovered progressively-narrower issue classes (empty-pattern signal asymmetry → builder discipline gap → consolidation incompleteness → architectural placement → display-label literals).

Final state: 3362 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 5: Sort key editor — SHIPPED

SHIPPED 2026-05-06 in commits `1d1423bd` (initial feat) → `f78e7f11` (CR fix-pass: drop dead PredicateEditProvider mount + nodeId row keys + JSDoc precision) → `9ce3e781` (CR fix-pass: unify SortKey validity with display.missing detection via shared resolveSource helper) → `30696254` (final polish: direct discriminator + drop dead fallback + gate empty-section headers + reorder property lookup + test name precision) on branch `feat/case-list-search`.

**What landed:**

The multi-key drag-orderable Sort Key editor at `components/builder/case-list-config/SortKeyEditor.tsx`. Each row has a source (property OR calculated column), a type (Plain / Date / Integer / Decimal), and a direction (asc / desc). The Source picker is a single Base UI Menu with section headers that combine properties + calculated columns under one trigger; the discriminator is visible per item via icon (database vs math-function). Direction toggle, type picker, drag handle, and remove button complete each row. "Add sort key" affordance below the list.

**Source resolution is unified.** A single `resolveSource(...)` helper returns `{ state: "resolved" | "empty" | "missing", displayLabel, kindLabel, dataType, monospaceLabel }` and is consumed by BOTH `errorsPerRow` (validity propagation) AND every `<SourcePicker resolved={...} />` (trigger chrome + aria-label). Two consumers, one computation, no drift possible. Four unresolvable states (empty property, stale property name, empty columnId, stale columnId) flip `valid: false` and surface inline errors symmetric with the visual chrome. Closes the "display says broken but validity says fine" asymmetry that violates `feedback_always_in_valid_state.md`.

**Type-checking matrix.** `applicableSortTypes(propertyDataType)`: text/single_select/multi_select/geopoint → `["plain"]`; int → `["integer", "plain"]`; decimal → `["decimal", "plain"]`; date/datetime/time → `["date", "plain"]`. Calculated sources admit all four (no resolvable type at the source layer). Inapplicable types stay clickable with reduced opacity; the inline error makes the rejection visible.

**Hook generalization.** `useReorderableExpressionList` → `useReorderableList`. The closed `containerKind` discriminator widened to free-form `string` so any list-shaped editor can share the reorder primitives. Per-instance `nodeKey` (via `useId()`) is the strict cross-list scope; `containerKind` is a coarse belt-and-suspenders gate. The four consumers (`ConcatCard`, `CoalesceCard`, `SwitchCard`, `SortKeyEditor`) each pin their own `containerKind` token — `concat` / `coalesce` / `switch` / `sort-keys`. Drag preview portal correct.

**Builders.** `propertySortSource(property)`, `calculatedSortSource(columnId)`, `sortKey(source, type, direction)`, `applicableSortTypes(propertyDataType)` added to `lib/domain/modules.ts`. Every editor mutation routes through them.

**aria-label disambiguation.** `Sort source: Property "<name>"` / `Sort source: Calculated column "<name>"` with `" (missing)"` suffix when unresolvable. The trigger icon follows `value.kind` regardless of resolution; only the icon's color flips to error red when missing.

**Hard constraints honored:** No textareas. `nodeId(key)` for stable React keys (WeakMap-backed; survives reorders + duplicate-source rows). Base UI Menu with `Menu.Trigger`. `@iconify/react/offline` icons. `motion/react` animation (none needed at this surface). `'use client'` at top. SA tool prompts/schemas untouched.

**Tests (28 in this task's suite):** round-trip per source kind, type-mismatch inline error rendering, all four unresolvable cases (empty property, stale property, empty columnId, stale columnId) propagate `valid: false` AND surface inline errors, calculated source `columnId` preservation across direction toggle / type pick / source change, drag-handle wiring (one grip per row, zero on empty list), add/remove, direction toggle, type picker, empty list, **duplicate-source rows** (two keys on same property with different `(type, direction)` survive remove-by-index correctly), aria-label disambiguation. Three rounds of fresh-CR review uncovered progressively-narrower issue classes (dead PredicateEditProvider mount with lying docs → validity/display asymmetry → polish drift).

Final state: 3390 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 6: Display section composition — SHIPPED

SHIPPED 2026-05-07 in commits `6e1ca2dd` (initial feat) → `3f858f03` (CR fix-pass: prefix calculated aliases against reserved-column collisions + Zod-parse Server Action + JSDoc + sort round-trip) → `810265b1` (CR fix-pass: innerValidityVersion deps + dead error vocabulary) → `ca8c4857` (CR fix-pass: alias byte cap + invalid-config tests + builder discipline + blueprint Zod) → `325579fe` (CR fix-pass: invalid-blueprint coverage + sort-by-calculated contract test + dead-if idiom alignment) → `34bebc9a` (final polish: auth ordering + SortKey alias + fieldParent mock shape) on branch `feat/case-list-search`.

**What landed:**

The Display section composition at `components/builder/case-list-config/`. `DisplaySection.tsx` is the shell that mounts `ColumnList` (drag-orderable column editor wrapper), `SortKeyEditor` (Task 5), `CalculatedColumnEditor` (new, drag-orderable calculated-column rows with the Task 3 ExpressionCardEditor), and `DisplayPreview` (live preview panel). Validity from each sub-editor aggregates to the parent via a single `onValidityChange` propagation; the `innerValidityVersion` deps + ref-shadow pattern survives external-prop-driven flips (e.g., a `caseTypes` change makes a calculated-column expression's property reference stale).

**`CalculatedColumnEditor`** — drag-orderable list of `CalculatedColumn` rows, each with id (validated for non-empty + uniqueness across siblings), header, expression slot (mounts `ExpressionCardEditor`), and optional sort config. Routes mutations through the new `calculatedColumn(...)` builder added to `lib/domain/modules.ts`. Single `resolveRows` helper produces per-row state consumed by both inline-error chrome AND validity aggregation — no display/validity asymmetry.

**`DisplayPreview`** — live-preview table rendering the case list per the current config. Calls a new `loadCaseListPreviewAction` Server Action that resolves session via `getSession()`, constructs `withOwnerContext(session.user.id)`, Zod-parses both `caseListConfig` and `blueprint` at the entry, and routes through the new `caseStore.queryWithCalculated(...)` method. Discriminated-union return shape covers `paused | rows | empty | unauthenticated | error | invalid-config | invalid-blueprint`. The renderer dispatches on every arm; both error arms have action-level + renderer-level test coverage.

**`CaseStore.queryWithCalculated`** — sibling to `query`, returns `CaseRowWithCalculated[]` (`{ ...CaseRow, calculated: { [columnId]: CalculatedValue } }`). `CalculatedValue` is `JsonValue | Date` (pg-driver-honest; `date`/`timestamptz` columns deserialize to Date objects natively). Calculated columns project as SELECT aliases prefixed `__nova_calc__<id>` so collisions with reserved `cases` columns (`case_name`, `case_id`, `case_type`, `owner_id`, `status`, `app_id`, `opened_on`, `closed_on`, `modified_on`, `parent_case_id`, `properties`) are structurally impossible. The 63-byte Postgres identifier cap is enforced at the SQL boundary via `Buffer.byteLength(alias, "utf8") > 63` mirroring the `indexName` defense — a `compilerBugMessage` throw rejects over-cap aliases before the SELECT lands. Empty-id is rejected with the same shape. Sort by calculated column re-evaluates the expression in ORDER BY; Postgres CSE-folds against the identical SELECT projection.

**Round-trip preservation discipline.** `CalculatedColumn.sort` slot survives header / id / expression edits (pinned by test). The `sortKeyToExpression` helper at `caseDataBindingHelpers.ts` lifts a `calculated` source to the calculated column's expression verbatim via `term(prop(...))` builders — no hand-rolled AST literals.

**Hard constraints honored:** No textareas. Field uuid (`nodeId()`) for stable React keys. Drag-and-drop via `useReorderableList` with unique `containerKind` per surface (`case-list-columns` / `calculated-columns`). Base UI primitives, glass on Positioner. `@iconify/react/offline` icons. `motion/react` animation. `'use client'` at top of interactive components. `autoComplete="off"` + `data-1p-ignore` on every input. SA tool prompts/schemas untouched.

**Tests (94 in this task's surface):** 11 reserved-column-collision contract tests sweeping every reserved `cases` column, empty-id rejection test, 60-byte over-cap rejection test, sort-by-calculated round-trip test (insert two patients with distinct ages, project `age + 1` as calculated, sort ascending by the same expression, assert row order + calculated values), `invalid-config` + `invalid-blueprint` arm tests at action-level AND renderer-level, `innerValidityVersion` regression tests for both `CalculatedColumnEditor` and `ColumnList` (external-prop-driven validity flips), per-row id uniqueness inline error rendering, calculated column sort round-trip, drag-handle wiring across both reorderable surfaces, edits update preview / reorders update preview / calculated columns surface computed values (the spec's three explicit test obligations). Five rounds of fresh-CR review uncovered progressively-narrower issue classes (CRITICAL alias collision data corruption → calculated alias byte-overflow → invalid-blueprint coverage gap → auth ordering asymmetry).

Final state: 3456 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 7: Filters section composition — SHIPPED

SHIPPED 2026-05-07 in commits `5f7e348d` (initial feat) → `bfedb910` (collapse rows/empty arms; spec-aligned count copy) → `80922828` (CR polish: symmetric clear-filter slot test + drop fragile eager reset) on branch `feat/case-list-search`.

**What landed:**

`FiltersSection.tsx` mounts `PredicateCardEditor` (Task 2) for the always-on filter. The section header carries a "Clear filter" affordance when present and an "Add filter" affordance when absent — adding a filter initializes via the `matchAll()` builder (lets the user swap to any concrete operator via the kind-replace menu without seeing a false-error state). Validity propagates via the slot-presence short-circuit `!filterPresent || predicateValid`, so a cleared filter is always valid regardless of the inner editor's stale verdict.

`FiltersPreview.tsx` renders a count card ("N cases pass this filter" / "All N cases (no filter applied)") plus a small row sample (top ~10 rows by default) using the shared `columnCellRenderer.tsx` extracted in this task. The column-cell rendering is now consolidated across `DisplayPreview` and `FiltersPreview`; both surfaces share `renderColumnCell` + `renderCalculatedCell` plus best-effort formatters for `date` / `phone` / `time-since-until` / `late-flag` / `id-mapping` / `search-only`.

**`CaseStore.count`** — new sibling to `query` / `queryWithCalculated` (`lib/case-store/store.ts` + `postgres/store.ts`). Same argument shape `(appId, caseType, blueprint?, predicate?)`, structurally tenant-scoped via the same outer-scan filter, predicate compiles via the existing `compilePredicate` stack. Returns `number` via `eb.fn.countAll<string>()` cast (the `bigint`-as-string serialization Postgres emits, parsed at the boundary). Four contract tests pin the contract: predicate-undefined returns total, predicate-narrowed returns subset, tenant scoping rejects cross-app rows, blueprint snapshot required for typed property reads.

**`loadFilterPreviewAction`** — Server Action mirroring `loadCaseListPreviewAction`'s shape. Resolves session FIRST (matching the file's pattern), then Zod-parses both `caseListConfig` and `blueprint` at entry, then queries via `caseStore.queryWithCalculated(...)` (truncated row sample) + `caseStore.count(...)` (full count). Discriminated arms: `rows` (with `totalCount: number`, possibly empty `rows` array) / `unauthenticated` / `error` / `invalid-config` / `invalid-blueprint`. The `rows` arm carries the row sample AND the `totalCount` so the count-and-sample stay internally consistent across renders.

**Round-trip preservation discipline.** Add-filter and clear-filter transitions preserve every other `CaseListConfig` slot verbatim (columns, sort, calculatedColumns, searchInputs); pinned by symmetric tests on both transition directions. AST mutations route through `matchAll()` (and other Predicate builders). No hand-rolled AST literals in production code.

**Hard constraints honored:** No textareas. Field uuid (`nodeId()`) for stable React keys. Base UI primitives, glass on Positioner. `@iconify/react/offline` icons. `motion/react` animation. `'use client'` at top. SA tool prompts/schemas untouched.

**Tests (32 in this task's surface):** filter add / clear / edit round-trip, validity aggregation (defined-invalid → undefined → valid transitions), filter editing updates count + visible rows (per spec), clearing filter shows all cases (per spec), `invalid-config` + `invalid-blueprint` arm tests at action-level + renderer-level, CaseStore `count` contract tests (4), session-first ordering test, symmetric slot preservation across add/clear transitions. One round of fresh-CR review uncovered the asymmetric-coverage + fragile-eager-reset items closed in the polish commit.

Final state: 3488 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 8: Search Inputs section composition — SHIPPED

SHIPPED 2026-05-07 in commits `c5c0543c` (initial feat) → `17977de1` (CR fix-pass: tighten effectiveDataType return type, drop as-never casts) → `bda38f9f` (CR fix-pass: PropertyRefPicker via fix + WeakMap shadow + extract useInnerValidityShadow + useValidityPropagator) → `897f06eb` (final polish: finish useValidityPropagator migration + adopt applicableSearchModes accessor) on branch `feat/case-list-search`.

**What landed:**

`SearchInputsSection.tsx` is a drag-orderable list of `SearchInputDef` rows. Each row carries name, label, type picker (text / select / date / date-range / barcode), optional property reference (`PropertyRefPicker` mode=property-only), optional relation walk (`RelationPathBuilder`), optional mode (filtered by type + property data type via the centralized applicability tables), optional default-value (`ExpressionCardEditor` from Task 3), and optional advanced XPath (`PredicateCardEditor` from Task 2). When the advanced XPath is present, property + mode pickers hide behind an amber "Advanced override active" banner — bypassing the type-coupling check since the user has taken authoring control of the predicate shape.

**Hard validation, not soft warning.** The spec called for "type-coupling warnings" but per `feedback_always_in_valid_state.md` (apps must always be in a valid state), incompatible (type, property, mode) tuples flip `valid: false` rather than rendering as soft advisories. Date input on text property → invalid. Fuzzy mode on int property → invalid. Range mode on multi_select property → invalid. The host's save affordance gates on the aggregated validity, so unexportable configurations cannot persist.

**Centralized applicability tables.** `lib/domain/modules.ts` adds `APPLICABLE_SEARCH_MODES` (per-type → applicable modes), `SEARCH_MODE_PROPERTY_TYPES` (per-mode → applicable property data types), `SEARCH_INPUT_TYPE_PROPERTY_TYPES` (per-type → applicable property data types), and the `applicableSearchModes(type)` accessor (single indirection point all consumers go through). Adding a new search mode or input type cascades through every consumer via the tables; the bug class "added a mode but only updated 2 of 3 consumers" is structurally impossible.

**`searchInputDef(...)` builder.** Added with optional-slot omission semantics — `via: selfPath()` collapses to absent (mirrors `calculatedColumn`'s `sort` handling) for round-trip equality. Per-mode helpers (`exactMode`, `fuzzyMode`, `phoneticMode`, `startsWithMode`, `fuzzyDateMode`, `rangeMode`, `multiSelectContainsMode(quantifier)`) exposed for downstream consumers (Task 9 SA tools, Task 10 validator rules).

**Type-system tightening.** `effectiveDataType` (`lib/domain/casePropertyTypes.ts`) and `applicableSortTypes` (`lib/domain/modules.ts`) tightened from `string` returns to `CasePropertyDataType`. Drops `as never` casts in editor consumers; closes the closed-enum-vs-string asymmetry across all 15+ callers.

**Shared validity-aggregation primitives.** Two new hooks at `components/builder/case-list-config/`:
- `useInnerValidityShadow` — WeakMap-keyed `ValidityShadow<RowObject>` consumed by SearchInputsSection, CalculatedColumnEditor, and DisplaySection's ColumnList. WeakMap auto-GCs when rows are removed; reorder-then-flip preserves the per-row verdict. Replaces three index-keyed shadow arrays that all carried the same reorder-desync bug class. Three regression tests pin the contract (one per editor): mount [invalid, valid, valid] → reorder to [valid, invalid_at_new_index, valid] → flip invalid to valid → assert `onValidityChange(true)` fires.
- `useValidityPropagator` — standardized `(isValid, onValidityChange) → useEffect([isValid]) {...}` pattern with ref-stashed callback. Consumed by every editor with a `onValidityChange` prop (5 sites total): SearchInputsSection, CalculatedColumnEditor, DisplaySection, SortKeyEditor, ColumnList.

**Round-trip preservation across all optional slots.** `property` / `via` / `mode` / `default` / `xpath` survive every per-slot edit. The CRITICAL `PropertyRefPicker` regression (badging out when `via` is non-self, blocking property edits across the canonical "add property → set ancestor walk → edit property" flow) closed structurally: the row passes a self-shaped `prop()` to the property-only picker, with the `RelationPathBuilder` next to it owning `via`. Two regression tests pin the visual stability + via preservation across property edits.

**Hard constraints honored:** No textareas. Field uuid (`nodeId()`) for stable React keys. Drag-and-drop via `useReorderableList` with `containerKind: "search-inputs"`. Base UI Menu primitives, glass on Positioner. `@iconify/react/offline` icons. `motion/react` animation. `'use client'` at top. SA tool prompts/schemas untouched.

**Tests (44 in this task's surface):** round-trip per input field, type-coupling hard validation per spec (Date input on text property → `valid: false`), optional slots present + absent round-trip, drag-drop reorder, add/remove, type→mode gating (changing type filters available modes), per-row name uniqueness inline error, xpath-override hides property + mode pickers + restores on remove, default-value type-mismatch surfaces inline, xpath type-mismatch surfaces inline, reorder-then-flip regression (the IMPORTANT 2 fix). Three rounds of fresh-CR review uncovered progressively-narrower issue classes (`as never` cast hiding type-discipline gap → CRITICAL property picker block + IMPORTANT shadow desync → MINOR partial-migration drift on the new helper extraction).

Final state: 3529 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 8.5: Case List Workspace

**Origin.** Plan 3's File Structure listed `CaseListConfigPanel.tsx` ("the three-section UI shell") as a deliverable, but no Task in the original plan actually built the shell or named its mount site. Tasks 6/7/8 each shipped one inner section (DisplaySection, FiltersSection, SearchInputsSection) — the shell itself was assumed to "fall out of Tasks 6/7/8" via the ROADMAP narrative ("Tasks 6, 7, 8 compose the three sections of the case-list config panel"), but nothing in those Task descriptions named the shell as a deliverable. The user discovered this when asking "When can I run dev?" — at that point Plans 1-2 + Plan 3 Tasks 1-9 had shipped without the case-list authoring UI being reachable in the running app. This task closes that gap. The supervisor failure is documented in `~/.claude/.../memory/feedback_plan_coverage_audit_before_dispatch.md`; the audit family discovered three sibling plans with the same gap class (Plan 3 here, Plan 4 `CaseSearchConfigPanel`, Plan 5 `PreviewSurface`).

**Files:**
- `components/builder/case-list-config/CaseListWorkspace.tsx` (NEW) — single-scroll three-section workspace shell.
- `components/builder/case-list-config/CaseListSectionHeader.tsx` (NEW) — sticky section header with live status density + violet rail.
- `components/builder/case-list-config/__tests__/CaseListWorkspace.test.tsx` (NEW).
- `components/preview/PreviewShell.tsx` (EDIT) — branch `loc.kind === "cases"` on edit mode: edit → `CaseListWorkspace`, live → existing `CaseListScreen` (Plan 5 will replace the live arm).
- `components/preview/screens/ModuleScreen.tsx` (EDIT) — add "Case List" affordance card for case-typed modules navigating via `navigate.openCaseList(moduleUuid)`.
- `components/builder/detail/ModuleDetail.tsx` (DELETE) — confirmed dead code, zero consumers.

**Mount site (named explicitly per the audit gate).** `CaseListWorkspace` renders inside `PreviewShell` at the existing `/build/[id]/{moduleUuid}/cases` URL. The URL schema is already in `lib/routing/types.ts:34` and parsed at `lib/routing/location.ts:189` producing `{ kind: "cases", moduleUuid }`. `useNavigate.openCaseList(moduleUuid)` already exists for navigation. The existing dispatch in `PreviewShell.tsx:82-86` returns `{ type: "caseList", ... }` for the legacy `PreviewScreen` adapter; this task adds an edit-mode short-circuit BEFORE the adapter call: `if (useEditMode() === "edit" && loc.kind === "cases") return <CaseListWorkspace moduleUuid={loc.moduleUuid} />`. Live mode (`useEditMode() === "live"` or whatever the current "preview" sentinel is) keeps the legacy adapter path so today's `CaseListScreen` continues rendering — Plan 5 Task 2 replaces that arm with the builder-context running-app rendering.

**User-runnable acceptance.** User runs `npm run dev`, opens an existing case-typed app at `/build/{appId}`, clicks a module from the structure sidebar → `ModuleScreen` renders showing a "Case List" card before the form list. User clicks the card → lands at `/build/{appId}/{moduleUuid}/cases` showing the three-section authoring workspace (Display / Filter / Search) with sticky violet section headers and live status density. User edits a column header via the Display section, sees the change persist after page reload. User toggles edit/live mode in the existing builder toolbar — edit mode shows authoring, live mode shows the existing `CaseListScreen` running-app preview (Plan 5 will replace the live arm with builder-context running-app rendering against `CaseStore`).

**Layout — single-scroll magazine, three sections stacked.**

Section order: Display → Filter → Search. Mirrors the authoring narrative: define what shows, narrow what shows, let the user filter further. No tabs, no accordion, no mode pickers — all three sections are always visible and scannable. The user scrolls between them; the sticky violet section headers double as scroll anchors and orientation marks.

**Section header (sticky, pins to viewport top when scrolled past):**
- Section title in display-typography distinct from body (implementer chooses the display-style with the `frontend-design` skill loaded; the project's existing dark Violet Monochrome theme + `app/layout.tsx` font setup constrain the choice — pick something that pairs without competing).
- Status-density line beneath the title, bound LIVE to the doc store via shallow selectors:
  - Display: "{N} columns · sorted by {sortSummary}" (e.g., "5 columns · sorted by date_visit ↓"). Empty state: "No columns yet — add columns to define what users see in the case list."
  - Filter: "{N} condition(s) · {matchCount} of {totalCount} cases match" when filter present (live filter-preview match counts already shipped in Task 7's `FiltersPreview`); empty state: "No filter — all cases shown."
  - Search: "{N} input(s){`,${withDefaultValueCount} with default values` if any}" when inputs present; empty state: "No search inputs — list-only view (no inline search bar)."
- 3px violet rail beneath the header text: `h-[3px] bg-nova-violet shadow-[0_0_8px_rgba(139,92,246,0.4)]`. Soft enough that a stack of three pinned headers (when all sections are scrolled into the sticky zone simultaneously, e.g., near the bottom of the workspace) doesn't visually compete; sharp enough that the active-pinned rail reads distinct from the section's rest state.
- Sticky implementation: `position: sticky; top: 0; z-index: var(--z-floating)` with backdrop-blur on the wrapper (`bg-[rgba(12,12,32,0.7)] backdrop-blur-md`). The blur samples scrolling editor content beneath the header for depth. The implementer must verify the blur composes correctly across all three pinned headers in the stacked-pinning state (use the project's `data-preview-scroll-container` for the scroll context).

**Section body:**
- Each section renders its existing component from Tasks 6/7/8 unchanged: `<DisplaySection moduleUuid={moduleUuid} />`, `<FiltersSection moduleUuid={moduleUuid} />`, `<SearchInputsSection moduleUuid={moduleUuid} />`. Internal layouts (DisplaySection has its own editor + DisplayPreview side-by-side; FiltersSection same with FiltersPreview; SearchInputsSection has just the editor — no preview today) survive intact.
- Section vertical rhythm: 96px top padding + 64px bottom padding around the body. Sections separated by full-width violet hairline (`border-t border-nova-violet/[0.15]`). The hairline visually anchors the transition between sections and reads as the seam between the previous section's content and the next section's sticky header.

**ModuleScreen "Case List" affordance:**
- Renders BEFORE the form list in `ModuleScreen.tsx`, only when `mod.caseType` is non-empty.
- Visual: violet-gradient rounded card distinct from the gray-toned form rows. `bg-gradient-to-r from-nova-violet/[0.08] to-transparent border border-nova-violet/[0.2] hover:border-nova-violet/[0.4] hover:from-nova-violet/[0.12]` with rounded-lg. Left adornment: violet pill (`p-2 rounded-md bg-nova-violet/[0.15] border border-nova-violet/[0.3]`) holding a `tablerListDetails` icon in `text-nova-violet-bright`.
- Title: "Case List" (display-style, parity with section header titles).
- Status line beneath title: "{N} columns · {filterPresent ? '1 filter' : 'no filter'} · {N} search inputs" (live-bound via shallow selectors against `mod.caseListConfig`).
- Optional caseType badge to the right: small monospace pill showing the case type name.
- Click → `navigate.openCaseList(moduleUuid)` (existing intent in `lib/routing/hooks.tsx`).

**PreviewShell dispatch changes:**
- The existing `PreviewShell.tsx` adapter at line 67-89 translates `Location` → legacy `PreviewScreen` for the interact-mode preview pipeline. The case-list edit-mode workspace is NOT a preview-pipeline screen — it's a builder authoring surface, so it bypasses the adapter.
- Insertion point: in `PreviewShell.tsx`'s component body (NOT the `locationToScreen` helper), add a guard BEFORE the existing screen-dispatch logic:
  ```tsx
  const editMode = useEditMode();
  const loc = useLocation();
  if (editMode === "edit" && loc.kind === "cases") {
    return <CaseListWorkspace moduleUuid={loc.moduleUuid} />;
  }
  // ... existing dispatch
  ```
- Live mode (the existing default for `loc.kind === "cases"`) is unchanged and continues rendering `CaseListScreen` via the legacy adapter. Plan 5 Task 2 replaces this arm with builder-context running-app rendering.
- Activity wrapping: `CaseListWorkspace` should be wrapped in an `<Activity>` for screen retention parity with the rest of `PreviewShell`'s screens (so navigating away and back doesn't unmount the workspace + lose section scroll position). Confirm pattern by reading the existing `PreviewShell.tsx` Activity setup.

**Aesthetic execution (this is where the boldness lives — the layout itself is intentionally classical magazine; the EXECUTION is what makes it not feel generic):**
- **Typography hierarchy.** Section title at ~28-36px in a display style; status-density line beneath at ~13px in muted body; section bodies at the existing 13-14px body. Implementer picks the display style with `frontend-design` skill loaded, considering the project's existing `app/layout.tsx` font setup.
- **Violet rail glow.** Per-section header rail at 3px height with the soft glow shadow above. The implementer must visually verify that three rails pinned simultaneously (long-scroll edge case) compose without visual noise — adjust glow opacity if needed.
- **Sticky-blur depth.** Pinned section headers use backdrop-blur to sample the scrolling content beneath, creating depth between the pinned chrome and the rolling body. Verify in browser that the blur is non-trivial (not "near-transparent overlay") and that text contrast on the pinned header remains readable against any underlying content.
- **Status-line precision.** Every count, sort indicator, validity dot, presence flag rendered in the status line is bound directly to the doc store via shallow selectors. No debouncing, no derived caching, no `useMemo` on simple counts — read-once-per-render so updates feel synchronous when the user adds/removes a column or toggles sort.
- **Spatial composition.** Section header reads as a MARKER, not a WRAPPER — the rail beneath it is the only visual border, no surrounding box. Section bodies have no outer container chrome; the existing inner layouts from Tasks 6/7/8 ARE the chrome. The hairline between sections is the only visual seam.
- **Empty states per section.** When `caseListConfig.{columns | filter | searchInputs}` is empty for a section, render a violet-tinted glass card with section-specific guidance + a single CTA (e.g., Display empty: "Add columns to define what users see in the case list" + "Add column" button). Use the project's existing glass primitive on the positioner (per `lib/ui/CLAUDE.md` if it exists, or `feedback_baseui_backdrop_filter.md` — glass on positioner, not on popup).
- **ModuleScreen "Case List" card distinctiveness.** The card uses violet-gradient + violet pill icon while form rows use gray surface. Visually it should read as "this is a different kind of affordance" — the user should immediately understand "this is config for the case list, not a form to open."

**Hard constraints honored:**
- No textareas anywhere in this surface. (Existing case-list-config rule.)
- `motion/react` for animations. NO scroll-triggered animations on subsequent visits (Activity preserves state — re-running entry animations on remount per `feedback_stateful_ui_truth.md` is forbidden).
- `@iconify/react/offline` icons.
- `@base-ui/react` primitives where applicable (glass on positioner per `feedback_baseui_backdrop_filter.md`).
- `'use client'` at the top of CaseListWorkspace.tsx.
- React 19 ref-callback cleanup for any DOM listeners (sticky-pinning detection if needed beyond CSS sticky).
- BlurCommitTextInput / EditableText for any inline text editing introduced.
- frontend-design skill MUST be loaded by the implementer for visual decisions (typography pick, glow tuning, hairline color).
- No `loadApp` / `getSession` / RSC patterns inside the client component — workspace is a pure client surface.
- Doc store reads via the named shallow selector hooks (`useBlueprintDocShallow` etc. — not raw `useBlueprintDoc(state => state.modules[uuid].caseListConfig.columns.length)` per `feedback_no_codebase_convention_excuses.md` for boundary-rule discipline).

**Tests:**
- Workspace renders all three sections in correct order (Display → Filter → Search).
- Each sticky section header pins at the correct scroll position; verify via JSDOM scroll mocks or DOM-position assertions.
- Status density renders correctly per section: column count, filter presence + match counts, input count + with-default-values count.
- Empty-state per section renders when the corresponding `caseListConfig` slice is empty.
- ModuleScreen "Case List" card renders only for case-typed modules; absent for non-case modules.
- ModuleScreen "Case List" card navigates to `/cases` URL via `navigate.openCaseList(moduleUuid)` (assert the URL change OR the navigate spy).
- PreviewShell dispatches: edit mode + `kind === "cases"` → `CaseListWorkspace`; live mode + `kind === "cases"` → existing `CaseListScreen`.
- Edit mode toggle does NOT unmount the workspace + lose section scroll position (Activity preserves; pin via repeat mode-toggle test).
- Round-trip: mount workspace → edit a column header in the Display section → unmount → remount → header preserved (doc store persistence pin).
- Dead-code deletion verified: `rg ModuleDetail` returns no production-code matches; the file is gone.
- One-shot integration smoke test: render `<PreviewShell />` with a fixture blueprint having a case-typed module; navigate to `/cases`; assert the workspace renders the three sections; click "Configure" affordance from Module screen; assert URL change.

**Acceptance gates beyond user-runnable:**
- `npx tsc --noEmit` clean.
- `npm run lint` clean.
- `npm test` green.
- No imports of deleted `components/builder/detail/ModuleDetail.tsx` survive (grep proves it).


### Task 9: SA tools — SHIPPED

SHIPPED 2026-05-07 in commits `27d7b58a` (initial feat) → `a072a922` (CR fix-pass: tighten schema discriminated-union check + close test coverage gaps + correct filter description) → `219e9ce1` (final polish: symmetric chat+MCP parity tests + pin setCaseListFilter init-on-absent-clear behavior) on branch `feat/case-list-search`.

**What landed:**

Five SA tools at `lib/agent/tools/case-list-config/`, one per case-list-config surface:
- `setCaseListColumns` — replaces `caseListConfig.columns` with typed `Column[]` (all 7 column kinds via the discriminated union).
- `setCaseListFilter` — sets/clears `caseListConfig.filter` via `Predicate | null`. Description steers the SA toward `null` for clearing (the canonical clear shape) over a `match-all` filter (a non-empty filter expressing "match every case" as a value).
- `setCaseListSort` — replaces `caseListConfig.sort` with typed `SortKey[]`.
- `setCalculatedColumns` — replaces `caseListConfig.calculatedColumns` with typed `CalculatedColumn[]`.
- `setCaseListSearchInputs` — replaces `caseListConfig.searchInputs` with typed `SearchInputDef[]`.

Each tool's input schema accepts the typed AST shape via Zod (no strings). All schemas pulled from `lib/domain/predicate` and `lib/domain/modules` — never inlined. The implementer empirically verified that tool-input mode accepts `oneOf` + `$ref` natively (vs structured-output mode which rejects them); `scripts/test-schema.ts` was extended to cover both compiler paths.

**Tools wired into both surfaces:** chat-side `sharedTools` registry at `lib/agent/solutionsArchitect.ts` and MCP `SHARED_TOOLS` manifest at `lib/mcp/server.ts` (with snake_case wire names per MCP convention). Cross-surface parity tests pin that all five tools emit identical mutation batches through both contexts.

**Schema exports.** `lib/domain/modules.ts` flipped `calculatedColumnSchema`, `sortKeySchema`, `searchInputDefSchema` from package-private to exported so the SA-tool layer can consume them.

**Persistence path.** Tool execute() bodies route through the existing `updateModuleMutations` → `ctx.recordMutations` pattern. Mutations land via `applyBlueprintChange` (Plan 3 Task 1's saga) on the MCP path; chat path stays fire-and-forget per the SSE timing model. The tool layer is ctx-shape-agnostic; the saga distinction lives at the context level.

**Init shape.** When `caseListConfig` is undefined on the module before the mutation, each tool initializes via `emptyCaseListConfig()` (every required slot present-and-empty; `filter`/`detailColumns` absent). Pinned by per-tool init tests in all five test files.

**Existing tool surfaces untouched in this commit** per `feedback_never_touch_agent.md`. The dual-tool overlap with `updateModule.case_list_columns` (legacy lossy-flatten vs typed AST preservation) was closed in follow-up commit `e836d97a` (with explicit user authorization to bypass the no-SA-edits gate): `updateModule`'s `case_list_columns` and `case_detail_columns` fields are removed entirely, the `addModule` SA tool is deleted (its column-only behavior left no useful surface once the columns leave), `createModule` no longer accepts `case_list_columns`, and `getModule` returns the structured `CaseListConfig | null` symmetric with the write tools. The typed `setCaseListColumns` / `setCalculatedColumns` / etc. are now the single SA-facing surface for `caseListConfig` mutations end-to-end. Build sequence is now `generateSchema` → `generateScaffold` → `setCaseListColumns` per case-carrying module → `addFields` → `validateApp`.

**Schema-compiler ceiling.** Per-array-item optional counts verified concretely: `setCaseListColumns` 0/0/0/0/0/0/0 across all 7 column-kind arms; `setCaseListSort` 0; `setCalculatedColumns` 1; `setCaseListSearchInputs` 5. All comfortably under the 8-optional ceiling. The schema test's per-arm walker reads `oneOf ?? anyOf ?? [items]` (correctly handles Zod 4's `discriminatedUnion` lowering to `oneOf`), resolves one `$ref` hop, and asserts `armsChecked > 0` to prevent silent vacuous-pass regressions.

**Hard constraints honored:** AST schemas from `lib/domain/predicate` + `lib/domain/modules` (never inlined). Typed builders for AST construction. `applyBlueprintChange` for persistence (MCP path). No process/forward-projection comments. No `void <id>;` suppressions.

**Tests (52 in this task's surface):** schema parse via `scripts/test-schema.ts opus` (live API verification covering all 5 tools), per-tool integration tests asserting effect on the doc, idempotency tests, round-trip tests, module-not-found error tests, `caseListConfig` initialization tests for every tool, cross-surface chat+MCP parity tests for every tool, `setCaseListFilter` `Predicate | null` semantics with the materialize-on-absent-clear edge case pinned. Two rounds of fresh-CR review uncovered a schema-test silent-skip bug (tool-input mode emits `oneOf` not `anyOf`), an init-coverage gap, a misleading wire-format detail in the filter description, and partial-coverage drift on the parity tests.

Final state: 3585 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean.


### Task 10: Validator rules — SHIPPED

SHIPPED 2026-05-07 in commits `7e546da5` (initial feat) → `b35b41e2` (CR fix-pass: per-rule property resolution + STANDARD_CASE_LIST_PROPERTY_DATA_TYPES + new search-input-unknown-property error code) → `255ca346` (CR fix-pass: 3-arm admission unification via shared resolver) → `b4fb3acc` (CR fix-pass: single canonical resolver + WeakMap memoization + augmentation regression coverage) on branch `feat/case-list-search`.

**What landed:**

Six validator rules at `lib/commcare/validator/rules/case-list/` (the spec said "Five" but listed six — the implementation has all six):
- `columnReferences` — every `Column.field` resolves via the canonical 3-arm admission set.
- `filterTypeCheck` — `caseListConfig.filter` type-checks via the predicate AST type checker (`@/lib/domain/predicate`).
- `sortTypeCheck` — every `SortKey` source resolves; the declared sort type is compatible with the source's data type.
- `calculatedColumnTypeCheck` — every CalculatedColumn's expression type-checks; the resulting type is appropriate for the column's display kind.
- `fieldKindMatchesPropertyType` — for every form field with `case_property_on` set: the field's kind matches the property's declared `data_type`. Multiple writers must agree. App-scope rule wired in `APP_RULES`.
- `searchInputModeMatchesPropertyType` — for every `SearchInputDef.mode`: the mode is valid for the targeted property's `data_type`. The runtime correctness gate — an unindexed `range` mode on a text property would be undefined behavior at the index-DDL emission layer (Plan 2 case data layer).

**Single canonical 3-arm property resolver.** All six rules consult a unified admission set: declared (case type's `properties[]`) → CommCare standard (table-driven via `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES` at `lib/commcare/constants.ts`) → writer-derived (fields saving via `case_property_on`, defaulting to `text`). The priority order lives once in `augmentCaseType`'s append order at `lib/commcare/validator/rules/case-list/shared.ts`. `resolvePropertyDataType` and `propertyExists` are thin wrappers over `lookupInAugmented` reading the augmented list. `STANDARD_CASE_LIST_PROPERTIES` is derived from `Object.keys(STANDARD_CASE_LIST_PROPERTY_DATA_TYPES)` — single source of truth.

**Augmentation makes the predicate AST type checker tool-aware.** `moduleTypeContext` synthesizes writer-derived + standard properties into each `CaseType.properties[]` before threading the augmented `caseTypes` to the predicate type checker (`@/lib/domain/predicate`'s `checkPredicate` / `checkValueExpression`). The type checker itself is unmodified — it sees writer-derived + standard properties as if declared. `filterTypeCheck` and `calculatedColumnTypeCheck` delegate to the checker and pick up the augmented behavior transparently. The `lib/domain/predicate/` source is untouched in this commit chain.

**WeakMap-memoized validation context.** `validationContextFor(doc)` is a module-scope `WeakMap<BlueprintDoc, ValidationContext>` cache. The augmented case-types list is computed once per doc reference and reused across every rule invocation in a validation pass. Doc reference is the cache key — Immer's mutation-replaces-reference behavior makes stale entries unreachable (GC'd). For an app with N modules + C case types, augmentation runs once per pass instead of `3N × C` times. Per-rule `writerPropCache` shims removed in favor of the unified memoization.

**Standard property data-type table.** `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES` at `lib/commcare/constants.ts` maps each member of `STANDARD_CASE_LIST_PROPERTIES` to its implicit data type (e.g., `case_name → text`, `date_opened → datetime`). `STANDARD_CASE_LIST_PROPERTIES: ReadonlySet<StandardCaseListProperty>` is derived from `Object.keys(...)`. Type system enforces total coverage — all defensive `?? "text"` fallbacks and `if (dataType === undefined) continue;` arms removed.

**New error code.** `CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY` emitted when a search-input's referenced property exists nowhere in the 3-arm admission set. Closes the silent-skip + lying "predicate-side rules cover this" gap that an earlier round flagged. The runtime correctness gate the rule's JSDoc describes is now structurally enforced.

**Hard constraints honored:**
- No `void <id>;` suppressions, `@ts-ignore`, `biome-ignore`, `eslint-disable`.
- No process / forward-projection comments. Drift sweep clean.
- Strong typing throughout; no `as never` / `as any` / `as unknown` casts in this commit chain.
- CommCare boundary discipline: all imports stay within `@/lib/commcare` or domain types. No external-from-CommCare imports.
- Predicate type checker source unmodified.

**Tests (50 in this surface):**
- Per-rule: positive + negative + edge case (absent slots short-circuit).
- Cross-rule integration: a multi-writer property with conflicting kinds surfaces one error per writer.
- 7 augmentation regression tests (the load-bearing claim that `filterTypeCheck` and `calculatedColumnTypeCheck` see writer-derived + standard properties through the predicate type checker): writer-derived-only / standard-only / type-mismatch-on-standard for both checkers, plus arith-on-standard-text and declared-only-admission for `columnReferences`. Mental-delete verification confirmed (15 tests fail when `buildAugmentedCaseTypes` short-circuits to raw `caseTypes`; restoring restores the suite).
- All seven `SearchInputMode` arms pinned with both pass + reject cases (`exact`, `fuzzy`, `phonetic`, `starts-with`, `fuzzy-date`, `range`, `multi-select-contains`).

Final state: 3668 tests pass, 14 skipped, 0 failed; `npx tsc --noEmit` clean; `npm run lint` clean. Three rounds of fresh-CR review uncovered progressively-narrower issue classes (false unified-contract claim → priority-order divergence between two rules → augmentation regression coverage gap + dual-implementation drift). Round 4 CR APPROVED with two non-blocking MINORs (TypeContext.caseTypes mutability tightening — out of scope, touches `lib/domain/predicate/`; JSDoc clarification on cache reach). Note: spec review was skipped on this task; the four CR rounds covered spec-relevant behavior in their checklists, but the `feedback_always_run_reviews.md` discipline was not formally honored on this task.


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
