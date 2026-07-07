# PR-01: Domain & expression foundations I (display conditions, case operations, lookup-table vocabulary)

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
  `session/context/window_width`; the node is ABSENT when the frontend sends none —
  comparisons then false).
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
  | { kind: "new", idFrom?: Uuid }  // create only. idFrom = a form-local, non-repeat field
                                    //   whose value seeds @case_id (the saveToCase case_id
                                    //   mechanism); absent ⇒ generated uuid.
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
  by row order on BOTH targets (XPath first node; SQL `ORDER BY row order LIMIT 1`).
- `column` (Term): `{ name }` — a lookup-table column reference, **legal only inside table
  scope** (`table-lookup.where`, `options_source.filter`); checker resolves the type from
  the PR-02 registry snapshot's column `data_type`; on-device prints the relative child
  element path (`name` relative to the row node — matching the fixture body); SQL compiles
  to the row's JSONB value accessor. Without this arm those predicates would be unwritable.
- `id-of` (ValueExpression): `{ opUuid }` — the case id of an earlier create op. **Legal
  only in op expression slots** (owner/name/writes/links/condition of LATER ops). Field
  expressions never carry it: to reference a created id from fields, author an `idFrom`
  field — the id then lives in the form and ordinary field refs reach it.
- `field` (Term): `{ uuid }` — a form field's live value. Legal ONLY in form-scoped
  predicate contexts (`options_source.filter`, op expressions); on-device: the field's
  path; Postgres: a bound parameter supplied at query time.
- **Owner vocabulary** (consumed by ops now; PR-09's `LocationRef` extends it):
  `acting-user` (ValueExpression) — on-device `/data/meta/userID`-anchored (the meta block
  bind PR-03 wires); Postgres: the acting persona/user id; and `unowned` (ValueExpression)
  — the literal `'-'` sentinel (verified alive: `UNOWNED_EXTENSION_OWNER_ID`).
- `window_width` added to `SESSION_CONTEXT_FIELDS` (checker type number; absent-node ⇒
  false documented). **Admission mechanism**: the shared enum admits it schema-wide; the
  TYPE CHECKER rejects it outside display-condition contexts (a per-context rule, the same
  mechanism as every other context restriction — schema-level admission is deliberately
  global).
- XPath parts-AST leaf `table-ref` (`lib/domain/xpath/ast.ts` + printer + Lezer bridge):
  authored AND PRINTED as **`#table/<tag>`** — an identity leaf, byte-exact round-trip like
  every other leaf; the domain printer NEVER emits wire vocabulary (quarantine intact).
  The wire expansion to `instance('item-list:<tag>')/{tag}_list/{tag}` is a NEW entry in
  `lib/commcare/hashtags.ts`'s expansion table (the same seam `#user/` uses), landed here
  but **activated in PR-03** (see §5's gating). `#table` becomes a reserved namespace:
  `lib/domain/hashtagSegments.ts` + the reference config gain it, and a new validator rule
  makes a case type named `table` unconstructible going forward (introduce-gated — legacy
  docs carrying one keep validating; the namespace resolver prefers the reserved reading).

### 3. Check contexts (`typeChecker.ts`)

- `displayConditionContext(doc, module, level)` — admissibility (validator-enforced;
  the acceptance matrix test enumerates every row):

| arm | module level | form level (case-first) | form level (forms-first) |
|---|---|---|---|
| `literal`, date fns, `session-user`, `session-context` (incl. `window_width`) | ✓ | ✓ | ✓ |
| `case-count`, `table-lookup` (+ `column` inside them) | ✓ | ✓ | ✓ |
| `prop` (module's own type, own properties) | ✗ | ✓ | ✗ |
| `field`, `input`, `when-input-present`, `id-of`, `within-distance`, `unwrap-list` | ✗ | ✗ | ✗ |
| match modes | on-device set only (extend `matchModeOnDeviceCompatibility`) | same | same |

- `opExpressionContext(doc, form)`: form context — `field` refs, `id-of` (earlier ops),
  case refs per the form's reachable types, session terms, `table-lookup`, owner
  vocabulary; write values type-check against the destination property.
- `tableScope(tableDef)`: `column` refs against the snapshot's columns; plus `field`
  (options filter only), session terms, literals.

### 4. Registry snapshot plumbing (with PR-02)

The commit gate stays a pure function: `mutationCommitVerdict` gains an optional
`context.tables: LookupTableSnapshot[]` (shape, exported by PR-02:
`{ id, tag, name, columns: [{ name, label, data_type? }] }`). Hydration per surface:
the builder session hydrates at load and live-updates from the PR-02 registry listener;
the chat route and MCP dispatch hydrate per request server-side. Semantics: **fail-closed
for introductions** — a batch introducing a reference to a table id absent from the
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
- Catalog chokepoints: op-creating surfaces prepend `declareCaseType` /
  `ensureCatalogProperty` (per-surface multiplayer test, the `multiplayerMerge` pattern).

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
  `retype` declared; ≤1 op per statically-known (caseType, target); `idFrom` form-local,
  non-repeat; op `id` slug rules.
- Tables: `TABLE_REFERENCE_UNKNOWN` (§4); `options_source` column/type checks. **Gating
  boundary with PR-03 (total-emitter invariant):** this PR does NOT green-light
  table-bearing wire. `FIXTURE_REFERENCE_NOT_MODELED` keeps rejecting `#table/` heads in
  field expressions, and a temporary gating finding (`TABLE_EMISSION_NOT_ACTIVE`) keeps
  `options_source`/`table-lookup`-bearing docs from committing, **both lifted by PR-03 in
  the same PR that makes the wire emittable** — at no merge point can a valid doc reach an
  emitter that can't emit it (main auto-deploys).
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
