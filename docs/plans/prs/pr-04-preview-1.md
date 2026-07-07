# PR-04: Preview I — persona substrate, display conditions, op transactions, table choices

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f1-…` §3.3,
`…f4-…` §3.5–3.6, `…f5-…` §3.3, `…f2-users.md` §3.2 (the persona shape this PR pre-builds).
Depends on PR-01 (vocabulary, AST arms, check contexts) and PR-02 (table registry + rows
store). Scope rulings in `docs/plans/2026-07-06-pr-execution-plan.md` apply.*

**Goal.** Wave 1's runtime half: the preview executes everything PR-01 made authorable.
A **persona** (who is looking at the app) drives display-condition evaluation over real
Postgres data; case operations apply as one atomic transaction with wire-faithful semantics;
table-backed selects resolve their choices live. Built once, at the shape wave 2 needs — the
persona interface does not change when typed user types land (PR-10).

## What the user gets

In the running-app preview: menus and forms appear/disappear based on who they're pretending
to be (a persona editor sets user-data values and screen width); submitting an event form
visibly creates/updates/closes/links several cases at once in the case data; selects fed by
lookup tables show live, filtered choices. In edit mode nothing hides (the canvas badges on
conditioned items are PR-05's).

## Verified contracts this PR mirrors (cite in code by these names)

- **Atomicity**: formplayer applies a submission's case blocks speculatively and commits
  atomically with the HQ POST — one `autoCommit=false` transaction, rolled back if the POST
  fails (`formplayer/.../FormSubmissionHelper.java::processAndSubmitForm/processFormXml`).
  One submission = one transaction is therefore the *faithful* model. Nova's current
  followup/close path violates it knowingly — `lib/preview/engine/caseDataBindingHelpers.ts`
  documents "The three writes open separate transactions — partial success is observable" —
  and this PR fixes that as a behavior change, not a refactor.
- **Per-block semantics** (`commcare-core/.../xml/CaseXmlParser.java`): create-of-existing
  **merges** (every runtime caller passes `acceptCreateOverwrites=true`); an **empty index
  target removes** that link (`indexCase`'s blank-value branch; server agrees via
  `update_strategy.py::_apply_index_action`); the server applies each block's actions in
  fixed order create→update→close→index regardless of XML order
  (`parser.py::CaseUpdate.__init__`), the client in document order — PR-01's canonical op
  sequence (**`sort-by-(order, uuid)`** over the op collection; fractional keys, reorder
  re-keys `order`, membership-array position never authoritative; `target: op` points
  earlier in that sorted sequence) + PR-03's child ordering make both agree, and this PR's
  application order is that same sorted sequence. Empty-index-removal server citations,
  complete: `_apply_index_action` blanks `referenced_id` on the existing row, and removal
  is realized by `CommCareCaseIndex.is_deleted` (`not referenced_id`) filtering in
  `live_indices`.
- **Session instance semantics**: `session/user/data/<key>` nodes come verbatim from the
  restore user's properties (`SessionInstanceBuilder.java::addUserProperties`); an absent
  key is an **absent node**, and the wire's comparison semantics are exact: commcare-core
  unpacks an empty nodeset to the EMPTY STRING for general comparisons — `eq(absent, '')`
  is TRUE and `neq(absent, x)` is TRUE for non-empty x — while NUMERIC ordering against an
  absent node is false (NaN). `window_width` is written by `addMetadata` only when the
  frontend supplied one (`addData` drops null) — absent, not empty. The persona evaluator
  must reproduce absent-vs-empty and the eq/neq/ordering split exactly.
- **Choice re-evaluation**: itemset choices are recomputed when a prompt rebuilds — a filter
  referencing another answer re-filters on navigation
  (`commcare-core/.../ItemSetUtils.java::populateDynamicChoices`;
  `FormEntryPrompt.java::getSelectChoices` builds fresh per `getQuestionPrompt`). Nova's
  preview re-queries choices when a `field`-Term dependency changes — same observable
  behavior, cleaner trigger.
- **Menu failure posture**: on the real runtime a throwing relevancy kills the whole menu
  screen (`MenuLoader.getMenuDisplayables` catch). Nova's conditions are checker-gated so
  this state is unrepresentable; the preview evaluator still fails loudly (never
  silently-shows) if an evaluation errors — a bug surface, not a UX state.

## Build

### 1. Persona substrate (`lib/session` + preview shell) — the F2-shaped interface, now

```ts
// lib/session — sibling of PreviewCaseTarget; ephemeral, never persisted in the doc
interface PreviewPersona {
  id: string;                        // stable synthetic identity (userid analog)
  username?: string;
  userData: Record<string, string>;  // session/user/data values — ad hoc in wave 1;
                                     // PR-10 populates from a userType + overrides
  windowWidth?: number;              // absent ⇒ absent node
}
```

- The **shape is the contract**: PR-10 adds a `userType` *source* for `userData` and a
  location; nothing here changes. Resolution helpers live beside the store
  (`resolvePersonaUserData(persona)`) so wave 2 swaps sources, not call sites.
- Persona editor in the preview shell (`components/preview/PreviewShell.tsx` region):
  key/value user-data rows, username, width presets (desktop/tablet/phone/unset). **"No
  persona" semantics (defined once, here):** with no persona selected, display conditions
  are NOT applied at all — everything renders (author-omniscient, labeled in the shell).
  No partial evaluation: data-only conditions (case-count/table-lookup) are skipped too,
  so the author never sees a half-persona hybrid.
- Builder session store gains the slot + actions following the `PreviewCaseTarget` pattern;
  no shadow flags (house rule).

### 2. Display-condition evaluator (`lib/preview` + case store)

Three stages, single-semantics rule enforced by construction:
1. **Rewrite** `session-user` / `session-context` terms to literals from the persona
   (`lib/domain/predicate/rewrite.ts` machinery; `window_width` → number or *absent-node
   sentinel*, `userid`/`username` from the persona).
2. **Constant-fold** in TS: literal-vs-literal comparisons, boolean identities (building
   blocks: `lib/domain/predicate/reduction.ts` + `simplify.ts::simplifyForEmission`).
   Absent-node sentinel comparisons fold per the wire's exact semantics (contracts above):
   `eq(absent, '')` → true, `neq(absent, non-empty)` → true, numeric ordering → false.
   Most user-data-flag conditions fully decide here.
3. **SQL residue**, batched: remaining `case-count` / `table-lookup` (and form-level
   selected-case `prop`) subtrees compile through the existing AST→Kysely path
   (`lib/case-store/sql/compilePredicate.ts` / `compileExpression.ts`) in ONE server action
   per menu render (`evaluateDisplayConditions(appId, conditions[], caseTypes,
   personaLiterals, selectedCaseId?)` — `caseTypes` is the LIVE catalog slice sent from the
   client, per the house Server-Action wire-shape rule (`lib/preview/CLAUDE.md`:
   "read/query actions ship the case-type catalog slice… not re-read server-side", the
   `loadCasesAction` precedent) — the residue's `prop` casts need it and a server-side
   re-read would reintroduce the stale-schema divergence that rule exists to prevent).
   **Form-level evaluation locus (preview-verified):** in preview, a case-first module's
   `ModuleScreen` renders nothing (`ModuleScreen.tsx::redirectToCaseList` sends non-edit
   case-first traffic to the case list) — the post-selection form menu lives INSIDE
   `CaseListScreen` (`formMenuCase` state + the `caseLoadingForms` list, including the
   single-form auto-continue via `openFormWithCase` and `seededFormUuid`). So form-level
   `prop` conditions gate `caseLoadingForms` (which also gates the auto-continue) and the
   `formMenuPane` list, with the selected row's `case_id` as `selectedCaseId`, never Home;
   `ModuleScreen`'s form map is a gating site only for the forms-first flow, where `prop`
   is inadmissible and no `selectedCaseId` exists. All of it
   Project-membership-gated like every case read (`gatedCaseStore`). New store ENTRY POINT:
   a type-scoped open-case-count query method — it invokes the `case-count` compile arm
   PR-01 landed in `compileExpression.ts` (this PR adds the store method + server action,
   not the compilation; the existing `compileCount` remains anchor-correlated only).
- Gate the renders: `components/preview/screens/HomeScreen.tsx` module map and
  `ModuleScreen.tsx` form map filter by evaluated visibility (today they are purely
  structural — no per-item evaluation exists).
- **Hidden-items reveal**: hidden is the default (runtime-faithful); a "hidden items (N)"
  affordance shows ghosted tiles, each with a person-readable condition summary ("shows
  when `can_admin` = 'yes'"). Edit mode is untouched — everything visible (PR-05 adds the
  canvas badges; not this PR).
- Caching: none in v1 — conditions evaluate per render (menu renders are already
  server-backed), and case writes trigger the same per-screen manual `reload` pattern the
  case-list preview uses today. A revision-token cache is future work, not scope (the repo
  has no case-store write counter or table-revision token to key on).

### 3. Case-op execution (`lib/preview/engine` + `lib/case-store`)

- **New `SubmissionMutation` arm** (`caseDataBindingTypes.ts`): `caseOperations` — split
  across the boundary deliberately. `FormEngine.computeSubmissionMutation` emits op
  **DESCRIPTORS**, not resolved effects: per op it captures the expression ASTs plus
  everything form-local (the submitted field values, `forEach` expansion over repeat
  instances via the existing `[i]`-indexed walk, `idFrom` field values, per-write
  conditions flagged for explicit evaluation — **never via render visibility**; the
  engine's walk ignores `state.visible` today, a divergence ops must not inherit).
  **Resolution happens SERVER-SIDE inside the submission transaction**
  (`submitFormAction`): session-user/session-context terms fold from the persona BEFORE
  dispatch (literals in the descriptor); field refs and `id-of` resolve from the submitted
  instance + the transaction's op-id allocations; `table-lookup` inside op expressions
  compiles inline via `compileExpression` within the same transaction (Postgres-resident
  data never round-trips to the client); `target` resolves there too (`new` → fresh uuid or
  the `idFrom` value; `op` → the earlier op's allocated id; `session` → the loaded case id;
  `expression` → evaluated in-transaction); `links` targets likewise (null = remove).
- **One transaction per submission**: a new store method
  `applySubmission(appId, effects[])` wraps EVERYTHING — primary case action, children,
  ops, link CRUD, closes — in a single Kysely transaction. The existing
  registration/followup/close arms route through it too, **fixing the documented
  non-atomicity**; `schemaHealingCaseStore` retry semantics move to the transaction
  boundary (a retry re-runs the whole submission, which is now safe because nothing
  partial persisted).
- Effect application order = PR-01's canonical sequence, `sort-by-(order, uuid)` over the
  op collection (never array position — `moveCaseOperation` re-keys only `order`); per op:
  create → `insert` (merge-on-existing when `idFrom` collides, mirroring
  `acceptCreateOverwrites`) → writes (JSONB merge) → rename (`case_name` column) / retype
  (`case_type` column) → close (`closed_on` last) → links.
- **Link CRUD + real relationships**: store gains identifier-keyed index operations
  (upsert link, remove link on null target — the empty-target-removes rule); edge writes
  take `relationship` from the op/catalog instead of the current hardcoded `"child"`
  (`lib/case-store/postgres/store.ts` writes `relationship: "child"` on every
  `case_indices` edge today — fix for op links AND the existing subcase path, which
  ignores the catalog's `extension` declaration).
- `id-of` resolution: the transaction records each create op's allocated id in submission
  scope; `id-of(op)` in LATER OP EXPRESSIONS reads it (per PR-01, `id-of` is legal only in
  op expression slots — field expressions reference the created id through the authored
  `idFrom` field's own value instead).
- **Owner stamping — CREATE ops only** (mirroring PR-03's emission rule and PR-01's facet
  matrix): a create's `owner` result; absent → the persona's `id` when a persona is
  active, else the acting Nova user (today's `requireActorUserId()` behavior, which is
  insert-only). An UPDATE op writes `owner_id` only when `owner` is explicitly set
  (ownership transfer) — an absent owner on update touches nothing, exactly as the wire
  emits nothing (else every edit would silently reassign the case to the submitter).
  `owner_id` remains a non-tenant axis — no read filters change in this PR.

### 4. Table-backed choices (`lib/preview` + PR-02's rows store)

- `options_source` selects resolve choices via a server action: query `lookup_rows` for the
  table, apply the compiled `filter` (table-column terms + session terms folded from the
  persona + `field` Terms bound as SQL parameters), ordered by row order; return
  (value, label) pairs.
- `field`-Term filters re-query when the referenced answer changes (subscribe on the
  engine's answer-change events for the referenced uuids) — observably matching the wire's
  prompt-rebuild re-evaluation.
- Choices cache per (form session, bound answer values) — no table-revision token exists
  (see the caching note in §2); a row edit mid-session shows on the next form entry, which
  matches the wire's install/upgrade semantics anyway.
- **Field-level table reads (the `#table/` parts-AST leaf in calculates/defaults):** the
  form engine fetches each referenced table's rows ONCE at form init (≤ PR-02's row cap)
  into a lookup keyed by **table tag** (never `item-list:` — wire vocabulary stays out of
  the preview). **The evaluation seam is hashtag resolution, not `instance()`:** the
  engine evaluates the DOMAIN-printed text, where table references are `#table/<tag>`
  heads — `formEngine.ts::createEvalContext().resolveHashtag` (which today serves
  `#form/`/`#case/`/`#user/` and falls back to `""`) and the evaluator's `HashtagRef`
  handling gain the `#table/<tag>` arm serving the prefetched lookup; the `instance()`
  stub in `functions.ts` is DEAD CODE for these expressions and additionally gains the
  `item-list:` arm only for raw-authored `instance('item-list:…')` text (legal
  post-PR-03's narrowing), stated separately so no implementer wires the wrong seam. This
  is the preview-execution home for `#table/` field expressions — no other PR owns it.

## Tests / acceptance

- Evaluator: fold matrix (every admitted arm × persona states, absent-key and absent-width
  semantics), residue batching (one action per render), single-semantics proof (no TS
  evaluation of any data-dependent comparison — assert the residue compiler receives them).
- Ops: application matrix vs the canonical-order contract (create-merge on idFrom
  collision, empty-link removal, close-with-writes ordering, forEach × repeat instances,
  id-of chains); **transaction rollback test** (a mid-submission failure persists
  nothing — including the previously-non-atomic followup/close shapes); relationship
  correctness for op links and subcase edges.
- Choices: filter binding, answer-change re-query, ordering.
- State-model tests only (house rule: no RTL/jsdom); the reveal/persona UX rides the
  Playwright smoke if touched.
- Acceptance (user-visible): set `can_admin=yes` in the persona editor → a gated module
  appears; clear it → the module hides and shows under "hidden items (1)" with its
  condition; submit a form with three ops → three cases change together or not at all;
  a table-fed select shows rows matching its filter and updates when the controlling
  answer changes.

## Non-goals

Typed user types / usercase rows / owner-set scoping (PR-10 — the persona interface is
ready for them); wire emission (PR-03); UI beyond the persona editor + reveal affordance
(PR-05); restore-scope queries (PR-10); SA tools (PR-06).

## Open choices (implementer)

- Persona persistence across preview sessions: recommend session-ephemeral now (the
  `PreviewCaseTarget` precedent); revisit in PR-10 when personas become blueprint-backed.
- The condition-summary printer: reuse the card editor's sentence rendering if cleanly
  extractable; else a small dedicated printer — must not fork semantics, display only.
- Where the evaluation batch action lives (`lib/preview/engine/caseDataBinding.ts` beside
  the existing read actions is the default).
