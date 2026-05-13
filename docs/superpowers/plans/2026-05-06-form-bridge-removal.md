# Plan 2 amendment — form-bridge removal (engine emits mutations directly)

**Status:** SHIPPED 2026-05-06 in commits `1c1268dc` (plan amendment) → `9a389a9a` (drop unused `_caseTypes` parameter) → `4c053bf1` (engine emits `SubmissionMutation`) → `aca981b2` (case_name slot fix) → `0c49aea1` (controller throws on missing engine) → `40601f13` (`submitFormAction` Server Action + per-arm helpers) → `be3c604c` (comment hygiene fix-pass) → `639306d4` (delete form-bridge package) → `1640af9e` (close coverage gaps + checklist hygiene) on branch `feat/case-list-search`. Plan 2's `Plan 2 follow-up — form-bridge removal SHIPPED` block at the end of `2026-05-01-case-data-layer.md` is the closure marker.

Original amendment shape preserved below for archeology — described what shipped.

**Trigger:** During holistic review of Plan 2's shipped form-bridge, `countRepeatInstances` was found regex-parsing path strings to recover repeat indices. Tracing the smell upstream surfaced the structural problem: the form-bridge package exists as a CCHQ-mirroring serialization layer between two components (the form engine and the case-store) that share memory. CCHQ has runtime/processor separation because their form runtime runs on mobile devices and casedb lives on HQ servers — XForm-the-spec is the wire format that crosses the network. Nova has no such separation. Both run in the same Node process, in the same Cloud Run container, in the same request lifecycle. The form-bridge inherited CCHQ's layer count without inheriting CCHQ's reason for it; the regex was the visible symptom of a package whose entire job was recovering structure the engine never had to lose.

---

## Architecture target

One real wire crossing — client → server, forced only because the session lives on the server. Zero invented layers between the two.

- **Form engine (client)** owns its tree. On submit, the engine walks its own template `FieldTreeNode` tree once. For each leaf field, it consults its existing public read surface (`getRepeatCount(repeatPath)` for instance counts; `instance.get(materializedPath)` for per-instance values) to resolve per-instance values, buckets fields by `field.case_property_on` for primary vs children, applies `data_type` coercion using a call-time-injected `caseTypes` array, and emits a structured `SubmissionMutation` discriminated by form type. No path strings. No flat `Map<string, string>` snapshot. No regex.
- **Submit handler (Plan 5 running-app surface, client)** — `FormHandoff.tsx`. Calls `controller.validateAll()`. If invalid, scrolls to error and returns. If valid, calls `controller.computeSubmissionMutation({ caseId, caseTypes })` with `caseTypes` from the session-store (`useBuilderSession((s) => s.caseTypes)`) and `caseId` from the URL nav stack, hands the result to `submitFormAction(mutation, appId)`. The preview surface (`components/preview/screens/FormScreen.tsx:161-184`) is a different consumer — it continues to navigate-only on validate-pass; it never calls `computeSubmissionMutation`. Mode separation is consumer-side, not engine-side.
- **Server Action (server, thin auth wrapper)** — `submitFormAction(mutation: SubmissionMutation, appId: string): SubmissionResult`. Calls `getSession()`, constructs `withOwnerContext(session.user.id)`, dispatches on `mutation.kind` to the matching `CaseStore` method, returns the typed result. Same `getSession` → `withOwnerContext` → typed-error-mapping shape as the existing `populateSampleCasesAction`. Lives in `lib/preview/engine/caseDataBinding.ts` as the fourth Server Action in the file.

**Filtering is emptiness-only — preserved verbatim from the deleted form-bridge.** The deleted `walkFormFields` filters `if (rawValue === "")` (`deriveFromForm.ts:422-423`); `getValueSnapshot` filters `if (state.value)` (`formEngine.ts:646`). Both shapes admit "absent path" + "non-empty value" only; neither consults `state.visible`. `computeSubmissionMutation` matches this exact contract — empty values are excluded, hidden fields with non-empty values are NOT excluded. This preserves the "two-state JSONB collapse" rule documented at `lib/case-store/CLAUDE.md` § "Two-state JSONB collapse for form completion." `relevant=false` semantics — if needed in a future plan — is a separate concern, scoped to the engine's `relevant` evaluation and the form-completion contract together; this amendment does not introduce it.

**Validation gating is the consumer's concern.** `computeSubmissionMutation` does not gate on validation — it assumes a valid form. The consumer (Plan 5 Task 4's `FormHandoff.tsx`) calls `controller.validateAll()` first; on failure, refuses construction. This preserves the "Apps are always in a valid state" rule.

