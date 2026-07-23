# PR-01: Domain & expression foundations I (display conditions, case operations, lookup-table vocabulary)

> [!WARNING]
> **Execution superseded.** This document is retained as historical evidence and rationale,
> not as an implementation checklist. Execute from the living
> [complex-app roadmap](../complex-app-roadmap.md) and its current slice contracts instead.

## 2026-07-21 rebaseline

Execution of this legacy PR is now split across **S02, S03, S04, and S05**. Preserve the
verified HQ emission facts below, but re-derive implementation boundaries from those living
slices and the current Postgres architecture.

- Lookup tables and columns have stable UUID identity; tags, names, and labels are mutable
  projections. Stored expressions reference UUIDs rather than mutable text.
- Reference governance uses exact edges maintained in the same transaction as accepted app
  mutations. Table-aware commit and export validation receives an authoritative,
  Project-scoped external context and fails closed when that context is unavailable.
- Cross-Project app moves are blocked while the app references Project-scoped resources;
  cloning or remapping is a separate future workflow.
- Case-operation conditions, targets, and values are evaluated from one pre-submission
  snapshot before any effects are applied. Repeat correlation, operation ordering, target
  type checks, and retype behavior must be settled by the applicable slice before activation.
- **S04 outcome:** operations use the rolling-compatible
  `updateForm.caseOperationChange` extension rather than new top-level mutation
  discriminators; multiple operations may intentionally target the same known case and run
  in declared order. An authored create key may come from a singular field for a singular
  create or from the exact repeat iteration of a repeated create; singular/cross-repeat
  reuse is rejected. The key is not a raw CommCare id: S04's frozen shared helper derives
  `nova-case-v1:<UUIDv5(app,form,operation,type)>:<exact-key>`, rejects empty/over-205
  keys, and performs no normalization. Retries and duplicate values for one definition
  intentionally merge; separate operations remain separate even when they reuse a field.
  A repeated authored-key create cannot feed or potentially alias a later non-create under
  the same repeated execution ancestor, because Core's iteration-major order and HQ's
  per-case create sort would disagree; provably distinct targets and independent root
  sibling repeats remain legal.
  A keyed identity is type-stable. The order proof also rejects differently-typed runtime
  aliases after a create/retype and permits repeated retype only for an exact correlated
  generated-UUID create. That proof includes the final ordinary form actions: primary
  property writes and child-case parent links require the session case to retain the
  module type, while a write-free close action is type-agnostic. The proof retains
  transition history, so a conditional restore cannot hide the non-restored branch.
  The resulting identity remains an opaque CommCare string; S06 owns the full UUID
  storage/FK/parser/ordering/path migration and audit before activation. Conditional create/retype facts
  guard every later identity/type consumer. `acting-user` and `unowned` are explicit
  owner-value leaves. Persisted values use directional storage compatibility across every
  branch, not symmetric predicate comparison: multi-select arrays cannot flow through
  scalar concat/coercion, null is not an implicit clear, and `concat` is the explicit
  boolean-to-text boundary. `caseOperationText.ts` is the one evaluated-value contract
  for create name, rename, and effective owner: remove Java-regex XML boundary
  whitespace, preserve internal whitespace, require nonblank, and cap the normalized
  result at 255 UTF-16 code units. S04's wire and S06's executor both consume it.
  Retype planning distinguishes storage-atomic `safe` from
  device-parity `wirePortable`; authored operations admit only exact-schema retypes with
  no conversion or parking because CommCare changes `case_type` without reshaping values.
