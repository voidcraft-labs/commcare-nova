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
| `deriveFromForm.test.ts:58` "returns the survey marker without walking the tree" | `formEngine.test.ts:1264` "emits the survey marker without walking the tree" | Direct equivalent. New test also adds a complementary case (`:1273` "emits the survey marker even when caseId is provided") that the old suite did not have. |
| `deriveFromForm.test.ts:91` "emits a primary insert with case_name and case_property fields" | `formEngine.test.ts:849` "emits primary properties for fields bound to the module's case type" | Direct equivalent. Both assert the registration arm with `case_name` plucked into `caseName` slot and typed JSONB `properties`. |
| `deriveFromForm.test.ts:136` "buckets child-case fields into separate ChildInsertOp entries" | `formEngine.test.ts:875` "buckets fields whose case_property_on names a different case type into a child case" | Direct equivalent. New test additionally asserts the registration child carries no `parentCaseId` (the case-store threads at write time). |
| `deriveFromForm.test.ts:185` "fans out repeat instances into one ChildInsertOp per index" | `formEngine.test.ts:941` "fans repeats out into one child per instance per destination case type" | Direct equivalent. New test exercises 3 instances with 2 properties each rather than 3-of-1; semantic identical. |
| `deriveFromForm.test.ts:243` "coerces every data_type per the JSON Schema generator's mapping" | `formEngine.test.ts:1285` describe block "data_type coercion" — split into per-type `it()` blocks: `:1290` text, `:1307` int, `:1323` decimal, `:1339` multi_select, `:1364` int-fallthrough, `:1387` date, `:1403` datetime, `:1425` time, `:1445` geopoint, `:1471` single_select | Split coverage. Each `data_type` arm gets its own per-type `it()` block, assertting the per-type contract verbatim against the coercion layer's switch. The 5 new string-passthrough tests (date/datetime/time/geopoint/single_select) close the data_type coercion blind spot the original mapping flagged — every CCHQ data type carried by Nova's authoring layer now has an asserted coercion contract. |
| `deriveFromForm.test.ts:310` "omits properties whose path is absent from the values map (production shape)" | `formEngine.test.ts:1545` "excludes empty fields from the mutation" | Direct equivalent. The new walker reads via `instance.get(fieldPath)`, which returns `undefined` for an unset path; the same empty-filter (`raw === undefined \|\| raw === ""` at `formEngine.ts:402`) covers both cases — absent and empty collapse into one branch. |
| `deriveFromForm.test.ts:373` "also omits properties whose value is the empty string (defensive belt-and-suspenders)" | `formEngine.test.ts:1545` "excludes empty fields from the mutation" | Same single test covers both old branches. The walker's `raw === undefined \|\| raw === ""` combined-condition makes "absent path" and "empty-string read" indistinguishable at the filter; the old defensive branch is structurally still present (line 402's `=== ""` half), just exercised through the same `it()` block as the absent-path case. |
| `deriveFromForm.test.ts:424` "throws when moduleCaseType is missing" (registration) | `formEngine.test.ts:1084` "throws when registration reaches the engine without a moduleCaseType" | Direct equivalent. Error message regex is updated to match the new throw site's message. |
| `deriveFromForm.test.ts:457` "emits a primary update with case_property fields" (followup) | `formEngine.test.ts:1097` "emits a primary patch and binds children to the supplied caseId" | Direct equivalent. New test exercises both the primary patch AND the child-with-parentCaseId binding in one assertion. |
| `deriveFromForm.test.ts:487` "emits children with parentCaseId set to the bound caseId" (followup) | `formEngine.test.ts:1097` "emits a primary patch and binds children to the supplied caseId" | Same `it()` covers both old assertions — the old suite split parent-binding into a sibling test; the new suite asserts both shapes inside one block. |
| `deriveFromForm.test.ts:524` "emits an empty primary properties object when no fields write to the module case type" (followup) | `formEngine.test.ts:1151` "emits an empty primary patch when no fields target the module's case type" | Direct equivalent. |
| `deriveFromForm.test.ts:555` "throws when caseId is missing" (followup) | `formEngine.test.ts:1138` "throws when no caseId is supplied" (followup) | Direct equivalent. Error-message regex is updated to match the new throw site's message. |
| `deriveFromForm.test.ts:589` "emits a primary update plus the close discriminator" | `formEngine.test.ts:1189` "emits a close-discriminated mutation with the patch + children" | Direct equivalent. |
| `deriveFromForm.test.ts:619` "emits empty primary properties for close-only forms" | `formEngine.test.ts:1237` "emits empty primary properties for close-only forms" | Direct equivalent (matching title). |
| `deriveFromForm.test.ts:642` "throws when caseId is missing" (close) | `formEngine.test.ts:1224` "throws when no caseId is supplied" (close) | Direct equivalent. |