**Mutations and form-state-records stay decoupled.** The `SubmissionMutation` IS the testable surface — Plan 5 Task 6's integration test asserts against it pre-write rather than round-tripping through Postgres or capturing a parallel form-state record. CCHQ couples form-state and data-extraction because XForm forces both into one document; we don't have to.

---

## Method signatures

Pinned. Implementer chooses internal helpers / data-structure shapes; the public surface below does not move.

```ts
// lib/preview/engine/formEngine.ts
class FormEngine {
  // Constructor + updateSchema drop the unused _caseTypes parameter entirely.
  // The engine does not carry caseTypes as state — caseTypes are call-time
  // injected on computeSubmissionMutation, the only method that consumes them.
  constructor(
    input: FormEngineInput,
    moduleCaseType?: string,
    caseData?: Map<string, string>,
  );

  updateSchema(
    input: FormEngineInput,
    moduleCaseType?: string,
    caseData?: Map<string, string>,
  ): void;

  // The new method. Walks the engine's template tree; for each leaf field
  // inside a repeat region, walks per-instance via getRepeatCount + instance.get.
  // Coerces per data_type using the call-time-injected caseTypes array.
  // Throws if formType is followup/close and no caseId is provided —
  // same precondition the deleted writeThrough enforced.
  computeSubmissionMutation(args: {
    caseId?: string;
    caseTypes: ReadonlyArray<CaseType>;
  }): SubmissionMutation;
}

// lib/preview/engine/engineController.ts — pass-through method following
// the existing pattern (the controller's pass-through methods span lines 334-438:
// onValueChange, onTouch, validateAll, reset, resetValidation, getRepeatCount,
// addRepeat, removeRepeat, getPath).
class EngineController {
  computeSubmissionMutation(args: {
    caseId?: string;
    caseTypes: ReadonlyArray<CaseType>;
  }): SubmissionMutation;
}

// lib/preview/engine/caseDataBinding.ts — fourth exported Server Action
// alongside loadCasesAction / loadCaseDataAction / populateSampleCasesAction.
export async function submitFormAction(
  mutation: SubmissionMutation,
  appId: string,
): Promise<SubmissionResult>;
```

`SubmissionMutation` and `SubmissionResult` discriminated unions live in `lib/preview/engine/caseDataBindingTypes.ts`.

`SubmissionMutation` per-arm shape:

- `{ kind: "registration"; primary: { caseType, properties }; children: ReadonlyArray<{ caseType, properties }> }` — children carry NO `parentCaseId`; the Server Action dispatches to `caseStore.insertWithChildren` (atomic), which threads the primary's generated id as each child's `parent_case_id` (`store.ts:200-207`).
- `{ kind: "followup"; caseId; patch: { properties }; children: ReadonlyArray<{ caseType, properties, parentCaseId: <bound caseId> }> }` — children's `parentCaseId` is the bound caseId; the Server Action dispatches to per-arm helpers that call `caseStore.update` for the primary then `caseStore.insert` per child. Not atomic across the primary update + per-child inserts (matches the deleted form-bridge's atomicity contract documented at `lib/case-store/CLAUDE.md` § "Form-bridge — completed-form to CaseStore operations").
- `{ kind: "close"; caseId; patch: { properties }; children: ReadonlyArray<...> }` — same shape as followup, plus a final `caseStore.close(caseId)` after the updates land.
- `{ kind: "survey" }` — no operations; Server Action returns the matching no-op result arm.

`SubmissionResult` follows the `populateSampleCasesAction` typed-error shape (`caseDataBindingTypes.ts:59-69`):

```ts
export type SubmissionResult =
  | { kind: "registration"; caseId: string; childCaseIds: ReadonlyArray<string> }
  | { kind: "followup"; caseId: string; childCaseIds: ReadonlyArray<string> }
  | { kind: "close"; caseId: string; childCaseIds: ReadonlyArray<string> }
  | { kind: "survey" }
  | { kind: "unauthenticated" }
  | { kind: "case-not-found"; caseId: string }
  | { kind: "case-properties-validation"; caseType: string; failures: CasePropertyFailure[] }
  | { kind: "missing-case-type"; caseType: string }
  | { kind: "schema-not-synced"; caseType: string }
  | { kind: "error"; message: string };
```

