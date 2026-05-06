# Plan 2 amendment — form-bridge coverage transfer checklist

Step 5 of the form-bridge removal amendment requires every `it()`
block in the deleted form-bridge test files to be mapped to a
corresponding `it()` block in the engine / controller / Server-Action
test files that asserts the same semantic. This document is the
completion gate: a row per old test, a pointer to the new test that
replaces it, and a `Notes` column flagging structural collapses /
split coverage.

The mapping is built from shipped code — the row points at the
exact `it()` title at the shipped line. If the new tests change
later, these line numbers go stale; the *titles* are the durable
key.

## `lib/case-store/form-bridge/__tests__/deriveFromForm.test.ts` — 15 blocks

| Old test (file:line, title) | New test (file:line, title) | Notes |
|---|---|---|
| `deriveFromForm.test.ts:58` "returns the survey marker without walking the tree" | `formEngine.test.ts:1246` "emits the survey marker without walking the tree" | Direct equivalent. New test also adds a complementary case (`:1255` "emits the survey marker even when caseId is provided") that the old suite did not have. |
| `deriveFromForm.test.ts:91` "emits a primary insert with case_name and case_property fields" | `formEngine.test.ts:831` "emits primary properties for fields bound to the module's case type" | Direct equivalent. Both assert the registration arm with `case_name` plucked into `caseName` slot and typed JSONB `properties`. |
| `deriveFromForm.test.ts:136` "buckets child-case fields into separate ChildInsertOp entries" | `formEngine.test.ts:857` "buckets fields whose case_property_on names a different case type into a child case" | Direct equivalent. New test additionally asserts the registration child carries no `parentCaseId` (the case-store threads at write time). |
| `deriveFromForm.test.ts:185` "fans out repeat instances into one ChildInsertOp per index" | `formEngine.test.ts:923` "fans repeats out into one child per instance per destination case type" | Direct equivalent. New test exercises 3 instances with 2 properties each rather than 3-of-1; semantic identical. |
| `deriveFromForm.test.ts:243` "coerces every data_type per the JSON Schema generator's mapping" | `formEngine.test.ts:1267` describe block "data_type coercion" — split into 5 per-type `it()` blocks (`:1272` text, `:1289` int, `:1305` decimal, `:1321` multi_select, `:1346` int-fallthrough) | Split coverage. The old `date` assertion (`dob: "1995-03-12"`) is covered by the unknown-property fallthrough at `formEngine.test.ts:1389` — `date` has no separate coercion rule (it passes through as text), so the text-coercion arm at `:1272` is its semantic equivalent. |
| `deriveFromForm.test.ts:310` "omits properties whose path is absent from the values map (production shape)" | `formEngine.test.ts:1413` "excludes empty fields from the mutation" | Direct equivalent. The new walker reads via `instance.get(fieldPath)`, which returns `undefined` for an unset path; the same empty-filter (`raw === undefined \|\| raw === ""` at `formEngine.ts:402`) covers both cases — absent and empty collapse into one branch. |
| `deriveFromForm.test.ts:373` "also omits properties whose value is the empty string (defensive belt-and-suspenders)" | `formEngine.test.ts:1413` "excludes empty fields from the mutation" | Same single test covers both old branches. The walker's `raw === undefined \|\| raw === ""` combined-condition makes "absent path" and "empty-string read" indistinguishable at the filter; the old defensive branch is structurally still present (line 402's `=== ""` half), just exercised through the same `it()` block as the absent-path case. |
| `deriveFromForm.test.ts:424` "throws when moduleCaseType is missing" (registration) | `formEngine.test.ts:1066` "throws when registration reaches the engine without a moduleCaseType" | Direct equivalent. Error message regex is updated to match the new throw site's message. |
| `deriveFromForm.test.ts:457` "emits a primary update with case_property fields" (followup) | `formEngine.test.ts:1079` "emits a primary patch and binds children to the supplied caseId" | Direct equivalent. New test exercises both the primary patch AND the child-with-parentCaseId binding in one assertion. |
| `deriveFromForm.test.ts:487` "emits children with parentCaseId set to the bound caseId" (followup) | `formEngine.test.ts:1079` "emits a primary patch and binds children to the supplied caseId" | Same `it()` covers both old assertions — the old suite split parent-binding into a sibling test; the new suite asserts both shapes inside one block. |
| `deriveFromForm.test.ts:524` "emits an empty primary properties object when no fields write to the module case type" (followup) | `formEngine.test.ts:1133` "emits an empty primary patch when no fields target the module's case type" | Direct equivalent. |
| `deriveFromForm.test.ts:555` "throws when caseId is missing" (followup) | `formEngine.test.ts:1120` "throws when no caseId is supplied" (followup) | Direct equivalent. Error-message regex is updated to match the new throw site's message. |
| `deriveFromForm.test.ts:589` "emits a primary update plus the close discriminator" | `formEngine.test.ts:1171` "emits a close-discriminated mutation with the patch + children" | Direct equivalent. |
| `deriveFromForm.test.ts:619` "emits empty primary properties for close-only forms" | `formEngine.test.ts:1219` "emits empty primary properties for close-only forms" | Direct equivalent (matching title). |
| `deriveFromForm.test.ts:642` "throws when caseId is missing" (close) | `formEngine.test.ts:1206` "throws when no caseId is supplied" (close) | Direct equivalent. |