- New AST arms and mutation kinds remain carrier-gated and rolling-deploy compatible until
  every validator, emitter, preview consumer, and persistence boundary is ready.

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f1-…`,
`…f4-…`, `…f5-…` §2–3. Scope rulings in `docs/plans/2026-07-06-pr-execution-plan.md` apply.
Depends on **PR-02** (the lookup-table registry + rows store land first; this PR consumes
the registry snapshot type PR-02 exports — no stubs).*

**Goal.** All new blueprint vocabulary and expression machinery for wave 1: display
conditions on modules/forms, the case-operations list on forms, and lookup-table references
— fully type-checked, reference-indexed, rename-safe, and commit-gated. The new AST arms
necessarily land their arms in every exhaustive-switch consumer (including the Postgres
compiler, the on-device/CSQL emitters, instance accumulation, and the preview binding
switch — the compiler forces those files to change). What this PR does NOT ship is any
**module/form/table wire or preview behavior**: `displayCondition` and `caseOperations`
emit nothing and render nothing until PR-03/PR-04, and lookup-table references stay
validator-gated (un-emittable) until PR-03 activates them.

## What the user gets (via later PRs)

Menus/forms that show conditionally; forms that create/update/close/link other cases;
tables referenced from expressions and select options. This PR makes those states
*constructible and valid*; nothing renders yet.

## Verified contracts this PR relies on (do not re-derive)

- Menu/command relevancy exists on the wire (`commcare-hq/.../suite_xml/sections/menus.py::MenuContributor`);
  module conditions can never reference a case (`xpath.py::_ensure_no_case_references`);
  form conditions may reference the selected case only when every form in the module loads
  one (HQ's `module_uses_case` gate = Nova's `isCaseFirstModule`).
- A throwing relevancy takes down the whole menu screen in Web Apps
  (`commcare-core/.../MenuLoader.getMenuDisplayables` catch → screen-level error) — the
  reason every condition here is checker-gated and boolean-by-construction.
- `window_width` is real (`SessionInstanceBuilder::addMetadata` writes
  `session/context/window_width`; the node is ABSENT when the frontend sends none).
  **Absent-node comparison semantics (wire truth — the checker docs and PR-04's fold must
  mirror this exactly):** commcare-core unpacks an empty nodeset to the EMPTY STRING for
  general comparisons — so `eq(absent, '')` is TRUE, `neq(absent, x)` is TRUE for non-empty
  x — while NUMERIC ordering comparisons against an absent node are false (NaN). "Absent ⇒
  false" holds only for the ordering operators; equality follows empty-string semantics.
- Case blocks: every block needs `@case_id` (server `CaseGenerationException`);
  create-of-existing merges (client `acceptCreateOverwrites` true in all callers; server
  treats as update); `<create>` accepts only case_type/case_name/owner_id children; empty
  `<index>` target removes; an index-only block on a locally-absent case NPEs client-side
  (`CaseXmlParser.parse` index arm → `loadCase(errorIfMissing=false)` unguarded deref) —
  PR-03 closes it structurally; this PR's op shape keeps links pairable with an update facet.
- Server applies per-block actions in fixed order create→update→close→index regardless of
  XML order (`update_strategy.py::_apply_case_update` over `parser.py::CaseUpdate.__init__`
  construction order); client applies document order — PR-03 emits children in the server's
  order so both agree.
- Rename/re-type via update agree on both runtimes: client `updateCase` maps
  `case_name`→setName, `case_type`→setTypeId (`CaseXmlParser.java`); server maps the wire
  keys to case attributes via `casexml/.../parser.py::CaseActionBase.V2_PROPERTY_MAPPING`
  (`case_name`→`name`, `case_type`→`type`). (`category`/`state` do NOT agree — client-
  reserved, server-plain — and stay unconstructible.)
- Lookup tables: HQ model `LookupTable{tag ≤32 unique-per-domain immutable-on-PUT}` + rows
  with `sort_key`; wire `instance('item-list:tag')/{tag}_list/{tag}`; itemset contract
  (`XFormParser::parseItemset`): nodeset must be a path (predicates allowed); `<label ref>`
  and `<value ref>` must be path expressions — the parser does NOT forbid predicates on
  them, but Nova emits the canonical predicate-free relative refs; choices re-evaluate on
  prompt rebuild (answer-dependent filters are wire-viable). The saveToCase `case_id`
  mechanism (`Vellum/src/saveToCase.js` — a form node seeded `uuid()` used as the block's
  `@case_id`) is the authored-id precedent `idFrom` mirrors.

## Build

### 1. Schema slots (`lib/domain`)

- `moduleSchema.displayCondition?: Predicate`, `formSchema.displayCondition?: Predicate` —
  top-level optional slots (ride `updateModule`/`updateForm` clearable patches; `null`
  clears).
- `formSchema.caseOperations?: CaseOperation[]` — a uuid-keyed collection whose **execution
  sequence is `sort-by-(order, uuid)`** (fractional `order` keys, the columns/searchInputs
  house pattern; membership-array position is never authoritative):

```ts
CaseOperation = {
  uuid: Uuid, id: string,           // id: unique-per-form slug (identifierVerdicts rules)
  order?: string,                   // fractional sort key — execution + emission sequence
  action: "create" | "update" | "close",
  caseType: string,                 // catalog-declared
  target: CaseTarget,               // create ⇒ { kind: "new", idFrom?: Uuid }
  condition?: Predicate,
  forEach?: { repeat: Uuid },
  name?: ValueExpression,
  owner?: ValueExpression,
  rename?: ValueExpression,
  retype?: string,
  writes?: Array<{ property: string, value: ValueExpression, condition?: Predicate }>,
  links?: Array<{ identifier: string, targetType: string,
                  target: CaseTarget | null, relationship: "child" | "extension" }>,
}
CaseTarget =
  | { kind: "new", idFrom?: Uuid }  // create only. idFrom = a form-local string key;
                                    //   S04 namespaces app/form/op/type + exact value.
                                    //   absent ⇒ generated uuid.
  | { kind: "op", opUuid: Uuid }    // an EARLIER (by sorted sequence) create op's case
  | { kind: "session" }             // case-first modules only, module's own type
  | { kind: "expression", expr: ValueExpression }