A `mapSubmitFormError(err: unknown): SubmissionResult` helper in `caseDataBindingHelpers.ts` follows the `mapPopulateSampleCasesError` (`caseDataBindingHelpers.ts:154-174`) pattern: `instanceof CaseNotFoundError` → `case-not-found`, `instanceof CasePropertiesValidationError` → `case-properties-validation`, `instanceof CaseTypeNotInBlueprintError` → `missing-case-type`, `instanceof SchemaNotSyncedError` → `schema-not-synced`, fallthrough → `error`. Server Action wraps the dispatch in `try / catch (err) { return mapSubmitFormError(err) }`.

Internal helper extraction inside `caseDataBindingHelpers.ts` (per-arm `applyRegistrationMutation` / `applyFollowupMutation` / `applyCloseMutation` / `applySurveyMutation`) uses the same `accept a CaseStore parameter` test-injection pattern the existing helpers use. Implementer-tactical.

---

## Surface map

### Files deleted

- `lib/case-store/form-bridge/deriveFromForm.ts`
- `lib/case-store/form-bridge/writeThrough.ts`
- `lib/case-store/form-bridge/__tests__/deriveFromForm.test.ts`
- `lib/case-store/form-bridge/__tests__/writeThrough.test.ts`
- `lib/case-store/form-bridge/__tests__/fixtures.ts`
- `lib/case-store/form-bridge/` (the directory itself, after the above)

### Types deleted