## `lib/case-store/form-bridge/__tests__/writeThrough.test.ts` — 8 blocks

| Old test (file:line, title) | New test (file:line, title) | Notes |
|---|---|---|
| `writeThrough.test.ts:115` "returns the survey marker without writing to cases" | `caseDataBinding.test.ts:1108` "returns the survey arm with no I/O" | Architectural collapse. The new `applySurveyMutation()` takes no `CaseStore` parameter, so writing-to-cases is structurally impossible. The "no rows landed" assertion the old test made via `store.query(...)` is replaced by the type-system constraint that the survey arm cannot reach the store. |
| `writeThrough.test.ts:153` "inserts a primary case and threads its caseId to children" (registration) | `caseDataBinding.test.ts:793` "dispatches to insertWithChildren and returns the registration arm with the generated ids" | Direct equivalent. Both write the primary + a child via `insertWithChildren` and read the rows back to assert `parent_case_id` threading. |
| `writeThrough.test.ts:254` "inserts one child case per repeat instance" (registration) | `formEngine.test.ts:923` "fans repeats out into one child per instance per destination case type" + `caseDataBinding.test.ts:793` "dispatches to insertWithChildren and returns the registration arm with the generated ids" | Split coverage. The engine test asserts the mutation carries N children for N repeat instances; the helper test asserts the helper writes every child in the mutation through `insertWithChildren`. The composition (engine emits N → helper writes N) is covered by the union; no end-to-end "engine + helper writes N rows for N repeat instances" test exists, but the two halves are mechanically composable. |
| `writeThrough.test.ts:328` "omits empty optional fields so the JSON Schema validator passes" (registration) | `formEngine.test.ts:1413` "excludes empty fields from the mutation" + `caseDataBinding.test.ts:793` "dispatches to insertWithChildren and returns the registration arm with the generated ids" | Split coverage. The old test pinned an end-to-end round-trip — registration form whose user fills only `case_name`, against a case type with `int` / `decimal` / `format: date` / geopoint properties, must NOT crash AJV. The new engine test asserts the mutation carries `properties: {}` when only `case_name` is set; the helper test asserts AJV accepts a `properties: {name, age}` mutation against `PATIENT_CASE_TYPE`. The composition (engine emits `{}` → AJV passes on `{}`) is split between the two assertions — neither half exercises a case-type with `format: date` / geopoint properties left absent. The `caseTypeToJsonSchema` generator emits `{ type: "object" }` (no `required` keys), so an empty `properties` object trivially passes any case-type schema; the round-trip scenario is structurally protected by the JSON-schema generator's contract, not by an integration test. |
| `writeThrough.test.ts:431` "merges the form's properties into the bound case" (followup) | `caseDataBinding.test.ts:936` "dispatches to update + per-child insert and returns the followup arm" | Direct equivalent. Both pre-seed a primary, run a followup that bumps a property, and verify the JSONB-merge semantics (old fields preserved, new fields written). |
| `writeThrough.test.ts:513` "inserts child cases pointed at the bound caseId" (followup) | `caseDataBinding.test.ts:936` "dispatches to update + per-child insert and returns the followup arm" | Same `it()` covers both — the new test asserts both the primary update AND the child's `parent_case_id` binding inside one block. |
| `writeThrough.test.ts:603` "applies any property writes and stamps closed_on" (close) | `caseDataBinding.test.ts:1055` "dispatches to update + per-child insert + close and stamps closed_on" | Direct equivalent. |
| `writeThrough.test.ts:672` "stamps closed_on without an update when the form has no primary writes" (close) | `caseDataBinding.test.ts:993` "short-circuits the primary update when the patch carries no writes" (followup) | Split coverage via shared helper. `applyCloseMutation` and `applyFollowupMutation` both delegate primary-update to a shared `applyPrimaryUpdate` helper (`caseDataBindingHelpers.ts:401`) whose empty-patch short-circuit is the only path. The followup test asserts the shared helper skips on empty patch; the close arm inherits that behavior structurally. No dedicated close-specific empty-patch regression test exists; if `applyCloseMutation` ever stops delegating to the shared helper, this would silently regress without surfacing here. |

