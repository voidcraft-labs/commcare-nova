# Running-App Search Execution Implementation Plan (Plan 5 of 5)

> **For agentic workers:** Implement this plan task-by-task with subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Plan 5 of 5. Depends on Plans 1, 2, 3 (case-list authoring shipped end-to-end at v2 shape per the 2026-05-07 reshape), Plan 4 (case-search authoring — `caseSearchConfig.{excludedOwnerIds, searchScreen*, emptyListText, search*ButtonLabel, searchButtonDisplayCondition}`, `searchInputs` on `caseListConfig`, dual-detail emission, `<remote-request>` orchestrator + sub-emitters, `compileForPlatform` decision tree, six-rule validator family, `setCaseSearchDisplay` / `setCaseSearchAdvanced` SA tools, `CaseSearchConfigPanel` mounted in edit mode, `CaseSearchConfigInteractEmptyState` mounted in pointer mode). After Plan 5 ships, the flipbook's running-app surface (cursor-mode `pointer` → `useEditMode() === "test"`) executes search-input filtering end-to-end against the Postgres `cases` rows; forms write through the case-store so the user can walk through registration → list → followup workflows on the same rows the editor inspects.

**Goal:** Wire Plans 1-4 into the running-app `CaseListScreen` rendering. The running-app case list reads through `loadCasesAction` with runtime-bound search-input values composed from the user's per-input typed text; the existing inline filter bar lands at the top of the list when `caseListConfig.searchInputs.length > 0`. Forms submitted in test mode dispatch through `submitFormAction` so the next case-list render reflects the write. A "Reset sample data" affordance pairs with the existing "Generate sample data" button so authors can iterate on schema + filter changes against fresh data.