- `CompletedForm` (the snapshot consumer's input)
- `DerivedFormOps` (the pure-derivation discriminated union)
- `WriteFormCompletionResult` (replaced by `SubmissionResult`)
- `ChildInsertOp`, `DeriveFromFormArgs`, `PrimaryRegistrationOp`, `PrimaryUpdateOp`, `WriteFormCompletionArgs` (all form-bridge-internal; deleted alongside)

### Re-exports deleted

- `lib/case-store/index.ts` lines 25-39 (the form-bridge barrel block; verified — file is 60 lines total, this block runs from `// Form-bridge — completed-form → CaseStore operations.` through the closing `export { writeFormCompletionThrough }` line).

### Files added

- `lib/preview/engine/formEngine.ts` — the `computeSubmissionMutation` method on `FormEngine`. The walking algorithm:
  1. Walk the engine's template `FieldTreeNode` tree (`fieldTree`).
  2. For each leaf field, compute its materialized path. If the field is inside a repeat region: query `engine.getRepeatCount(repeatPath)` for instance count N, then for each instance `i ∈ [0, N)` resolve the materialized path with `[i]/` substitution and read the value via `instance.get(materializedPath)`. If the field is outside any repeat: read the value via `instance.get(path)` directly.
  3. For each non-empty resolved value (`raw !== ""`), look up the case-type's property declaration via the call-time-injected `caseTypes` array (lookup-by-`field.case_property_on`-keyed-name, then property-by-`field.id`-keyed-name); if found, apply `data_type` → JSONB coercion (text → string, int → integer, decimal → number, multi_select → array; null on missing case-type or property — matching the deleted `coerceValueForProperty` semantics at `deriveFromForm.ts:611-660`).
  4. Bucket coerced properties by case type: properties whose `case_property_on` matches `this.moduleCaseType` go to the primary; properties whose `case_property_on` names a different case type go to a child case keyed by `case_property_on` (one child per distinct case type within an instance).
  5. Repeat regions fan out to one child case per instance per case-type within the instance.
  6. Emit the discriminated `SubmissionMutation` per `formType`.

  The constructor + `updateSchema` signatures drop the `_caseTypes` parameter entirely. `_caseTypes` is currently underscore-prefixed and unused (`formEngine.ts:80-98`, `:545-567`); deleting it is a no-op for runtime behavior. Test sites that pass `null` as the second positional argument shift to the new signature in the same commit (step 1).

- `lib/preview/engine/engineController.ts` — the `computeSubmissionMutation` pass-through method on `EngineController`. Mirrors the existing pass-through pattern (lines 334-438; methods include `onValueChange`, `onTouch`, `validateAll`, `reset`, `resetValidation`, `getRepeatCount`, `addRepeat`, `removeRepeat`, `getPath`). Consumers use the controller, not the engine directly (per the existing `useFormEngine` hook surface).

- `lib/preview/engine/caseDataBinding.ts` — the `submitFormAction` Server Action. Fourth in the file alongside `loadCasesAction` / `loadCaseDataAction` / `populateSampleCasesAction`.

- `lib/preview/engine/caseDataBindingTypes.ts` — `SubmissionMutation` and `SubmissionResult` discriminated unions per the shapes pinned above.

- `lib/preview/engine/caseDataBindingHelpers.ts` — per-arm dispatch helpers (`applyRegistrationMutation` / `applyFollowupMutation` / `applyCloseMutation` / `applySurveyMutation`) using the `accept a CaseStore parameter` test-injection pattern. Plus the `mapSubmitFormError(err)` helper.

### Files modified (docs)

- `lib/preview/CLAUDE.md` — extend the "Form engine lifecycle rules" section (currently four bullets, line 15+) with a fifth bullet describing what `computeSubmissionMutation` walks (template tree + per-instance via `getRepeatCount` / `instance.get`), what it consults (call-time-injected `caseTypes` for coercion), and what it emits (a typed `SubmissionMutation`). Plain English; no defensive framing.

- `lib/case-store/CLAUDE.md` — delete the form-bridge sections (lines 200-280-ish; verify against current state at edit time). The "Two-state JSONB collapse for form completion" subsection moves to `lib/preview/CLAUDE.md` (the form completion contract belongs with the form engine now, not the case-store).

### Plan docs updated

- `docs/superpowers/plans/2026-05-01-case-data-layer.md` — Task 6 SHIPPED block prepended with `**SUPERSEDED 2026-05-06 — see [form-bridge-removal.md](2026-05-06-form-bridge-removal.md).**` pointer; the original SHIPPED-on-2026-05-05 description stays intact below the pointer (matches the Tasks 1+2 Atlas-rework precedent at lines 110-185 of that doc). The original block's incorrect test count ("14 pure-function tests") gets corrected to "15" in the same edit. A new `#### Plan 2 follow-up — form-bridge removal SHIPPED` block lands at the end of the Plan 2 doc once this amendment ships.

- `docs/superpowers/plans/2026-05-01-running-app-search-execution.md` — File Structure block comment for `FormHandoff.tsx` updated from `# form-completion → CaseStore.writeThrough` to `# engine.computeSubmissionMutation() → submitFormAction()`. Task 4 body replaced with: *"When a running-app form completes, the consumer calls `controller.validateAll()`; on validate-pass, calls `controller.computeSubmissionMutation({ caseId, caseTypes })` with `caseTypes` from the session-store and `caseId` from the URL nav stack, then dispatches the result to `submitFormAction(mutation, appId)` (Server Action; resolves session, constructs `withOwnerContext`, routes to the matching `CaseStore` method). The case list re-queries automatically (cache invalidation by app-id + case-type)."*

---

## Sequencing — replacement-first, deletion-last

Each step is one commit. Tests pass after each commit.

1. **Drop the unused `_caseTypes` parameter from `FormEngine` constructor + `updateSchema`.**
   - Constructor + `updateSchema` signatures move from `(input, _caseTypes?, moduleCaseType?, caseData?)` to `(input, moduleCaseType?, caseData?)`.
   - Production call site at `engineController.ts:297` updates from `new FormEngine(input, s.caseTypes, mod?.caseType, caseData)` to `new FormEngine(input, mod?.caseType, caseData)`.
   - Test call sites in `lib/preview/engine/__tests__/formEngine.test.ts` (35 sites) and any `lib/preview/engine/__tests__/engineController.test.ts` sites update positionally — `null` passed as the second arg today shifts to `null` passed as `moduleCaseType` in the new signature. Verify each test's intent transfers (most tests don't use `moduleCaseType` and pass `null`; this stays correct).
   - No new code paths added. Existing behavior unchanged.

2. **Add `SubmissionMutation` + `SubmissionResult` types.**
   - Land the discriminated unions in `caseDataBindingTypes.ts` per the shapes pinned in "Method signatures" above.
   - Type-only commit; no runtime change.

3. **Add `FormEngine.computeSubmissionMutation` + `EngineController` pass-through.**
   - Engine method walks the template tree per the algorithm pinned in "Surface map" above; uses `getRepeatCount(repeatPath)` for instance count, `instance.get(materializedPath)` for per-instance values; coerces via call-time-injected `caseTypes`.
   - Controller pass-through follows the existing 334-438 pattern.
   - Add unit tests covering: registration with primary-only fields; registration with primary + child fields; registration with repeat regions producing N children per instance; followup primary update + child inserts; close primary update + child inserts + closure; survey no-op; data_type coercion (text/int/decimal/multi_select; null on missing case-type or property); preconditions (followup/close throws without caseId); empty-value filtering (path absent OR `raw === ""` excluded; hidden field with non-empty value INCLUDED).
   - Existing form-bridge tests still pass (untouched).