```

**Per-action facet legality (the matrix — validator-enforced, exhaustive):**

| facet | create | update | close |
|---|---|---|---|
| `name` | required | — | — |
| `rename` / `retype` | — | ✓ | — |
| `owner` | ✓ (default: acting user) | ✓ (ownership transfer) | — |
| `writes` | ✓ | ✓ | ✓ (final writes) |
| `links` | ✓ | ✓ | — (unlink-then-close is two ops) |
| `condition` / `forEach` | ✓ | ✓ | ✓ |
| `target` kinds | `new` only | `op`/`session`/`expression` | `op`/`session`/`expression` |
| `links[].target` kinds | `op`/`session`/`expression`/`null`(unlink) | same | — |

- Select kinds gain `options_source?: { tableId, valueColumn, labelColumn,
  filter?: Predicate }`. **Both `options` and `options_source` may coexist in the doc**
  (deliberate — the editor retains inline options across mode switches); `options_source`
  takes precedence at every consumer (emission, preview, SA summaries). No schema refine;
  the validator gates only an *invalid* `options_source`, never mere coexistence.

### 2. AST arms (`lib/domain/predicate` + `lib/domain/xpath`) — ONE sweep

New arms, each through EVERY exhaustive-switch consumer. The TypeScript compiler enumerates
them (never-typed defaults); the known set, verified in-repo: `lib/domain/predicate/walk.ts`,
`rewrite.ts`, `typeChecker.ts`, `slotConstraints.ts`-derived editor constraints;
`lib/case-store/sql/compileTerm.ts`, `compilePredicate.ts`, **`compileExpression.ts`**;
`lib/commcare/predicate/termEmitter.ts`, **`lib/commcare/expression/onDeviceEmitter.ts`**,
**`lib/commcare/expression/csqlEmitter.ts`**, `lib/commcare/predicate/csqlHoist.ts`,
`predicate/instances.ts::addTermInstance`, `suite/case-search/xpathQuery.ts`;
`lib/preview/engine/runtimeBindings.ts`; `lib/doc/referenceIndex.ts`,
`caseTypeRetirement.ts`. (If the build surfaces further sites, they are in scope — the
compiler is the authority, this list is the map.)

- `case-count` (ValueExpression): `{ caseType, where?: Predicate }`. On-device:
  `count(instance('casedb')/casedb/case[@case_type='T'][@status='open'][where])`;
  **Postgres: the compile arm lands here** (an `eb`-level scoped COUNT subquery over the
  tenant + type + open filter — PR-04 adds the server-action/store *entry point* that
  invokes it); CSQL: representability error.
- `table-lookup` (ValueExpression): `{ tableId, column, where: Predicate }` — first-match
  by row order on BOTH targets, **pinned structurally, not by coercion**: JavaRosa has NO
  XPath-1.0 first-node coercion — a scalar use of a multi-node path throws
  (`javarosa/.../XPathNodeset.java::unpack`: size > 1 → `XPathTypeMismatchException`, which
  in menu relevancy kills the whole menu screen). The on-device lowering therefore carries
  an explicit positional predicate — `…/{tag}[where][1]/col` (JavaRosa numeric predicates
  are position matches: `EvaluationContext`'s predicate loop, `passed = (intVal ==
  positionContext[predIndex])`) — and SQL mirrors it with `ORDER BY row order LIMIT 1`.
  PR-03's emitter and PR-04's fold both cite this rule.
- `column` (Term): `{ name }` — a lookup-table column reference, **legal only inside table
  scope** (`table-lookup.where`, `options_source.filter`); checker resolves the type from
  the PR-02 registry snapshot's column `data_type`; on-device prints the relative child
  element path (`name` relative to the row node — matching the fixture body); SQL compiles
  to the row's JSONB value accessor. Without this arm those predicates would be unwritable.
- `id-of` (ValueExpression): `{ opUuid }` — the concrete case id of an earlier create op.
  **Legal only in non-target op expression slots** (owner/name/writes/condition of LATER
  ops). A target or link-target expression rejects `id-of` anywhere in its tree; use the
  first-class `{ kind: "op", opUuid }` target so a fresh case is not incorrectly filtered
  through the immutable pre-submission casedb.
  An `idFrom` field contains only the raw key, not this namespaced concrete identity, so
  ordinary field references are never an alias for `id-of`.
- `field` (Term): `{ uuid }` — a form field's live value. Legal ONLY in form-scoped
  predicate contexts (`options_source.filter`, op expressions); on-device: the field's
  path; Postgres: a bound parameter supplied at query time.
- **Owner vocabulary** (consumed by ops now; PR-09's `LocationRef` extends it):
  `acting-user` (ValueExpression) — on-device `/data/meta/userID`-anchored (the meta block
  bind PR-03 wires); Postgres: the acting persona/user id; and `unowned` (ValueExpression)
  — the literal `'-'` sentinel (verified alive: `UNOWNED_EXTENSION_OWNER_ID`).
- `window_width` added to `SESSION_CONTEXT_FIELDS` (checker type number; absent-node
  semantics per the eq/ordering split in the verified contracts above — document that
  split, never a blanket absent⇒false). **Admission mechanism**: the shared enum admits it schema-wide; the
  TYPE CHECKER rejects it outside display-condition contexts (a per-context rule, the same
  mechanism as every other context restriction — schema-level admission is deliberately
  global).
- XPath parts-AST leaf `table-ref` (`lib/domain/xpath/ast.ts` + printer + Lezer bridge):
  authored AND PRINTED as **`#table/<tag>`** — an identity leaf, byte-exact round-trip like
  every other leaf; the domain printer NEVER emits wire vocabulary (quarantine intact).
  The wire expansion to `instance('item-list:<tag>')/{tag}_list/{tag}` is a NEW
  resolver-function branch in `lib/commcare/hashtags.ts`'s `rewriteHashtags` consumers
  (keyed on the `table` namespace, alongside the `#case/` resolver branch) — NOT an entry
  in the flat-prefix `EXPANSIONS` Map, which structurally cannot express it: the Map is
  `prefix + segments.join("/")`, and this expansion repeats the tag three times (the same
  reason the file excludes `#case/` from that Map). Landed here but **activated in PR-03**
  (see §6's gating). `#table` becomes a reserved namespace:
  `lib/domain/hashtagSegments.ts` + the reference config gain it, and a new validator rule
  makes a case type named `table` unconstructible going forward (introduce-gated — legacy
  docs carrying one keep validating; the namespace resolver prefers the reserved reading).

### 3. Check contexts (`typeChecker.ts`)

- `displayConditionContext(doc, module, level)` — admissibility (validator-enforced;
  the acceptance matrix test enumerates every row):

| arm | module level | form level (case-first) | form level (forms-first) |
|---|---|---|---|
| `literal`, date fns, `session-user`, `session-context` (incl. `window_width`) | ✓ | ✓ | ✓ |
| `table-lookup` (+ `column` inside it) | ✓ | ✓ | ✓ |
| `case-count` (+ `column`/`prop` inside its `where`) | ✓ | ✓ | ✗ — HQ's form_filter post-interpolation check (`menus.py`: `xpath_references_case(interpolated_xpath)` → `CaseXPathValidationError`) rejects ANY casedb reference in a form filter whose module doesn't guarantee a case; `case-count` lowers to `instance('casedb')…`, so forms-first form conditions must not carry it. Module filters are exempt (only the hashtag/dot check runs there). |
| `prop` (module's own type, own properties) | ✗ | ✓ | ✗ |
| `field`, `input`, `when-input-present`, `id-of`, `within-distance`, `unwrap-list` | ✗ | ✗ | ✗ |
| match modes | on-device set only (extend `matchModeOnDeviceCompatibility`) | same | same |

- `opExpressionContext(doc, form)`: form context — `field` refs, `id-of` (earlier ops),
  case refs per the form's reachable types, session terms, `table-lookup`, owner
  vocabulary; write values type-check directionally against every authoritative
  destination-property storage type and every branch. Target/link expressions further
  exclude `id-of` at any depth.
- `tableScope(tableDef)`: `column` refs against the snapshot's columns; plus `field`
  (options filter only), session terms, literals.

### 4. Registry snapshot plumbing (with PR-02) — ownership split, explicit

**PR-01 owns the entire validation side**: the gate/context signature change
(`mutationCommitVerdict` gains an optional `context.tables: LookupTableSnapshot[]` — the
ONE slot name both docs use), the threading through `evaluateCommit`/`validateBlueprintDeep`
to `tableScope` and the table findings, and every reference-dependent test. **From PR-02
(already landed) this PR consumes only**: the exported `LookupTableSnapshot` type
(`{ id, tag, name, columns: [{ name, label, data_type? }] }`), the gated read surface, and
the Firestore registry listener. Hydration per surface (wired here): the builder session
hydrates at load and live-updates from the listener; the chat route and MCP dispatch
hydrate per request server-side. Semantics: **fail-closed for introductions** — a batch introducing a reference to a table id absent from the
snapshot rejects (`TABLE_REFERENCE_UNKNOWN`, introduce-gated soundness, person-readable
"that table isn't in this Project (or the registry hasn't refreshed — retry)"); existing
docs' references are introduce-exempt as usual.

### 5. Mutations + reference index (`lib/doc`)

- Op mutations: `addCaseOperation` / `updateCaseOperation` / `removeCaseOperation` /
  `moveCaseOperation` (uuid + fractional order — `moveCaseOperation` re-keys `order`;
  the earlier-op rule re-validates on reorder).
- Registry entries (`referenceSlots.ts` — audit-test-forced) + extraction arms + rename
  cascades for: both `displayCondition`s, every op expression slot, op
  `caseType`/`retype`/`links[].targetType` (`t:` edges), op writes (`c:` edges),
  `forEach.repeat`/`target.opUuid`/`idFrom`/`id-of` (uuid edges), `options_source`
  (`lt:`/`ltc:` edges), `table-lookup`/`table-ref`/`column` carriers.
- Catalog chokepoints: op-creating surfaces prepend the chokepoint MUTATIONS —
  `declareCaseType` (idempotent) + one `addCaseProperty` per op-written property (the
  `scaffolds.ts::declareCaseTypeForField`/`caseTypeCatalogMutations` builder precedents;
  note `ensureCatalogProperty` is a reducer-internal appender covering FIELD writes only —
  op writes need the explicit mutations). Per-surface multiplayer test, the
  `multiplayerMerge` pattern.

### 6. Validator — codes, classes, repairs

All gating codes get `VALIDITY_CLASS_BY_CODE` rows + `legacyFindingRepairs` judgments:

- Display conditions: `MODULE_DISPLAY_CONDITION_TYPE_ERROR`,
  `FORM_DISPLAY_CONDITION_TYPE_ERROR`, `DISPLAY_CONDITION_ALWAYS_FALSE` (deep-simplified
  match-none) — soundness, `owner(...)` repairs.
- Ops: the §1 facet matrix; unknown/undeclared types/properties; reserved property names in
  writes (server `RESTRICTED_PROPERTIES` + `owner_id`/`location_id`/`hq_user_id`/
  `external_id`/`category`/`state`); reserved case types (`commcare-user`,
  `commcare-case-claim`, `user-owner-mapping-case` — claim unlocks in wave 2); `target:
  session` requires case-first + module type; `target: op` earlier-create-of-same-type;
  `retype` declared; `idFrom` form-local and singular with a singular create or located in
  the exact `forEach` repeat. The same key repeated in one operation intentionally merges;
  app/form/operation/type namespacing keeps peer operations distinct. Retype of a keyed
  identity is forbidden; a different AST that may alias an earlier transitioned id is
  rejected when its declared type differs, and repeated retype needs a correlated fresh
  generated create. `idFrom` is scalar text/single-select/hidden-string only; multi-select
  has no collision-free cross-runtime key serialization. Operation/retype/link target case
  types use the identifier grammar and Core's 255-character cap; link identifiers use XML
  grammar, per-operation uniqueness, and HQ's 255-character index-column cap. A retype
  that would convert or park JSON values remains rejected even when destination-required
  writes are present, because the device wire does neither. Op `id` slug rules.
- Tables: `TABLE_REFERENCE_UNKNOWN` (§4); `options_source` column/type checks. **Gating
  boundary with PR-03 (total-emitter invariant):** this PR does NOT green-light
  table-bearing wire, and the gate is **new code, not existing behavior** — the existing
  `fixtureReferenceNotModeled` rule scans printed field XPath for literal `instance('<id>')`
  calls (`validator/rules/field.ts::findUnmodeledInstanceIds`, a Lezer `FunctionName ===
  "instance"` walk) and can never see a `#table/<tag>` head, which prints as a hashtag.
  So this PR lands ONE temporary gating finding, `TABLE_EMISSION_NOT_ACTIVE`, covering
  EVERY table carrier: `options_source`, `table-lookup` expressions, AND `table-ref`
  leaves in field expression slots (a new scan arm over the parts-AST leaves — cheap,
  the reference index already extracts them). PR-03 deletes that finding in the same PR
  that makes the wire emittable (and narrows `FIXTURE_REFERENCE_NOT_MODELED` for
  raw-authored `instance('item-list:…')` text there too) — at no merge point can a valid
  doc reach an emitter that can't emit it (main auto-deploys).
- `#table`-reserved-namespace rule (§2).

### 7. `effectiveDisplayConditionForEmission` (`simplify.ts`)

Mirror of `effectiveFilterForEmission` — the single match-all ⇒ emit-nothing home;
consumed by PR-03/PR-04.

## Tests / acceptance

- The §3 admissibility matrix as an enumerated test (every arm × every context row).
- Op validator matrix (the §1 facet table, targets × actions × form types; reorder
  re-validation; `id-of` cycle rejection).
- Reference-index fuzz parity; rename cascades for op writes + table column identity.
- Gate tests per new code; introduce-only semantics proven for the introduce-gated ones.
- `npx tsx scripts/test-schema.ts` — the SA tool input schemas embed the predicate schemas
  and widen implicitly; the API-acceptance check must stay green in THIS PR.
- `npm run lint && npm run typecheck && npm test` clean. **Behavioral acceptance: no
  module/form displayCondition or caseOperation reaches any wire output or preview render
  (assert emitters/preview ignore the new slots); table-bearing docs cannot commit until
  PR-03 (the §6 gating).**

## Non-goals

Wire/preview activation (PR-03/PR-04), UI (PR-05), SA tool PARAMS + guidance (PR-06 — the
schemas widen implicitly here, the tools' new params land there), usercase/locations/
automations vocabulary (PR-09).

## Open choices (implementer)

- `links[].identifier` default: recommend `"parent"` (production convention), explicit in
  the UI.
- Code granularity for op findings (family code + details vs per-rule codes) — match the
  existing case-list rules' granularity.