**Architecture summary:** Running-app rendering is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule — one `CaseListScreen`, no separate split-screen surface. The cross-bound `caseListConfig.searchInputs` carry the runtime-filterable inputs (Plan 3's reshape); whether the module also carries `caseSearchConfig` doesn't change the preview's rendering shape — `caseSearchConfig` configures search-screen labels + claim-flow emission (CCHQ-runtime concerns the wire layer handles) and the rare `excludedOwnerIds` filter (CCHQ-runtime; Nova's preview ignores it because preview rows are tenant-scoped already and there is no concept of "another user's row" inside one author's preview). There is no separate preview lifecycle — the running-app surface operates on the same `cases` rows the editor inspects, and form submissions write to the same Cloud SQL Postgres rows that case-list editing reads.

**Already shipped (foundation Plan 5 extends):**
- `lib/preview/engine/caseDataBindingHelpers.ts` (server-only) — `readCases` / `readFilterPreview` / `seedSampleCases` / `apply{Registration,Followup,Close,Survey}Mutation` over `CaseStore.query(...)`. `readCases` already accepts `(caseTypeSchemas, caseListConfig)` and threads `caseListConfig.filter` into the predicate.
- `lib/preview/engine/caseDataBindingClient.ts` (client-safe) — pure projections + typed-error mappers + `pickBlueprintDoc`.
- `lib/preview/engine/caseDataBinding.ts` (Server Actions) — `loadCasesAction`, `loadCaseDataAction`, `populateSampleCasesAction`, `loadFilterPreviewAction`, `submitFormAction`. The submit action dispatches every `SubmissionMutation` arm; the filter-preview action supports the authoring inspector while running list values come from `loadCasesAction`.
- `lib/preview/hooks/useCaseDataBinding.ts` — `useCases`, `useCaseData`, `usePopulateSampleCases`. The `useCases` hook owns the reload-key trigger that re-fires after sample-data writes.
- `components/preview/screens/CaseListScreen.tsx` — running-app case-list rendering (module-name heading, visibility-filtered columns, calc cell rendering via `evaluateColumnValue`, sort directives via `buildCaseStoreSortKeys`, inline "Generate sample data" button on the empty arm).
- `components/preview/screens/FormScreen.tsx` — running-app form rendering (forms render against case data via `useCaseData`; `controller.computeSubmissionMutation` exists on the engine controller; `validateAll` exists). The submit button currently navigates only — the case-store write call is the gap Plan 5 closes.
- `components/preview/PreviewShell.tsx` — Activity-boundary dispatcher routing `(screen.type, useEditMode())` pairs: edit `caseList` → `CaseListWorkspace`; non-edit `caseList` → `CaseListScreen`; edit `searchConfig` → `CaseSearchConfigPanel`; non-edit `searchConfig` → `CaseSearchConfigInteractEmptyState`; `module` → `ModuleScreen`; `form` → `FormScreen`; `home` → `HomeScreen`.
- `lib/case-store/store.ts::CaseStore.resetSampleData` — atomic delete + regenerate, transactional. The case-store seam exists; the Server Action wrapper does not.

Plan 5 EXTENDS this foundation; it does not rewrite it. The running-app shell, the doc-store + session-store wiring, the form engine, the case-store I/O, and the case-search authoring surfaces are all in place. The work below adds the runtime-bindings layer (per-input value → predicate composition), the inline `SearchInputForm` widget mounted at the top of `CaseListScreen` when `searchInputs.length > 0`, the `submitFormAction` call from `FormScreen.handleSubmit`, and the `resetSampleCasesAction` Server Action wrapper + paired button.

**Tech Stack:** Plans 1-4 + the existing preview engine + `motion/react` for entry animations.

---

## Vocabulary lock

The plan references the following project vocabulary verbatim. Mismatches surfaced during the 2026-05-10 sync against Plan 4's landed reality.

- **Cursor mode** — `cursorMode: "edit" | "pointer"` in the session store. The running-app surface activates when `cursorMode === "pointer"`. The hook `useEditMode()` derives `"test"` from `"pointer"` and `"edit"` from `"edit"`; consumer code branches on `useEditMode() === "test"` to mean "running-app preview is live".
- **Screen shape** — `PreviewScreen` is a `{ type: "home" | "module" | "caseList" | "searchConfig" | "form", ... }` discriminated union (key is `type`, not `kind`). The case-list arm is `type: "caseList"`, not `type: "cases"`.
- **`caseSearchConfig` slots** — `excludedOwnerIds`, `searchScreenTitle`, `searchScreenSubtitle`, `emptyListText`, `searchButtonLabel`, `searchAgainButtonLabel`, `searchButtonDisplayCondition`. There is no `claim` cluster, no `claimCondition`, no `dontClaimAlreadyOwned`. Claim-flow `<post>` emission is structural (always emits the default guard); CCHQ's runtime fires it automatically.
- **`SearchInputDef` arms** — `kind: "simple"` (carries `property` + optional `mode` + optional `via`) and `kind: "advanced"` (carries `predicate`). Both arms carry an optional `default: ValueExpression` slot. Plan 5 defers honoring the `default` slot to a follow-up surface (see "Deferred to follow-up specs" below).
- **`compileForPlatform`** — produces a three-flag `WireShape` (`autoLaunch` / `defaultSearch` / `inlineSearch`). The function is wire-emission concern; Plan 5's preview is platform-agnostic and does NOT branch on this output.

---

## File Structure

```
lib/preview/engine/
├── runtimeBindings.ts                                       # NEW — per-input values → predicate
├── caseDataBinding.ts                                       # EDIT — add resetSampleCasesAction
├── caseDataBindingHelpers.ts                                # EDIT — readCases accepts inputValues; new resetSampleCases helper
└── __tests__/
    └── runtimeBindings.test.ts                              # NEW

lib/preview/hooks/
└── useCaseDataBinding.ts                                    # EDIT — add useResetSampleCases

components/preview/
├── shared/                                                  # NEW directory
│   ├── SearchInputForm.tsx                                  # NEW — collects search-input values; per-arm widget
│   └── __tests__/
│       └── SearchInputForm.test.tsx                         # NEW
└── screens/
    ├── CaseListScreen.tsx                                   # EDIT — mount SearchInputForm; render Reset button
    ├── FormScreen.tsx                                       # EDIT — wire handleSubmit through submitFormAction
    └── __tests__/
        ├── CaseListScreen.test.tsx                          # EDIT — extend with search-input + reset coverage
        └── FormScreen.test.tsx                              # NEW — write-through coverage

__tests__/integration/
└── case-list-search-running-app.test.ts                     # NEW
```

The existing `components/preview/screens/CaseSearchConfigInteractEmptyState.tsx` stays unchanged — it is the canonical "search-config has no running-app surface" arm that the Plan 4 mount work shipped. The dispatcher in `PreviewShell.tsx` already routes `(screen.type === "searchConfig", mode !== "edit")` to it; Plan 5 does not introduce any new screen type or PreviewShell branch.

---

## Tasks

### Task 1: Runtime bindings layer

**Files:** `lib/preview/engine/runtimeBindings.ts` (NEW), `lib/preview/engine/__tests__/runtimeBindings.test.ts` (NEW).

Pure module that translates current search-input values into one Predicate the case-list query AND-composes with `caseListConfig.filter`. Server-safe and client-safe — no `CaseStore` dependency, no Server Action import, so the module can be value-imported from both `caseDataBindingHelpers.ts` and the running-app screen.

The contract:

```ts
// Map from input.name → user-typed string value. An empty string
// (or absent key) means the user has not filled the input —
// per-input contributions short-circuit to "no clause".
// `<name>:from` / `<name>:to` for range bounds; bare `<name>` otherwise.
export type SearchInputValues = ReadonlyMap<string, string>;

/**
 * Compose every contributing search-input's runtime predicate into
 * one Predicate. Caller-side AND-composition with
 * `caseListConfig.filter` happens at the helper layer (`readCases`)
 * so the unified-filter slot remains the single source for both the
 * case-list always-on filter and the search-input contributions.
 *
 * Per-arm dispatch (matches the actual `lib/domain/predicate`
 * builder signatures — `match(property, value, mode)`):
 *
 *   - `kind: "simple"` — value flows through `(property, mode, via)`
 *     into a per-mode comparison built via the `lib/domain/predicate`
 *     builder set:
 *       - `exact` (per-type default for text / select / date / barcode) →
 *         `eq(prop(caseType, property, via?), literal(value))`
 *       - `fuzzy` → `match(prop(...), literal(value), "fuzzy")`
 *       - `starts-with` → `match(prop(...), literal(value), "starts-with")`
 *       - `phonetic` → `match(prop(...), literal(value), "phonetic")`
 *       - `fuzzy-date` → `match(prop(...), literal(value), "fuzzy-date")`
 *       - `range` (per-type default for date-range) →
 *         `between(term(prop(...)), { lower: dateLiteral?, upper: dateLiteral? })`
 *         — reads `<name>:from` and `<name>:to` keys; absent / empty / non-ISO
 *         either-end omits that bound.
 *       - `multi-select-contains` → `multiSelectAny(prop(...), ...literals)`
 *         or `multiSelectAll(prop(...), ...literals)` per quantifier; tokens
 *         comma-split + trim + filter empties.
 *
 *   - `kind: "advanced"` — the input's `predicate` AST is bound
 *     against an `input(name)` term reference; the runtime walks the
 *     AST and substitutes the value at every `input(name)` Term node
 *     whose `name` matches THIS input's name. Other input refs
 *     (orphans / other inputs) stay un-substituted. The substituted
 *     predicate AND-composes into the result.
 *
 * Per-arm empty-value short-circuit: trim once at read; absent map
 * key OR whitespace-only value → input contributes no clause.
 * Zero-input or all-empty call returns the conjunction identity
 * element `match-all` so the helper layer can AND-compose
 * unconditionally without a "did anything contribute" check.
 *
 * Default-mode dispatch is a typed Record table
 * (`DEFAULT_SEARCH_MODE_KIND: Record<SearchInputType, DefaultableModeKind>`)
 * — the kind is `Exclude<SearchInputMode["kind"], "multi-select-contains">`
 * so the construction site reads off the table directly with no
 * runtime narrowing-throw. A typed test pins agreement with
 * `APPLICABLE_SEARCH_MODES[type][0]` so the editor's "first entry
 * is the default" contract stays the source of truth.
 *
 * The advanced-arm walker is a fresh-tree builder (no in-place
 * mutation) so persisted Firestore predicates and the doc store's
 * zundo undo/redo retain reference equality on the input AST.
 */
export function composeRuntimeFilter(
  searchInputs: ReadonlyArray<SearchInputDef>,
  inputValues: SearchInputValues,
  caseType: string,
): Predicate;
```

The `caseType` parameter threads to every `prop(caseType, property)` Term construction so the predicate compiler can resolve the property's `data_type` from the case-type schema map.

**Range-mode value shape.** A `date-range` input emits two values into the map under `<name>:from` and `<name>:to` — the widget at Task 3 pairs them; the binding layer reads both keys; an empty either-end omits the range. (`<name>` is the input's `name` slot, not `kind`.) Calendar validity (month 13, Feb 30) is enforced at SQL emission via the `date` cast in `compileLiteral`; the runtime-bindings layer's `parseDateBound` gates on the wire-form `YYYY-MM-DD` shape so mid-edit empty / partial values from the date input widget don't crash the cast.

**`SearchInputDef.default` slot.** The schema carries an optional `default: ValueExpression` slot — `today()` for date-typed inputs, etc. Plan 5 does NOT honor the slot in the preview; the JS-side has no `ValueExpression` evaluator (the AST is Postgres-strict). Initial input values render empty; the user types to filter. Honoring `default` requires a JS-side AST evaluator and lands in a follow-up spec — see "Deferred to follow-up specs" below.

**Tests:** simple-arm `(property, mode, via)` mapping for each mode (the test fixtures cover exact / fuzzy / starts-with / phonetic / fuzzy-date / range / multi-select-contains); advanced-arm `input(name)` Term substitution across every Predicate / ValueExpression / Term arm including `between.left` / `between.lower` / `between.upper` / `if.cond` cross-family / `count.where` cross-family / `whenInputPresent.input` trigger preservation / orphan-input preservation; empty-value short-circuit per input; padded-value trim normalization; mixed-arm composition produces a single AND chain.

> **SHIPPED.** Task 1 landed at `lib/preview/engine/runtimeBindings.ts` (commits `0f00b85d` through `bf446018`) with 65 contract tests. `composeRuntimeFilter` and `SearchInputValues` are exported.

### Task 2: Extend `readCases` for runtime values + new `resetSampleCases` helper

**Files:** `lib/preview/engine/caseDataBindingHelpers.ts` (EDIT), `lib/preview/engine/__tests__/caseDataBinding.test.ts` (EDIT).

Two extensions to the helpers module.

**`readCases` accepts `inputValues?: SearchInputValues`.** When supplied, the helper composes `composeRuntimeFilter(caseListConfig.searchInputs, inputValues, caseType)` (Task 1) and AND-composes the result with `caseListConfig.filter` to produce the predicate that flows to `store.query(...)`. The unified filter slot is the single source for both case-list and search filtering — there is no separate "search default filter" parameter.

When `inputValues` is undefined OR `caseListConfig` is undefined, the helper short-circuits to the existing behavior (no runtime contribution). When `caseListConfig.searchInputs.length === 0`, the helper short-circuits without invoking `composeRuntimeFilter`.

**New `resetSampleCases` helper.** Mirror of `seedSampleCases` over `store.resetSampleData`:

```ts
export async function resetSampleCases(
  store: CaseStore,
  args: { appId: string; caseType: CaseType },
): Promise<PopulateSampleCasesResult> {
  const result = await store.resetSampleData({
    appId: args.appId,
    caseType: args.caseType,
    count: SAMPLE_CASE_DEFAULT_COUNT,
  });
  return { kind: "ok", inserted: result.inserted };
}
```

The case-store's `resetSampleData` runs delete + regenerate in one transaction (per `lib/case-store/CLAUDE.md` § sample-data); a mid-operation failure rolls back.

**Tests:** running-app case list with no search inputs reads as before; running-app case list with simple-arm inputs filters correctly; running-app case list with advanced-arm inputs filters correctly; mixed-arm composition AND's clauses; empty-value short-circuit produces unfiltered rows; reset helper deletes existing rows and regenerates a fresh population.

**Internal helper.** A private `composeQueryPredicate(caseListConfig?, inputValues?, caseType)` lives in the helpers module and owns the three-way dispatch: no `caseListConfig` → no predicate; absent `inputValues` OR empty `searchInputs` → pass `caseListConfig.filter` verbatim; both populated → compose `composeRuntimeFilter`, drop `match-all` clauses (the conjunction identity), then `and(...)` the at-most-two contributions. `match-all` is explicitly filtered before the `and(...)` call because `reduceAnd` only collapses 0- and 1-clause inputs.

> **SHIPPED.** Task 2 landed at `lib/preview/engine/caseDataBindingHelpers.ts` (commits `02b1caf2` through `1afa8598`) with 8 new tests. `readCases` accepts `inputValues?: SearchInputValues`; `resetSampleCases` is exported.

### Task 3: SearchInputForm component

**Files:** `components/preview/shared/SearchInputForm.tsx` (NEW), `components/preview/shared/__tests__/SearchInputForm.test.tsx` (NEW).

Renders one widget per `SearchInputDef` based on `input.type`:

- `type: "text"` → text input.
- `type: "select"` → option dropdown sourced from the case property's declared `options` (resolved via the case-type schema map). Property resolution uses the simple-arm `property` slot directly. Advanced-arm inputs of `type: "select"` reference a predicate AST whose option-source property is structurally ambiguous (the AST may compose multiple property terms); the widget falls back to a text input on the advanced arm. Surfacing a select on the advanced arm is a follow-up affordance once a "primary input property" annotation lands on `AdvancedSearchInputDef` — until then, ambiguity means text-input fallback.
- `type: "date"` → single date picker composed from shadcn-Base-UI `Popover` + `Calendar` (react-day-picker v10 under the hood, WCAG 2.1 AA compliant). Popover lifts `open` state and auto-closes on `Calendar.onSelect` or Clear-button press. Value emits as ISO `YYYY-MM-DD` through `date-fns::format(date, "yyyy-MM-dd")`. Inbound values are gated through the shared `ISO_DATE_PATTERN` + `date-fns::isValid` — calendar-invalid shapes (e.g. `"2024-13-45"`) render the placeholder rather than crashing `format(invalidDate, ...)`.
- `type: "date-range"` → two single date pickers (not one `mode="range"` Calendar) so each bound's lifecycle stays independent; clearing one bound never touches the other. Values emit under `<name>:from` and `<name>:to` (matches the runtime-bindings layer's range-mode key shape).
- `type: "barcode"` → text input. Barcode-scanned values are plain strings on the wire side; the text input mirrors that shape and accepts pasted scanner output. A camera/scanner widget is a follow-up affordance — `getUserMedia` + barcode-decode bundle weight is meaningful, and the typed-string fallback covers every input path the scanner widget would.

The widget shape is the same regardless of `input.kind` — a user filling a search input doesn't see the simple-vs-advanced distinction. The arm distinction is purely about how the value binds to the predicate (Task 1).

`onChange` debounces 300 ms before emitting a fresh `SearchInputValues` map upward. `value` flows from the parent's controlled state. `onChange` is pinned in a ref so a parent passing an inline arrow `(next) => setValues(next)` doesn't reset the debounce timer on every re-render. External `value` updates short-circuit via `lastEmittedRef` (stamped in the sync effect, not only after the form's own emission) so the parent's own push doesn't echo back through `onChange` 300 ms later.

The form fails closed on `searchInputs.length === 0` (returns `null`); callers don't need to gate the mount.

**Mount site:** `components/preview/screens/CaseListScreen.tsx` — top of the list when `caseListConfig.searchInputs.length > 0`, at every state arm (`empty`, `rows`, `loading`).

**Tests:** each `type` renders the right widget; debounced `onChange` fires once per type-burst (300 ms); empty value clears the input; padded value trims (e.g. `"  alice  "` → `"alice"`); calendar-invalid value renders placeholder without crashing; `date-range` emits both `:from` and `:to` keys; `select` options render from the resolved property's declared options; advanced-arm `type: "select"` falls back to a text input; controlled-prop fresh-reference echo does NOT trigger upward `onChange`; date popover auto-closes on pick + Clear.

> **SHIPPED.** Task 3 landed at `components/preview/shared/SearchInputForm.tsx` (commits `26f81d1a` through `a6b827f5`) with 25 tests. The `ISO_DATE_PATTERN` constant is shared with `lib/preview/engine/runtimeBindings.ts`; `parseDateBound` there also gained the `isValid` gate so calendar-invalid inbound shapes drop the bound instead of producing an opaque Postgres `date`-cast SQL error.
>
> Plan 5 onboarded the shadcn-Base-UI library as part of Task 3 (commit `ce9cbc99`): components land at `components/shadcn/` (not `components/ui/`, to avoid case-collision with existing PascalCase hand-written components); shadcn token bindings in `app/globals.css` map onto Nova's `nova-*` palette so shadcn surfaces blend with Nova chrome (violet primary, deep surfaces). All future frontend tasks consume `@/components/shadcn/*` for new UI primitives.

### Task 4: Mount `SearchInputForm` in CaseListScreen

**Files:** `components/preview/screens/CaseListScreen.tsx` (EDIT), `components/preview/screens/__tests__/CaseListScreen.test.tsx` (EDIT).

When `caseListConfig.searchInputs.length > 0`, render `<SearchInputForm />` at the top of the running-app case list, regardless of the load state arm. The form's debounced `onChange` updates a `useState<SearchInputValues>` in the screen; the screen passes `inputValues` through to `useCases` (Task 5 wires the hook).

`useCases` re-fires when `inputValues` is a new reference — debounce in the form keeps the action-call cadence sane.

The existing `CaseListScreen` heading (module name + "Select a case to continue" subtitle), the empty-state "Generate sample data" button, the column-rendering, and the row-click navigation all stay unchanged. The Reset button (Task 6) lands alongside the existing Generate button on the empty arm; the populated arm's chrome lands as a small toolbar row beneath the heading carrying both Generate-on-non-empty + Reset.

The split-screen / inline-search distinction is a CCHQ-runtime UX choice driven by `compileForPlatform`'s `WireShape`. Nova's preview surface is web-apps-shaped (one canonical surface) — there is no Android-vs-Web toggle and no separate split-screen screen. The supervisor-locked decision: `caseSearchConfig` presence does NOT change CaseListScreen's rendering shape; the surface is always inline-search-shaped (search inputs above the list, no left sidebar, no separate search screen). Authors who want to verify the CCHQ-side split-screen UX consult the wire emission, not the preview.

**Tests:** search-input form renders when `searchInputs.length > 0`; typing filters the rendered rows; clearing inputs reverts to filter-only results (the `caseListConfig.filter` always-on filter still applies); zero-search-input config skips the form entirely.

**Internal structure.** A private `shell(body)` helper inside `CaseListScreen` wraps the heading + `<SearchInputForm />` mount above every state arm's body. Each arm passes only its arm-specific body to `shell()` — a future arm cannot silently render without the form. Two-layer gating defense: the screen gates `caseListConfig !== undefined && caseListConfig.searchInputs.length > 0` to skip the wrapper's margin on empty configs, and `SearchInputForm` independently returns `null` for the same input so the contract is self-enforcing even if a future caller forgets the gate.

> **SHIPPED.** Task 4 landed at `components/preview/screens/CaseListScreen.tsx` (commits `6e8ca809` and `d6f311b2`) with 4 new tests. Absorbed the minimal `inputValues?: SearchInputValues` thread through `useCases` + `loadCasesAction` (Task 5 still owns `useResetSampleCases`).

### Task 5: useCases extension + useResetSampleCases hook

**Files:** `lib/preview/hooks/useCaseDataBinding.ts` (EDIT), `lib/preview/hooks/__tests__/useCaseDataBinding.test.ts` (EDIT).

Two hook-layer changes.

**`useCases` accepts `inputValues?: SearchInputValues`** — SHIPPED in Task 4 (absorbed the minimal thread to make Task 4's mount work). Args type carries `inputValues`; effect dep list includes it so fresh-reference values trigger reload. `loadCasesAction` likewise forwards `inputValues` to `readCases`.

**`useResetSampleCases` hook.** Mirror of `usePopulateSampleCases` over the `resetSampleCasesAction` Server Action. Same `(appId, caseType, blueprint) → () => Promise<PopulateSampleCasesResult>` shape; same not-wrapped-in-`useCallback` rationale.

**`resetSampleCasesAction` Server Action.** Scope-absorbed from Task 6 so Task 5's hook compiles standalone. Byte-faithful mirror of `populateSampleCasesAction` (only the delegate call differs: `seedSampleCases` → `resetSampleCases` from Task 2's SHIPPED helper). Session-first ordering preserved.

**Tests:** action covers all five typed paths (ok / unauthenticated / missing-case-type / validation-failure / schema-not-synced); hook returns a fresh callback per render and passes through unauthenticated / error arms cleanly.

> **SHIPPED.** Task 5 landed at commit `4594a242` with 12 new tests (5 action + 7 hook). Task 6's remaining scope is now the Reset button UI + confirmation dialog in `CaseListScreen`.

### Task 6: resetSampleCasesAction Server Action + Reset button on the populated arm

**Files:** `lib/preview/engine/caseDataBinding.ts` (EDIT), `components/preview/screens/CaseListScreen.tsx` (EDIT), tests.

**`resetSampleCasesAction` Server Action.** Mirror of `populateSampleCasesAction` — resolves the session, looks up the `CaseType` from the blueprint, constructs `withOwnerContext(session.user.id)`, delegates to `resetSampleCases` (Task 2's helper). Same typed-error shape (`PopulateSampleCasesResult` reused — the success arm carries `inserted: number`, the count of regenerated rows).

**One button per arm — Generate on empty, Reset on populated.** The empty arm keeps the existing "Generate sample data" button unchanged (it has nothing to reset; populating is the only sensible action). The populated arm gets a new "Reset sample data" button surfaced in a small toolbar row beneath the heading. Reset's action call:

```ts
const reset = useResetSampleCases({ appId, caseType: caseType?.name, blueprint });
const handleReset = async () => {
  setResetStatus({ kind: "running" });
  const result = await reset();
  /* same arm dispatch as handleGenerate */
};
```

The pending state UX mirrors the existing Generate button (`tabler/loader-2` spinner; disabled while `running`; toast on success/error using the same shape the empty-state error message uses).

**Confirmation dialog.** `resetSampleData` deletes ALL rows for the `(appId, caseType)` pair (per `CaseStore.resetSampleData`'s contract). The author may have hand-edited rows via running-app form submissions — a misclick should not silently destroy them. The button surfaces a confirm dialog ("This will delete every case in this case type and replace it with fresh sample data. Continue?") before invoking the action. The dialog uses the project's existing dialog primitive — verify the canonical primitive during implementation (look for the case-list-config workspace's existing destructive-action confirms; reuse the same shape).

**Tests:** Reset action invoked on confirm; canceled confirm leaves data untouched; pending UX disables the Reset button while in flight; toast renders on success/error; empty arm renders Generate (no Reset); populated arm renders Reset (no Generate).

**Dialog primitive.** Used shadcn-Base-UI's `AlertDialog` (`@/components/shadcn/alert-dialog` — installed at commit `5b3edb29`). Controlled `open` state because Base UI's `AlertDialogAction` is a plain Button with no auto-dismiss wiring; controlling `open` closes the dialog the instant Reset is confirmed so the trigger's pending spinner is visible without a frozen modal overlay. `AlertDialogAction variant="destructive"` surfaces the destructive intent through the existing button variant tokens.

**Internal structure.** A shared `describePopulateError(result, verb)` helper at file scope maps `PopulateSampleCasesResult`'s five typed-error arms (`unauthenticated` / `missing-case-type` / `schema-not-synced` / `validation-failure` / `error`) into user-facing messages, parameterized by a `"Generate" | "Reset"` verb. Both `handleGenerate` and `handleResetConfirmed` route through it so the only divergence between the two flows is the verb token. Both inline error renderers use `whitespace-pre-line` so the `validation-failure` arm's `\n`-joined message renders across lines instead of collapsing onto one row.

> **SHIPPED.** Task 6 landed at commits `8d4e868c` and `03d38af8` with 8 new tests (17 total in the CaseListScreen suite). The `AlertDialog` shadcn primitive was installed at `5b3edb29` as part of this task.

### Task 7: Form running-app write-through wiring

**Files:** `components/preview/screens/FormScreen.tsx` (EDIT), `components/preview/screens/__tests__/FormScreen.test.tsx` (NEW).

Existing `FormScreen.handleSubmit` calls `controller.validateAll()` and navigates on validate-pass without writing to the case store. Plan 5 closes the gap.

The new flow on validate-pass:

1. `controller.computeSubmissionMutation({ caseId, caseTypes })` — `caseTypes` from `useCaseTypes()`; `caseId` from the URL nav stack. Already exists on the controller.
2. `submitFormAction(mutation, appId)` — already exists. Returns a typed `SubmissionResult`.
3. On success, dispatch the same navigation the current code does (`form.postSubmit ?? defaultPostSubmit(form.type)`).
4. On `unauthenticated` / `error` / `case-not-found` / `case-properties-validation` / `missing-case-type` / `schema-not-synced` arms, surface a toast or an inline error (the form stays on screen for the user to amend; the engine's touched/validated state is preserved).
5. After success, the parent `CaseListScreen`'s `useCases` hook re-fetches on next mount (its reload key) — Activity-revealed CaseListScreen on `back` navigation re-fetches naturally because the screen's effect reads fresh `inputValues` + `caseListConfig`. No explicit invalidation is needed; the screen-level reload key handles refresh patterns the user observes.

**Pending UX.** The submit button switches to a spinner during the in-flight action; the form's input set disables. On error, the spinner clears and the error message renders below the submit row.

**Edge cases.**
- Survey form (`form.type === "survey"`) — `mutation.kind === "survey"` is a structural no-op at the case-store; the navigation still dispatches.
- Followup form without `caseId` — already handled by the existing "No cases available" empty state (same code path).
- Registration form with empty children — `mutation.children: []` is the no-children path; `applyRegistrationMutation` writes the primary only.

**Tests:** registration form submit writes the primary case to the store; followup form submit updates the bound case; close form transitions the case to `closed` and removes it from default-open queries; survey form submit dispatches navigation without writing; error arms render inline errors and keep the user on the form.

**Internal helpers.** A shared `describeSubmitError(result)` mapper at file scope maps `SubmissionResult`'s typed-error arms into user-facing messages — `SubmissionFailure = Exclude<SubmissionResult, { kind: FormType }>` keys the exclusion off the centralized `FormType` union so a future success arm extends the failure type automatically. A `dispatchPostSubmit` helper extracts the post-submit destination switch with exhaustive `default` over `POST_SUBMIT_DESTINATIONS`. Both case-loading-form guards use `CASE_LOADING_FORM_TYPES.has(form.type)` (not literal `"followup"`) so close forms without `caseId` hit the same empty state as followups instead of falling through to the submit row + a generic engine-throw catch. `handleSubmit` resets `submitStatus` to idle at the top so stale server errors don't persist across validate-fail re-submits; `handleClear` does the same so the Clear button clears any alert alongside the engine reset.

> **SHIPPED.** Task 7 landed across 4 commits (`286de62c`, `479b989c`, `dd5dd7b7`, `84130898`, `fd68a1ab`, `7fa24fb1`) with 17 new tests covering all 4 form-type success arms, 6 typed-error arms, pending UX, validate-fail short-circuit, appId guard, catch-arm jargon suppression, case-loading-form empty state (followup AND close), stale-server-error reset on re-submit, and Clear-clearing-alert.

### Task 8: Plan 5 integration test

**Files:** `__tests__/integration/case-list-search-running-app.test.ts` (NEW).

End-to-end against the testcontainer harness:

1. Build a fixture blueprint with full `caseListConfig` (columns + sort + filter + searchInputs covering every `SearchInputType` + every applicable mode) + `caseSearchConfig` (excludedOwnerIds + display labels).
2. Mount the running-app `<PreviewShell />` against the fixture (use React Testing Library `render` against a test-wrapped `BuilderProvider`).
3. Switch cursor mode to `pointer` so `useEditMode() === "test"` and `CaseListScreen` is the active Activity arm.
4. Verify the rendering: heading is the module name, columns reflect `visibleInList`, calc cells render via `evaluateColumnValue`, sort directives produce the expected row order.
5. Type values into the search inputs; assert the filtered rows re-render with the AND-composed `(filter, runtime-predicate)` shape.
6. Submit a registration form via the running-app surface; navigate back to the case list; assert the new case is present in the rows.
7. Submit a followup; assert the row's properties + `case_name` reflect the patch.
8. Submit a close; assert the row no longer surfaces in default-open queries.
9. Click Reset; confirm the dialog; assert the case-list re-queries with the regenerated row population.

The test verifies Plan 5's surface area against the live Postgres `cases` table — no in-memory store, no mocked case-store. The harness's `setupPerTestDatabase` per `lib/case-store/CLAUDE.md` § testcontainers harness handles the per-test database isolation.

**Shipped scope.** Five integration tests covering the cross-layer round-trips:

1. **CaseListScreen with search inputs — real Postgres narrowing.** Seeds 3 rows, filters out `status="closed"` via the always-on filter, asserts `age desc` sort order, types into `SearchInputForm`, asserts the runtime-bindings predicate AND-composes with the filter, asserts clearing reverts to filter-only. Module-name heading + calc-cell render via `evaluateColumnValue` also pinned.
2. **FormScreen registration submit — write-through to case list.** Fills registration form, submits, verifies the success-arm navigation, re-mounts `CaseListScreen` against the same store, asserts the new row surfaces.
3. **CaseListScreen Reset — atomic delete + regenerate round-trip.** Seeds sentinel row, clicks Reset, confirms dialog, asserts sentinel disappears.
4. **FormScreen followup submit — patch round-trips to the rendered row.** Asserts the case-list re-render reflects the patched plain Age column AND the calc cell re-evaluation.
5. **FormScreen close submit — `closed_on` stamped through to the case-store.** Asserts the zero-field close form's submission lands `closed_on = now()`. Note: `CaseStore.close()` accepts an optional `status` argument but `applyCloseMutation` doesn't pass one — closing leaves `status` untouched, contrary to an earlier framing of step 8.

**Helper-delegate mock strategy.** `vi.mock("@/lib/preview/engine/caseDataBinding")` stubs each Server Action; the stub captures the per-test `PostgresCaseStore` in closure and delegates to the corresponding `caseDataBindingHelpers` function. The helpers were designed for this test-injection contract — they already accept a `CaseStore` parameter. Bypasses production `getSession()` + `withOwnerContext(userId)` wrappers while exercising every code path below the action layer.

**Direct screen mount.** `<CaseListScreen>` + `<FormScreen>` mounted directly rather than via `<PreviewShell />`. The dispatcher's per-arm routing has its own unit-test coverage; the integration concern is the runtime-bindings + Postgres round-trip.

**`caseSearchConfig` not in the fixture.** Plan 5's "Deferred to follow-up specs" section confirms none of `caseSearchConfig`'s slots affect the running-app preview rendering — they only emit to the wire. Adding the slot would have produced fixture surface that drives no assertion.

**Note on `compileConcat` bind-type inference.** Tried `concat(prop, literal)` as the calc-column expression first; trips Postgres `could not determine data type of parameter $N` because `compileConcat` in `lib/case-store/sql/compileExpression.ts` doesn't emit text casts on parameter operands (the `within-distance` compiler shows the cast-each-fragment pattern is required when concat-ing parameter-bound values). Out of scope for Plan 5; documented in the fixture comment so the next maintainer doesn't re-step the rake. The test uses `arith("+", prop, qualifiedLiteral(1, "int"))` instead.

> **SHIPPED.** Task 8 landed across 3 commits (`77198e06`, `a59d1ef7`, `632c4aa4`) with 5 integration tests, single-run green.

**No platform-flag branching.** The integration test does not branch on `compileForPlatform`'s `WireShape` — the running-app preview is platform-agnostic and renders the inline-search shape regardless of platform context. The wire-emission tests (Plan 4 Task 13) cover `WireShape` permutations; Plan 5 covers the preview rendering.

---

## Dependencies between tasks

- 1 standalone (depends on `lib/domain/predicate` builders + `lib/domain/modules.ts::SearchInputDef` + `lib/domain/expression`).
- 2 depends on 1 + Plan 2's `CaseStore.query` / `CaseStore.resetSampleData`.
- 3 depends on `SearchInputDef` + the case-type schema's `options` slot.
- 4 depends on 3.
- 5 depends on 1, 2, 4 (the hook surface composes the running-app screen's data flow).
- 6 depends on 5.
- 7 depends on the existing `submitFormAction` + `controller.computeSubmissionMutation` + `useCaseTypes`.
- 8 depends on all prior.

Tasks 1-2 (engine) and 3-4 (UI) can interleave; task 5 (hook) merges them; task 6 extends the empty arm + adds the action; task 7 closes the form-submit gap; task 8 is the integration test.

## Final verification

- [ ] `npm run lint` clean.
- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run build` clean.
- [ ] `npm test` green (full suite, deterministic two consecutive runs).
- [ ] Integration test (Task 8) passes.
- [ ] Manual smoke: full registration → search-input filter → followup → reset workflow round-trips through the running-app surface against Postgres.
- [ ] **User-runnable acceptance:** User runs `npm run dev`, opens an existing case-typed app, navigates to a module's case list at `/build/{appId}/{moduleUuid}/cases`. Toggles cursor mode to `pointer` (live preview). Sees actual case rows from `CaseStore` rendering with the configured columns / sort / filter / calc applied. If the module has search inputs, sees a search-input form above the list. Types into a search input; sees the rows filter live (debounced ~300 ms). Submits a registration form via the running-app surface. Returns to the case list. Sees the new case appear. Clicks "Reset"; confirms; sees the cases collection clear and regenerate. End-to-end running-app loop reachable from a fresh `npm run dev` session WITHOUT any "configure first" handholding.

## Deferred to follow-up specs

Four surfaces fall out of scope for Plan 5 and require dedicated follow-up:

- **`SearchInputDef.default` slot honored at first render** — the schema carries `default: ValueExpression` (e.g. `today()` for date-typed inputs). Honoring it in the preview requires a JS-side `ValueExpression` AST evaluator. The Postgres-strict AST has no JS evaluator today (every value-expression evaluates at the SQL layer via `compileExpression`). A follow-up spec ships the JS-side evaluator and threads it through `SearchInputForm`'s initial-value path. Plan 5 renders inputs empty.
- **`searchButtonDisplayCondition` honored as a Nova-side affordance** — the schema slot exists, validates, and emits to the wire. CCHQ's runtime hides the search button when the predicate is false. Nova's preview surface has no separate "search button" (the inputs filter inline as the user types), so there is structurally nothing to hide. If a future preview surface introduces an explicit "Run search" affordance, the predicate gates it then. Plan 5 ignores the slot in the preview.
- **`excludedOwnerIds` honored as a preview filter** — the schema slot exists and emits to the wire (`commcare_blacklisted_owner_ids`). CCHQ's runtime excludes the named owners from the search-result population at query time. Nova's preview rows are tenant-scoped (one author = one owner = one tenant); excluding "another user's rows" is structurally meaningless because there are no other users' rows in the preview's row set. The slot is wire-only.
- **Search-screen display labels rendered in the preview** — `caseSearchConfig.{searchScreenTitle, searchScreenSubtitle, emptyListText, searchButtonLabel, searchAgainButtonLabel}` are five label slots that exist on the schema and emit to the wire. The CCHQ runtime renders them on its dedicated search screen — a separate surface from the case list. Nova's preview surface is one canonical inline-search shape: `CaseListScreen` shows the module name as the heading and the rows below; there is no separate search screen and no search-results screen. Honoring the labels in the preview would require either (a) inserting a search-screen-shaped surface that conflicts with the inline-search principle, or (b) overloading `CaseListScreen`'s heading/subtitle/empty-state with `caseSearchConfig`-conditional fallback logic that contradicts the "module-name heading" rule the v2 reshape locked. Both shapes are larger than Plan 5; a dedicated follow-up that rationalizes the case-list heading family across `caseListConfig` + `caseSearchConfig` ships the rendering.

The four deferrals are explicit decisions, not omissions — the load-bearing surfaces (runtime-bindings, UI mount, write-through, reset) ship in Plan 5; the four deferrals stay where they are because the alternative is extending Plan 5 with infrastructure that has no Plan-5 caller.

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

The bulk of work is the runtime-bindings layer (Task 1), the `SearchInputForm` widget (Task 3), and the form-submit write-through (Task 7). After Plan 5 ships, the case-list-and-search foundation is end-to-end exercised in the running-app surface against live Postgres rows. The running-app view is web-apps-shaped per the spec's "One surface, no mode picker, no platform toggle" rule — Plans 4 and 5 do not produce per-platform preview affordances; CCHQ runtime fragmentation is handled silently by the export adapter when the app ships.

---

## Program-level summary (after Plan 5 ships)

The five plans together produce: typed Predicate AST + typed Expression AST, three per-dialect wire emitters, Postgres compiler via Kysely, Cloud SQL Postgres `CaseStore` (the live runtime from v1), schema-driven sample data generator, case-list authoring UI with typed cards + wire emission for short/long detail, case-search authoring UI + wire emission for `<remote-request>`, platform-aware compilation (export-adapter-side, silent), and the flipbook's web-apps-shaped running-app surface with inline search-input filtering and write-through forms. Each plan ships separately-reviewable, separately-testable software.

What ships:
- Typed Predicate AST + Expression AST (Plan 1)
- Three per-dialect wire emitters + Postgres compiler (Plan 1)
- Cloud SQL Postgres `PostgresCaseStore` — the live runtime (Plan 2)
- `HeuristicCaseGenerator` writing through `PostgresCaseStore` (Plan 2)
- Case-list authoring UI with typed cards + the v2 schema reshape (Plan 3 + 2026-05-07 reshape)
- Wire emission for case-list short / long detail (Plan 3)
- Case-search authoring UI — Display + Advanced sections + `searchInputs` cross-binding (Plan 4)
- Wire emission for `<remote-request>` + dual `<detail>` blocks (Plan 4)
- Platform-aware compilation, export-adapter-side (Plan 4)
- Flipbook running-app surface — web-apps-shaped, with inline search-input filtering and write-through forms (Plan 5)

What ships in follow-up specs:
- JS-side `ValueExpression` evaluator + `SearchInputDef.default` initial-value seeding (default-values spec)
- Visual / geo formats + case tiles (visual/geo formats spec)
- Related-case detail tabs (advanced detail spec)
- Multi-select case lists (multi-select spec)
- Data registries, lookup tables, geocoder receivers (advanced search spec)
- LLM-powered sample data generator (sample-data sources spec; Haiku backlog item)
- Firestore retirement (independent spec)