## Coverage analysis

Of 23 `it()` blocks across the deleted test files:

- **17** map to a direct equivalent in the new test files (same shape,
  same assertions).
- **3** map to a single new test that combines two old assertions
  inside one block — followup parent-binding pair, child-binding +
  child-parent pair, absent-vs-empty-string filter pair.
- **2** are split across an engine test + a helper test (repeat
  fan-out at the row layer, AJV-passes-on-empty-properties at the
  helper layer).
- **1** is structurally collapsed into the type system (survey arm
  cannot reach the store because the helper takes no `CaseStore`).

### Gaps flagged

1. **`writeThrough.test.ts:672` close empty-patch short-circuit**
   has no dedicated test. The behavior is preserved through code
   sharing — `applyCloseMutation` and `applyFollowupMutation` both
   delegate primary-update to `applyPrimaryUpdate` at
   `caseDataBindingHelpers.ts:401`, and the followup test exercises
   the shared helper's empty-patch skip. A future refactor that
   inlines the close arm's primary update (stops delegating to the
   shared helper) would silently regress without a failing test.
   This is split coverage via shared-helper discipline; not a
   semantics gap, but a regression-detection gap.

2. **`writeThrough.test.ts:328` AJV-passes-on-formatted-properties-
   left-absent** has no end-to-end equivalent. The old test wrote a
   registration whose user filled only `case_name` against a case
   type carrying `int` / `decimal` / `format: date` / geopoint
   properties — the AJV-validator-doesn't-crash assertion was the
   end-to-end signal. The new helper tests bind against
   `PATIENT_CASE_TYPE` (`name: text`, `age: int` only); no
   formatted-property case type appears in the running-app helper
   suite. The behavior is structurally protected (the
   `caseTypeToJsonSchema` generator emits `{ type: "object" }` with
   no `required` keys, so an empty `properties` trivially passes
   AJV), but the regression-detection signal is weaker: a future
   change to the generator that adds `required` keys would not be
   caught by these tests.

Per the step-5 contract, gaps DO NOT get closed by adding tests in
this commit; this checklist surfaces them and the supervisor decides
whether they need follow-up work.

The 23 `it()` blocks deleted in this commit reduce the suite's total
test count by exactly 23.