## `lib/case-store/form-bridge/__tests__/writeThrough.test.ts` — 8 blocks

| Old test (file:line, title) | New test (file:line, title) | Notes |
|---|---|---|
| `writeThrough.test.ts:115` "returns the survey marker without writing to cases" | `caseDataBinding.test.ts:1256` "returns the survey arm with no I/O" | Architectural collapse. The new `applySurveyMutation()` takes no `CaseStore` parameter, so writing-to-cases is structurally impossible. The "no rows landed" assertion the old test made via `store.query(...)` is replaced by the type-system constraint that the survey arm cannot reach the store. |
| `writeThrough.test.ts:153` "inserts a primary case and threads its caseId to children" (registration) | `caseDataBinding.test.ts:822` "dispatches to insertWithChildren and returns the registration arm with the generated ids" | Direct equivalent. Both write the primary + a child via `insertWithChildren` and read the rows back to assert `parent_case_id` threading. |
| `writeThrough.test.ts:254` "inserts one child case per repeat instance" (registration) | `formEngine.test.ts:941` "fans repeats out into one child per instance per destination case type" + `caseDataBinding.test.ts:822` "dispatches to insertWithChildren and returns the registration arm with the generated ids" | Split coverage. The engine test asserts the mutation carries N children for N repeat instances; the helper test asserts the helper writes every child in the mutation through `insertWithChildren`. The composition (engine emits N → helper writes N) is covered by the union; no end-to-end "engine + helper writes N rows for N repeat instances" test exists, but the two halves are mechanically composable. |
| `writeThrough.test.ts:328` "omits empty optional fields so the JSON Schema validator passes" (registration) | `caseDataBinding.test.ts:910` "admits an empty properties document against a case-type with formatted properties (AJV does not reject)" | Direct equivalent. The new test seeds a case-type carrying `format: date` / `format: time` / `format: date-time` / geopoint / `integer` / `number` properties, runs `applyRegistrationMutation` with a `properties: {}` mutation, and asserts the row lands with an empty JSONB document. Pins the `caseTypeToJsonSchema`-emits-no-`required`-keys invariant the old test exercised by side effect. |
| `writeThrough.test.ts:431` "merges the form's properties into the bound case" (followup) | `caseDataBinding.test.ts:1012` "dispatches to update + per-child insert and returns the followup arm" | Direct equivalent. Both pre-seed a primary, run a followup that bumps a property, and verify the JSONB-merge semantics (old fields preserved, new fields written). |
| `writeThrough.test.ts:513` "inserts child cases pointed at the bound caseId" (followup) | `caseDataBinding.test.ts:1012` "dispatches to update + per-child insert and returns the followup arm" | Same `it()` covers both — the new test asserts both the primary update AND the child's `parent_case_id` binding inside one block. |
| `writeThrough.test.ts:603` "applies any property writes and stamps closed_on" (close) | `caseDataBinding.test.ts:1131` "dispatches to update + per-child insert + close and stamps closed_on" | Direct equivalent. |
| `writeThrough.test.ts:672` "stamps closed_on without an update when the form has no primary writes" (close) | `caseDataBinding.test.ts:1178` "skips the primary UPDATE call when the patch carries no writes but still stamps closed_on" | Direct equivalent. The new test parallels the followup empty-patch test (`:1069`) but uses a `vi.spyOn(store, "update")` regression detector instead of a `modified_on` snapshot — `PostgresCaseStore.close()` stamps `modified_on` itself, so on the close arm a timestamp comparison is unreliable. The spy fires only when `applyPrimaryUpdate` invokes `store.update` (close's own write goes through a direct `db.updateTable` chain), so `expect(updateSpy).not.toHaveBeenCalled()` is the durable detector. Pins the close arm against a future refactor that stops delegating to the shared `applyPrimaryUpdate` helper. |

## Coverage analysis

Of 23 `it()` blocks across the deleted test files:

- **18** map to a direct equivalent in the new test files (same shape,
  same assertions). The 3 new tests landed in this commit (close
  empty-patch, AJV-passes-on-empty-document-against-formatted-props,
  and 5 string-passthrough coercion tests folded into the existing
  data_type coercion block) bring the previously split-coverage
  rows up to direct-equivalent status.
- **3** map to a single new test that combines two old assertions
  inside one block — followup parent-binding pair, child-binding +
  child-parent pair, absent-vs-empty-string filter pair.
- **1** is split across an engine test + a helper test (repeat
  fan-out at the row layer).
- **1** is structurally collapsed into the type system (survey arm
  cannot reach the store because the helper takes no `CaseStore`).

### Gap closures

Three semantics gaps surfaced during the initial mapping; all three
closed in this commit by adding the explicit assertions the original
mapping had folded into structural protection.

1. **Close empty-patch short-circuit** — the deleted
   `writeThrough.test.ts:672` exercised the close arm's empty-patch
   branch end-to-end; the original new-test set inherited the
   behavior structurally via the shared `applyPrimaryUpdate` helper
   without a dedicated assertion. Closed by the new test at
   `caseDataBinding.test.ts:1178` "skips the primary UPDATE call
   when the patch carries no writes but still stamps closed_on".
   The detector is a `vi.spyOn(store, "update")` rather than the
   `modified_on` snapshot the followup test uses — `close()`
   stamps `modified_on` itself, so a timestamp comparison can't
   distinguish "the empty UPDATE was skipped" from "UPDATE ran +
   close ran on top". `close()` writes directly via
   `db.updateTable(...)` (not through the public `update()`
   method), so the spy fires only on the shared-helper UPDATE
   path. A future refactor that inlines the close arm's primary
   update now surfaces a failing test, not a silent regression.

2. **AJV passes on an empty `properties` document against formatted
   properties** — the deleted `writeThrough.test.ts:328` asserted
   the round-trip end-to-end against a case-type carrying
   `format: date` / geopoint / numeric properties. The original
   new-test set bound only against `PATIENT_CASE_TYPE` (`name: text`
   + `age: int`), so the "AJV doesn't crash on `format: date` with
   the dob property absent" signal had no explicit coverage. Closed
   by the new test at `caseDataBinding.test.ts:910` "admits an empty
   properties document against a case-type with formatted properties
   (AJV does not reject)" — drives `applyRegistrationMutation` with
   `properties: {}` against a new `FORMATTED_PROPS_CASE_TYPE` fixture
   that declares every formatted-property data type. A future
   `caseTypeToJsonSchema` change that adds `required` keys now
   surfaces a failing test.

3. **Per-`data_type` coercion blind spot** — the deleted
   `deriveFromForm.test.ts:243` was a single broad test exercising
   text / int / decimal / multi_select / date in one assertion. The
   original new-test set split it into 5 per-type `it()` blocks
   (text / int / decimal / multi_select / int-fallthrough), but
   `date` / `datetime` / `time` / `geopoint` / `single_select` —
   five string-passthrough data types — had no per-type asserted
   coverage. Closed by 5 new `it()` blocks in the
   `formEngine.test.ts:1285` "data_type coercion" describe block
   (`:1387` date, `:1403` datetime, `:1425` time, `:1445` geopoint,
   `:1471` single_select), each pinning the per-type contract
   verbatim against the coercion layer's switch arm. Every Nova-
   authoring data type now has an explicit coercion test; a future
   coercion-layer change that accidentally unboxes one of them
   surfaces here.

The 23 `it()` blocks deleted in this commit reduce the suite's
total test count by 23. The 7 new tests added in this commit (1
close empty-patch + 1 AJV-formatted-props + 5 per-type coercion)
add 7 back. Net delta: −16.