4. **Add `submitFormAction` Server Action + per-arm helpers + error mapping.**
   - Server Action discriminates on `mutation.kind`, dispatches to `applyRegistrationMutation` / `applyFollowupMutation` / `applyCloseMutation` / `applySurveyMutation` helpers in `caseDataBindingHelpers.ts`.
   - Registration arm dispatches to `caseStore.insertWithChildren` (atomic primary + children); followup/close arms dispatch to per-call `caseStore.update` + per-child `caseStore.insert` (not atomic, matching the deleted form-bridge contract); close arm finishes with `caseStore.close(caseId)`.
   - `mapSubmitFormError(err)` helper handles the typed-error mapping.
   - Add Server Action tests covering each mutation arm + each error arm.
   - Existing form-bridge tests still pass (untouched).

5. **Verify coverage transfer + zero downstream consumers — single commit, atomic with delete.**
   - Build a coverage checklist at `docs/superpowers/plans/2026-05-06-form-bridge-removal-checklist.md`: list every `it()` block in `deriveFromForm.test.ts` (15 blocks) and `writeThrough.test.ts`, mapping each to the new test (added in steps 3-4) that asserts the same semantic. Surface gaps; close them in this commit.
   - Run the rg sweeps: `rg -l "from .*case-store/form-bridge|from .*form-bridge" lib/ components/ app/` returns no hits outside the package; `rg -l "writeFormCompletionThrough|deriveFromForm|CompletedForm|DerivedFormOps|WriteFormCompletionResult" lib/ components/ app/` returns no hits outside the package.
   - Delete the `lib/case-store/form-bridge/` directory.
   - Delete the form-bridge barrel re-export block in `lib/case-store/index.ts` (lines 25-39 — verified against the current 60-line file; the block starts at the comment `// Form-bridge — completed-form → CaseStore operations.` and ends at the closing `export { writeFormCompletionThrough }` line).
   - Delete the form-bridge sections of `lib/case-store/CLAUDE.md` and move the "Two-state JSONB collapse" subsection to `lib/preview/CLAUDE.md`.
   - Tests pass (deleted-test-file assertions now covered per the checklist).

6. **Sync plan docs + package CLAUDE.md.**
   - Plan 2 doc: prepend SUPERSEDED pointer to Task 6 SHIPPED block; correct the "14 pure-function tests" → "15" in the original block; append new "form-bridge removal SHIPPED" follow-up block at end of doc.
   - Plan 5 doc: update File Structure comment + Task 4 body per the verbatim replacement above.
   - `lib/preview/CLAUDE.md`: extend "Form engine lifecycle rules" section with the new fifth bullet describing `computeSubmissionMutation`.

The earlier draft's separate verify-then-delete steps collapse into one (step 5) because the rg sweep + the delete + the test-coverage cross-check share state — running them in separate commits creates a window where the sweep result is stale.

---

## Risk surface and known semantic preservation

- **Followup-form authoring scope.** Nova's authoring layer admits `case_property_on` only for new-child-insert semantics on followup forms — there is no UI surface for followup-child updates or followup-child closes, and adding them would require a new field-level concept (e.g., `child_case_op: insert | update | close`) plus matching schema vocabulary. The wire-export adapter at the Plan 4 boundary desugars to CCHQ's followup-edit pattern when needed; the authoring layer stays simple. This amendment preserves that scope verbatim.
- **`FieldState.repeatCount` is the load-bearing signal for repeat sizing.** Today's `addRepeat` (`formEngine.ts:148-184`) and `removeRepeat` (`formEngine.ts:186-227`) bump/decrement it; `computeSubmissionMutation` reads it via the public `getRepeatCount(path)` method (`formEngine.ts:229-250`). Any future repeat-mutating path (case-data preload that seeds N instances, replay, etc.) must bump this field — a regression would silently produce wrong child-case counts. Step 3 adds a unit test asserting `state.repeatCount === DataInstance.getRepeatCount(path)` after each engine-exposed mutator path (`addRepeat` / `removeRepeat` / `setValue` / `reset`).
- **Empty-value filtering is preserved verbatim.** The deleted form-bridge filters on `rawValue === ""` only (`deriveFromForm.ts:422-423`). `computeSubmissionMutation` matches this exact contract — the new method does NOT consult `state.visible`. Hidden fields with non-empty values land in the mutation. This preserves the "Two-state JSONB collapse" rule (`lib/case-store/CLAUDE.md` § "Two-state JSONB collapse for form completion"; the section moves to `lib/preview/CLAUDE.md` in step 5). Introducing `relevant=false` filtering is a separate concern, scoped to the engine + form-completion contract together; this amendment does not touch it.
- **`appId` is consumer-supplied; corruption surface documented.** `submitFormAction(mutation, appId)` accepts `appId` from the caller (matches the existing `loadCasesAction` / `loadCaseDataAction` / `populateSampleCasesAction` shape at `caseDataBinding.ts:32-80`). A consumer bug in URL parsing or a stale `useAppId()` could send a mutation to the wrong app for the same owner — the case-store's `(app_id, owner_id)` filter wouldn't catch it (the row lands in app B as a valid row). The risk is bounded — the consumer is `FormHandoff.tsx`, a single Plan 5 surface, and its `appId` source is the URL nav stack which the running-app routing guarantees is consistent. A server-side cross-check on followup/close (fetch the case row, assert `app_id === mutation.appId`) is a candidate future hardening but not part of this work.
- **Coercion is call-time injected.** `caseTypes` flows into `computeSubmissionMutation` at call time, not via engine-internal state. The engine stays state-pure across the new dimension; no `updateSchema` rebuild semantics on every blueprint mutation; tests can construct an engine and invoke the method with arbitrary `caseTypes` shapes without reconstructing the engine.
- **Connect-flow neutrality.** The deleted `deriveFromForm` was Connect-agnostic — it walked `field` entities only. `computeSubmissionMutation` preserves this; the per-form `connect` slot is not part of the submission mutation. Connect-specific writes (deliver_unit / task records) at submit time are out of scope; if needed, they get a separate emission alongside the SubmissionMutation.
- **Lezer XPath rule applies.** No regex in any new code. No `escapeRegExp`. The trigger for this whole amendment was `countRepeatInstances` violating that rule; the replacement does not need XPath-parsing at all because the engine has the structured tree on hand.
- **Mode separation is consumer-side.** The preview surface (`components/preview/screens/FormScreen.tsx`'s `handleSubmit` at line 161-184) keeps its current navigate-only-on-validate-pass behavior — it never calls `computeSubmissionMutation`. The running-app surface (`FormHandoff.tsx`, Plan 5 Task 4) is the only consumer. No engine-side mode guard required.
- **Fresh-eyes CR loop.** Per supervisor rule: call a code-reviewer subagent with no context about prior passes; fix what they find via `SendMessage` to the implementer subagent (not direct edits); call a fresh CR; repeat until a CR returns no findings worth acting on. Plausibly 2-4 passes per implementer step given the foundational nature.
- **Plan 2 closure gate.** Plan 2 cannot be marked closed-out until this amendment lands. Step 6's "form-bridge removal SHIPPED" follow-up block at the end of the Plan 2 doc is the closure marker.

---

## Final verification

- [ ] `npm run test` — case-store + form-engine + Server Action suites green; total test count adjusts (form-bridge tests gone, engine + Server Action tests added)
- [ ] `npm run lint` — clean (no unused exports, no orphaned imports, no `_caseTypes` underscore-prefixed dead parameter)
- [ ] `npx tsc --noEmit` — no errors
- [ ] `rg -l "form-bridge" lib/ components/ app/` returns 0 hits
- [ ] `rg -l "form-bridge" docs/superpowers/` returns exactly 2 hits: this amendment file (`docs/superpowers/plans/2026-05-06-form-bridge-removal.md`) and the Plan 2 doc (`docs/superpowers/plans/2026-05-01-case-data-layer.md`, where Task 6's SHIPPED block carries the SUPERSEDED pointer)
- [ ] Coverage checklist at `docs/superpowers/plans/2026-05-06-form-bridge-removal-checklist.md` shows every `it()` block from the deleted test files mapped to a corresponding new test, with no gaps
- [ ] `lib/preview/CLAUDE.md` "Form engine lifecycle rules" section gained one new bullet describing `computeSubmissionMutation`
- [ ] `lib/preview/CLAUDE.md` gained the "Two-state JSONB collapse" subsection (moved from `lib/case-store/CLAUDE.md`)
- [ ] One end-to-end smoke: a `FormEngine` instance with a registration form blueprint, fill it via the engine's input methods, call `controller.validateAll()` (returns true), call `controller.computeSubmissionMutation({ caseTypes })`, hand the result to `submitFormAction(mutation, appId)` against a real `PostgresCaseStore`, verify the case + children persist with correctly-typed JSONB values
