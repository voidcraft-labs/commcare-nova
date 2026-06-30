# Real-time multiplayer editing — implementation plan

Multiplayer editing lets several members of a shared Project edit one app — through the
visual builder, the chat Solutions Architect, and the MCP API — at the same time, with
edits merging live and a presence layer showing who is doing what. It keeps Nova's
document authority and validation gate exactly where they are and adds an ordered,
durable stream of accepted mutations inside Firestore, delivered to browsers over a
server-relayed SSE channel. No new datastore, no message broker, no second service.

This is a build spec. §Decision and §Architecture fix the model; §Implementation plan
is **nine phases**, each a self-contained hand-off unit (Goal · Files & changes · Seams
· Code facts to handle · Tests · Depends on); §Cross-cutting invariants, §Rollout, and
§Testing close it out.

**One merge, strict build order.** The phases are layers inside a single shippable
change, ordered so each layer's output is consumed — never replaced — by a later one;
the whole feature goes live on deploy. Every builder session — solo or shared — opens
the stream and edits through the one reconciler and the one write path; a solo editor
receives only its own batches back as echoes.

---

## Decision

- **Authority + gate.** Every blueprint commit — builder auto-save, MCP, and the chat
  SA — goes through one guarded writer, `commitGuardedBatch`, which in a single
  Firestore transaction re-applies the client `Mutation[]` onto the *fresh* stored doc,
  rejects a concurrent-delete (`batchTargetsMissing` → 409) and a finding-introducing
  batch (`mutationCommitVerdict` → 409), commits the blueprint, and appends the accepted
  batch to a per-app stream under one monotonic `mutation_seq`.
- **Merge by construction.** Every mutation the diff emits is identity-keyed (a uuid, a
  `(caseType, property)` name pair, or a per-item uuid) and carries an absolute
  fractional `order` key rather than an array index, so two members editing different
  entities, properties, list items, or reordering different things all merge on the
  guarded re-apply. The only operation that resolves to last-writer is two members
  replacing the *same scalar slot* at the same instant — deterministic by commit order.
- **Transport.** A same-origin Next route holds a gRPC `onSnapshot` on the stream (and
  on presence) over a dedicated `preferRest:false` Firestore client and pipes entries
  to the browser as Server-Sent Events. The browser carries no Firestore SDK and no
  second identity; the route authorizes with the Better Auth session cookie.
- **Revocation** is enforced by re-running the full session + scope check on a ~10 s
  cadence inside the live stream and closing on denial. Project membership lives in
  Postgres (`auth_member`); the cadence re-reads it and also re-applies the
  ban/deletion check (`sessionUserIsActive`), so every revocation path — remove, role
  change, leave, org delete, ban — closes an open stream within the cadence.
- **Presence** is the roster of avatars, click-to-follow to a peer's location, colored
  markers on the module/form/field each peer has selected, and a live "X is editing
  this" highlight, posted on selection change over the same channel.

---

## Architecture

### Data model

A per-app monotonic `mutation_seq` plus three subcollections under `apps/{appId}`.

```
apps/{appId}
  mutation_seq: number              // z.number().int().nonnegative().default(0)
  run_lock?: { runId, actorUserId, expireAt }   // per-app SA-run lease (build + edit)

apps/{appId}/acceptedMutations/{seq}     // seqDocId = String(seq).padStart(12,'0')
  seq, batchId, runId?, mutations: Mutation[],
  actorId, kind: 'autosave'|'mcp'|'chat'|'migration', ts, expireAt

apps/{appId}/batchDedup/{batchId}        // { seq, basisToken, expireAt } — idempotency latch
apps/{appId}/presence/{userId}:{sessionId}   // { userId, sessionId, name, color, location, updatedAt, expireAt }
```

`mutation_seq` is the ordering key, the client recovery cursor, the export version
boundary (`compiledAtSeq`), and the source for the Postgres `synced_seq` guard.
`blueprint_token` keeps its optimistic-concurrency role; the client keys on
`mutation_seq`. `acceptedMutations` entries store the **delta**, so folding deltas from
any retained seq reproduces the stored snapshot. Every retained TTL field is `expireAt`.
Presence is keyed per browser session (`{userId}:{sessionId}`) so a user's two tabs do
not clobber; the roster dedupes self by `userId`.

### The order-key contract (authoritative — every phase references this)

`order` is an absolute fractional sort key, not an array index. It governs **only**
display/wire/preview/SA sequence; the storage arrays (`moduleOrder`, each `formOrder[m]`,
each `fieldOrder[p]`, and the `columns`/`searchInputs`/`options` arrays) are **membership
sets** whose internal position is *not* authoritative.

- **Sequence is derived** as `sort-by-(order, uuid)` (`bySortKey`) wherever order is
  consumed (the shared `fieldWalk` walk + the other enumerated consumption points).
- **The gesture computes the key; the reducer stores it verbatim.** Whichever editor
  performs an add/move computes the absolute fractional key (via `keyBetween` /
  `deriveKeyAtIndex`) against the doc it currently sees and passes it in the payload. The
  reducer writes `mut.order` onto the entity **verbatim** and never recomputes a key from
  an index against the fresh server doc (recomputing would be positional last-writer and
  defeat merge-by-construction).
- **Reducer effects.** A same-parent reorder sets only the entity's `order`; the
  membership array is untouched. A cross-parent field move sets `order` **and** updates
  membership (remove from the old parent's array, add to the new — position arbitrary).
  `addX` adds the entity to the membership array (position arbitrary) with its `order`.
  `moveX` keeps `toIndex` only so the reducer can replay historical pre-`order` events;
  new emissions always carry `order` and the reducer prefers it.
- **Diff detection.** Membership deltas (add / remove / cross-parent move) are detected by
  set/parent comparison and emit `addX` (entity carries `order`) / `removeX` /
  `moveField{toParentUuid, order}`. A **reorder is detected by comparing a common
  entity's `order` between `prev` and `next`** (independent of array position) and emits
  `moveModule`/`moveForm`/`moveField`/`moveColumn`/`moveSearchInput`/`moveOption{order}` —
  there is no array-position move detection for reorders. `order` is excluded from the
  generic property patch (so it is never double-emitted alongside a `moveX`).
- **Backfill is deterministic.** Legacy entities without `order` (and select options
  without `uuid`) are backfilled from **array position** — a pure function of the stored
  array — so client hydration and the server `freshDoc` rebuild of the same legacy doc
  produce identical keys/uuids and never disagree.

### The single write chokepoint

`lib/db/apps.ts::commitGuardedBatch` is the one writer for every blueprint mutation, and
`writeCommittedSnapshot` (private to that module) is the one `getDb()`-bound function that
writes the blueprint snapshot fields, with `mutation_seq` a required argument — so no
`getDb()`-bound path advances the blueprint without advancing the stream. The auto-save
PUT, MCP, and the chat SA route through `commitGuardedBatch`; the cross-Project move calls
`writeCommittedSnapshot` directly (it is not a mutation batch, but still advances the
stream). `appendSyntheticBatchTx` is its migration-client twin: it upholds the identical
seq + `acceptedMutations` coupling on a caller-supplied Firestore client. Mechanics in
Phase 3.

### Relay, reconciler, presence, preview, Postgres, runs

Phases 5, 6, 7, 8, 4, 9 respectively.

---

## Implementation plan

Dependency DAG (one merge):

```
P1 ─┬─> P2 ─┬─────────────> P6 ──> P7
    │       │
    ├─> P3 ─┼─> P4
    │       ├─> P5 ──> P6
    │       ├─> P8
    │       └─> P9
    └─> P5 (firestore helpers)
```

P2 and P3 depend only on P1 and may proceed in parallel; both must land before P6. P2's
persist-at-rest migrate scripts additionally use P3's `appendSyntheticBatchTx` (written
after P3). `app/api/chat/route.ts` is edited by **P3, P4, P6, and P9** — it owns the
run-finalize region; each names it in its Files & changes.

---

### Phase 1 — Foundation: schemas, key primitives, Firestore/Postgres scaffolding, shared constants

**Goal.** Add every new persisted field, helper, and shared constant — additive and
parse-safe on legacy data. No observable behavior alone.

**Files & changes.**

- `lib/db/types.ts`
  - `appDocSchema`: add `mutation_seq: z.number().int().nonnegative().default(0)` and
    `run_lock: z.object({ runId: z.string(), actorUserId: z.string(), expireAt }).optional()`
    (P9's per-app SA-run lease for edits; builds use `status:'generating'`).
  - `acceptedMutationSchema` `{ seq, batchId, runId: z.string().optional(), mutations:
    z.array(mutationSchema), actorId, kind: z.enum(['autosave','mcp','chat','migration']),
    ts, expireAt }`.
  - `batchDedupSchema` `{ seq, basisToken, expireAt }`.
  - `presenceDocSchema` `{ userId, sessionId, name, color, location: locationSchema,
    updatedAt, expireAt }`. Add a Zod `locationSchema` to `lib/routing/types.ts` mirroring
    the `Location` union and infer the TS `Location` from it.
  - `reservation`: add `expireAt` (P9's reaper).
- `lib/db/constants.ts` *(new — shared so P3 and P5 import, not redefine)*:
  `RETENTION_COUNT` (~500), and TTL durations `ACCEPTED_MUTATIONS_TTL_MS` (~7 d),
  `PRESENCE_TTL_MS` (~60 s), `BATCH_DEDUP_TTL_MS` (~1 h), and `MAX_RUN_MINUTES` (P9's
  `reservation`/`run_lock` `expireAt` bound — here in a neutral leaf because `credits.ts`
  importing `apps.ts` would cycle). `writeCommittedSnapshot` (P3) computes each
  `expireAt = now + <ttl>`.
- `lib/db/firestore.ts` — converter-bound helpers with an **explicit client param** on the
  listen-read helpers; export the standalone converters too:
  - `collections.acceptedMutations(appId, db = getDb())` + `docs.acceptedMutation(appId,
    seq)` (`seqDocId = String(seq).padStart(12,'0')`) + exported `acceptedMutationConverter`.
  - `collections.presence(appId, db = getDb())` + `docs.presence(appId, presenceId)`
    (`presenceId = \`${userId}:${sessionId}\``) + exported `presenceConverter`.
  - `collections.batchDedup(appId)` + `docs.batchDedup(appId, batchId)` **and a
    converter-less `docs.batchDedupRaw(appId, batchId)`** (the in-txn dedup read; a
    converter `tx.get` on a partial doc throws inside a txn).
  - Leave `firestoreClientOptions()` (already the central source of
    `ignoreUndefinedProperties` **and** the emulator-aware `preferRest` gate) and its
    consumers (`getDb`, `lib/auth/migrate-data.ts`, `scripts/ci/auth-healthz.ts`)
    **unchanged**. P5's `getListenDb()` composes it and overrides only the transport (below). `preferRest` is load-bearing
    (it gates the gRPC channel that hangs in credential-free Docker builds and the
    node-fetch keep-alive class behind a prior all-`/api/auth` 500); never drop it.
- `lib/domain/blueprint.ts`, `lib/domain/fields/base.ts`, `lib/domain/modules.ts` — every
  schema is `.strict()`; each base edited individually; new slots **optional**:
  - `structuralFieldBase`: `order: z.string().optional()` (all 19 field kinds incl. 3
    repeat variants).
  - `moduleSchema`, `formSchema`, `columnBase`, `searchInputCommon`: `order:
    z.string().optional()`.
  - `selectOptionSchema`: `order: z.string().optional()` **and** `uuid:
    uuidSchema.optional()`.
- `lib/doc/order/keys.ts` *(new)* — total fractional-key primitives over BASE_62:
  `keyBetween(a: string|null, b: string|null): string` (never throws; degenerate bound →
  fresh place-after key); `deriveKeyAtIndex(orderedKeys: string[], index: number): string`.
- `lib/doc/order/backfill.ts` *(new)* — pure, idempotent, **deterministic** (position-
  seeded so client and server agree on the same legacy doc): `backfillOrderKeys(doc)`
  seeds `order` from current array position when absent; `backfillOptionUuids(doc)` derives
  a stable uuid from `(field uuid, option index)` (e.g. `\`${field.uuid}-opt-${i}\``) for
  any option lacking one — **never `randomUUID()`** (two independent hydrations of the same
  legacy doc must produce identical uuids, or a client diff references an option the server
  doesn't have).
- `lib/doc/order/compare.ts` *(new)* — `bySortKey(a, b)`: order by `order` when both
  present; an absent `order` falls back to a stable array-position key (total).
- `lib/case-store/sql/database.ts` + a new migration
  `<ts>_add_case_type_schemas_synced_seq.ts` + `lib/case-store/migrations/index.ts` —
  add `synced_seq` to `CaseTypeSchemasTable`, typed `ColumnType<number, number |
  undefined, number>` (node-postgres returns `int8`/`bigint` as a string, so the read
  coerces `Number(row.synced_seq)` and insert is optional). Migration: `ALTER TABLE … ADD
  COLUMN IF NOT EXISTS "synced_seq" bigint NOT NULL DEFAULT 0` (metadata-only, no index;
  template `20260627000000_add_cases_project_id`); dual-source (type + migration in the
  same commit).

**Code facts to handle.**
- All domain schemas are `.strict()` — a key not added to every `.extend()` chain throws.
  `structuralFieldBase` covers all field kinds; modules/forms/columns/search-inputs/options
  each need their own edit.
- `caseTypes` is `z.array(caseTypeSchema).nullable()`, keyed by `name`; properties carry no
  uuid — catalog merge identity is the `name`.
- `mutation_seq`/`synced_seq` are int64 — `@google-cloud/firestore` stays in
  `serverExternalPackages`.

**Tests.** `keys.fuzz.test.ts`; `compare` stable fallback; `backfill` determinism (same
legacy doc → identical keys/uuids twice); legacy-fixture Zod round-trip;
`database.test.ts` dual-source drift guard.

**Depends on.** Nothing.

---

### Phase 2 — Document model: order keys, granular catalog & collections, reducer totality

**Goal.** Make every structural and collection edit merge by construction, per the
§order-key contract.

**Files & changes.**

- `lib/doc/types.ts` (`mutationSchema`):
  - `moveModule`/`moveForm`/`moveField`: carry `order: string`; keep `toIndex` for legacy
    replay only. `addModule`/`addForm`/`addField` carry the entity's `order`.
  - Catalog family (app-level): `declareCaseType`, `retireCaseType`, `addCaseProperty`,
    `removeCaseProperty`, `setCaseProperty`, and **`setCaseTypeMeta { caseType, parent_type?,
    relationship? }`** (the type-level metadata `caseTypeSchema` carries beyond `properties` —
    without it, dropping `setCaseTypes` from the diff would silently lose a `parent_type` /
    `relationship` change). Keyed by `(caseType-name, property-name)`.
  - Collection families (carry owning module/field uuid + item uuid):
    `addColumn`/`updateColumn`/`removeColumn`/`moveColumn`; the search-input quartet;
    `addOption`/`updateOption`/`removeOption`/`moveOption`; `setCaseListMeta { uuid, patch }`
    (`filter`/`icon`/`audioLabel`).
  - **Keep** `setCaseTypes` and wholesale `updateModule{caseListConfig}` /
    `updateField{options}` in the union — required for event-log replay and for whole-entity
    creation (`createModule`/`createForm`). The diff stops emitting them for content
    changes but still emits wholesale `updateModule{caseListConfig}` for the **presence
    transition** (config absent↔present, or whole-object swap on a case-type flip).
- `lib/doc/mutations/index.ts` (`dispatchMutation`): a `switch` arm for **every** new kind
  (default is `assertNever`); warn-and-skip totality. Catalog arms → `app.ts`; column/
  search-input arms → `modules.ts`; option arms → `fields.ts`.
- `lib/doc/mutations/app.ts`: catalog reducers (beside `setCaseTypes`). `declareCaseType`
  idempotent; `addCaseProperty`/`setCaseProperty` key by `(type, property)` name, never
  write the whole array.
- `lib/doc/mutations/modules.ts`, `fields.ts`, `forms.ts`: order-keyed `moveX` reducers
  (write `mut.order` verbatim; reorder leaves membership untouched; cross-parent field move
  updates membership + order — per the §order-key contract); column/search-input/option
  reducers (insert idempotently on uuid, set `order`). The **option reducers mutate the
  `options` array in place and do NOT re-parse the field through `fieldSchema`** — so a
  `removeOption` dropping to 1 reaches the gate as a sub-2 candidate (else a `fieldSchema`
  `.min(2)` re-parse would warn-skip it and the gate would see no change). Remove
  `ensureCatalogProperty`'s auto-create-of-an-absent-**type** side-effect from all five call
  sites; it still appends an absent property to an **existing** declared type (so two
  concurrent `addCaseProperty` both materialize) but no longer creates an undeclared type — a
  field on one then fails the gate via `CASE_PROPERTY_ON_UNKNOWN_TYPE`.
- `lib/doc/hooks/useBlueprintMutations.ts` + `components/builder/useBuilderShortcuts.ts` — the
  builder reorder/add gestures (`moveField`/`moveModule`/`moveForm`/`moveColumn`/
  `moveSearchInput`/`moveOption` + the `addX`) **compute the fractional `order`** via
  `keyBetween`/`deriveKeyAtIndex` against the live store doc and emit `moveX{order}` /
  `addX{order}`. Today they dispatch `toIndex`/`before`/`after` only; under the new reducer
  that leaves `entity.order` unchanged, so the reorder neither persists (the diff emits
  nothing) nor renders (the UI re-sorts to the same order).
- `lib/commcare/validator/` — two new rules + `errors.ts` codes, **registered with class
  `"soundness"` in `gate.ts::VALIDITY_CLASS_BY_CODE`** (the typed-total map — an omitted code
  is a compile error, and a boundary-only rule would not run at the commit gate):
  `SELECT_TOO_FEW_OPTIONS` (`options.length < 2`) and `CASE_PROPERTY_ON_UNKNOWN_TYPE` (a
  field's `case_property_on` names an absent type).
- `lib/commcare/validator/scopeOfMutations.ts` — exhaustive `switch (mut.kind)` with a
  `never` tripwire; **adding kinds breaks the build and an under-broad scope staleness-bugs
  the gate.** Add: a `full` arm for every catalog kind (mirroring `setCaseTypes`); a
  module/form-scoped arm for the column/search-input/option/`setCaseListMeta` families; and
  `full` for any collection kind referencing a case property/type (calculated column,
  search predicate/default/via).
- `lib/doc/referenceIndex.ts::planReferenceIndexMaintenance` — a second exhaustive `switch`
  with a `never` tripwire (per-mutation via `applyOne`). Add: no-op arms for catalog kinds
  (target namespace, like `setCaseTypes`); re-index arms for the column/search-input/option/
  `setCaseListMeta` families that re-derive the owning module/field's reference slots
  **exactly as the `updateModule`/`updateField` arms do** (calculated-column refs, search
  predicate/default/via, option-label hashtag prose). Not stubbed to no-ops.
- **Case-type declaration chokepoint.** A shared helper prepends `declareCaseType` for any
  field whose `case_property_on` names a type absent from `caseTypes`. **Every**
  `case_property_on`-setting surface routes through it: the SA add/edit assembly
  (`blueprintHelpers.ts`/`tools/shared/fieldAssembly.ts`/`createModule`'s `case_type_record`
  + any bulk-generation assembly), the **MCP `add_fields`/`edit_field` handlers**, and the
  builder (`useBlueprintMutations` add/edit, `FieldIdentitySection`). A CI test asserts each
  surface emits the `declareCaseType` (a miss fails CI, not a user edit).
  `lib/doc/scaffolds.ts::declareCaseTypeMutations` and `::caseTypeCatalogMutations` emit
  granular `declareCaseType`/`retireCaseType` (the latter's "collapse to one `setCaseTypes`"
  rationale is obsolete — granular catalog mutations no longer clobber);
  `lib/doc/caseTypeRetirement.ts` emits `retireCaseType`.
- `lib/agent/blueprintHelpers.ts` — the **eight case-list-config builders**
  (`addColumnsMutation`/`updateColumnMutation`/`removeColumnMutation`/`reorderColumnsMutation`
  + the four search-input parallels) currently return wholesale
  `{ kind:'updateModule', patch:{ caseListConfig } }`; rewrite them to emit granular
  column/search-input kinds keyed by item uuid + `order`. The SA/MCP case-list tools that
  call them (`add_case_list_columns`/`update_case_list_column`/`remove_case_list_column`/
  `reorder_case_list_columns` + the search-input tools) inherit the granular emission (they
  apply mutations directly, no diff), so concurrent column/search-input edits stop
  clobbering. `attachOptionMedia` likewise emits a granular `updateOption`.
- `lib/doc/diffDocsToMutations.ts` (a ~1060-line, position-dependent reimplementation —
  treat the existing machinery carefully):
  - Every diff-internal walk (`walkFieldTree`, `nextParentsTopDown`, `buildParentMap`,
    `reconcileFieldTree`, `reconcileFormOrders`, `reconcileOrder`) must order entities by
    `bySortKey(order, uuid)`, since the `*Order` arrays are no longer the authoritative
    sequence. **`reconcileOrder` / array-position move detection is replaced** by the
    order-key diff (a common entity whose `order` changed → `moveX{order}`); the
    **membership** reconciliation (add / remove / cross-parent move) **and the
    evacuation-before-removes emission phase** are **retained**.
  - The evacuation-before-removes phase MUST survive: a surviving field inside a
    to-be-removed parent must emit `moveField` OUT before the `removeForm`/`removeModule`
    that would cascade-delete it (`fields.ts::moveField` early-returns on a missing field, so
    a lost survivor vanishes silently).
  - Moves/adds/reorders per the §order-key contract. Add `order` to `MODULE_PATCH_SKIP` /
    `FORM_PATCH_SKIP` and the field patch skip-set; add **`caseListConfig`** to
    `MODULE_PATCH_SKIP` (so the module-common loop never co-emits a wholesale
    `updateModule{caseListConfig}` that would clobber a concurrent granular column edit); and
    add **`options`** to the field generic-patch skip-set. Specify the option-by-uuid diff
    routine (match on uuid; compare content excluding `order`/`uuid`; emit `addOption`/
    `updateOption`/`removeOption`/`moveOption`).
  - Catalog: diff by `(type, property)` **name**; emit granular catalog mutations instead of
    `setCaseTypes` — `declareCaseType` for a new type **before** any `addCaseProperty`
    targeting it, and `setCaseTypeMeta` for a `parent_type`/`relationship` change on an
    existing type. No live diff path emits `setCaseTypes` after this (verify).
  - Collections: granular column/search-input/option + `setCaseListMeta` for a *persisting*
    config's content change; the wholesale `updateModule{caseListConfig}` is emitted (outside
    the now-skipped generic patch) **only** when the config goes absent↔present or the
    module's case type flips (the whole-object birth/clear), never for a content edit.
- **Sort every order-consumption site through one `bySortKey(order, uuid)` helper.** There
  are TWO field walks, not one: `lib/doc/fieldWalk.ts::buildFieldTree` (imported only by the
  SA — `getForm` via `formSnapshot`, `getField`) **and**
  `lib/preview/engine/fieldTree.ts::buildFieldTree` (imported by the validator field rules
  `lib/commcare/validator/rules/field.ts` + `validator/index.ts` **and** the preview engine).
  **Sort in both** — otherwise a same-parent reorder (membership array untouched) is invisible
  to the commit gate and the running preview. Also sort the direct array-position reads the
  walks don't cover: the wire emitters' `fieldOrder` walks (`lib/commcare/xform/builder.ts`,
  `deriveCaseConfig.ts`, `formActions.ts`), the case-list column/search-input emitters
  (`suite/case-list/*`, `suite/case-search/searchSession.ts`), the select-option XForm
  emitter, the preview's column/option consumption, `lib/agent/summarizeBlueprint.ts`, the SA
  positional resolvers (`blueprintHelpers.ts::resolveFieldByIndex`/`resolveFormUuid`/
  `resolveFormContext`/`findFieldByBareId`), `caseTypeRetirement.ts::placeCarrier`, and the
  builder render (canvas / flipbook / case-list workspace / field rows). Add a **CI grep
  tripwire** that fails on a new raw array-index iteration of an order array *as a sequence*,
  so a missed site fails the build, not prod. `order` never reaches CommCare.
- Hydration boundaries call `backfillOrderKeys` + `backfillOptionUuids`: `store.ts::load`,
  the server read path, and `commitGuardedBatch`'s `freshDoc` rebuild (P3).
- Persist-at-rest scan/migrate scripts (committed, run, `git rm`): `scripts/scan-order-keys.ts`
  + `migrate-order-keys.ts`, `scripts/scan-select-option-keys.ts` + `migrate-select-option-keys.ts`.
  Each writes through P3's `appendSyntheticBatchTx` (written after P3).

**Seams & contracts.** A new kind = `mutationSchema` arm + `dispatchMutation` reducer arm +
`scopeOfMutations` arm + `planReferenceIndexMaintenance` arm + diff emission + (if the SA
authors it) a tool path + a `batchTargetsMissing` arm (P3).

**Code facts to handle.**
- `mutationCommitVerdict` runs `applyMutations` with no Zod parse, so the option reducers
  must not re-parse (above), and a schema-only invariant (`options ≥ 2`) needs a validator
  rule (`SELECT_TOO_FEW_OPTIONS`).
- Case properties have no order key; the catalog diff compares by name and is a no-op on a
  reorder-only delta.
- Removing `ensureCatalogProperty`'s auto-create changes how a *reductive* replay of a
  historical pre-feature `addField`/`updateField`/`convertField` event targeting a
  then-undeclared type would reduce (it used to create the type). This is safe because the
  blueprint is snapshot-authoritative and the `acceptedMutations` fold always starts from a
  stored snapshot that already carries the type — pre-feature deltas are never re-reduced
  from scratch. Update `lib/doc/CLAUDE.md`'s `ensureCatalogProperty` description in the same
  merge so the stated reducer/replay byte-identity invariant doesn't contradict the new
  behavior.

**Tests** (state-model): concurrent disjoint reorders converge with no clobber/snap (incl. a
**same-position order-key-only reorder is emitted and persists**); two concurrent
`addCaseProperty` to one type both materialize; a field on a concurrently-retired type 409s;
two members editing different columns/options merge; `removeOption` below 2 is gate-rejected;
every `case_property_on`-setting surface emits `declareCaseType`; the `caseListConfig`
presence transition still emits; the diff round-trip oracle holds.

**Depends on.** P1. (The migrate scripts additionally use P3's `appendSyntheticBatchTx`.)

---

### Phase 3 — Unified guarded writer, durable stream, chat-SA port

**Goal.** Collapse the writers into `commitGuardedBatch`; make `writeCommittedSnapshot` the
only `getDb()`-bound blueprint-snapshot writer; add `batchId`/`runId`/`seq` to the wire;
port the chat SA, the cross-Project move, and the migration scripts; add per-commit reauth.

**Files & changes.**

- `lib/db/projectMembership.ts` *(new)* — extract the `auth_member` role read (today the
  private `projectRoleFor` in `appAccess.ts`) into a standalone module that reads
  `getAuthDb()` and imports nothing from `apps.ts`; `appAccess.ts` and `apps.ts` both import
  it (breaks the `apps.ts`↔`appAccess.ts` cycle the reauth would create).
- `lib/db/commitGuard.ts` *(new)* — move `batchTargetsMissing` and
  `BlueprintCommitRejectedError` here (today in `applyBlueprintChange.ts`, which imports
  `apps.ts`). `commitGuardedBatch` in `apps.ts` needs both, so leaving them in
  `applyBlueprintChange.ts` would create an `apps.ts`↔`applyBlueprintChange.ts` cycle — the
  same carve-out as `projectMembership.ts`. Both modules import from `commitGuard.ts`.
- `lib/db/apps.ts`
  - `commitGuardedBatch(args): Promise<{ seq, basisToken, committedDoc: BlueprintDoc,
    deduped }>`, `args = { appId, batchId, runId?, mutations, actorUserId, kind,
    mediaExpectations? }`. **Returns a fully-hydrated `BlueprintDoc`** (the verdict's
    `nextDoc`, which already carries `fieldParent` + `refIndex`) so chat consumers need no
    re-hydration. Resolve reauth for the common case **before** the transaction (out of the
    retry loop): `loadAppProjectId(appId)` → if non-null, resolve `role =
    projectRoleFor(actorUserId, projectId)` and **reject when `role === null`** (not a member
    — it returns `string | null`, so guard before `roleAllowsApp(role, 'edit')`); a null
    `project_id` defers to an in-txn `fresh.owner === actorUserId` check. Then one
    `getDb().runTransaction`:
    1. Read both up front: `tx.get(docs.batchDedupRaw(appId, batchId))` and
       `tx.get(docs.app(appId))` → `fresh`.
    2. **Dedup hit** → return `{ seq, basisToken, committedDoc: hydrate(fresh.blueprint),
       deduped: true }`, write nothing.
    3. Assert `fresh.project_id` equals the reauthed project (concurrent move → reject); for
       null `project_id`, assert `fresh.owner === actorUserId`.
    4. `mediaExpectations` re-check (reads asset rows via `tx`, before any write).
    5. Rebuild `freshDoc` (`backfillOrderKeys` + `backfillOptionUuids` + `rebuildFieldParent`
       + `buildReferenceIndex`); `batchTargetsMissing` → throw `BlueprintCommitRejectedError`;
       `mutationCommitVerdict` → throw on `!ok`.
    6. `seq = (fresh.mutation_seq ?? 0) + 1` — a **literal**, recomputed each retry. Never
       `FieldValue.increment`.
    7. `writeCommittedSnapshot(tx, …)`.
  - `writeCommittedSnapshot(tx, { appId, seq, batchId, runId?, committedDoc, mutations,
    actorUserId, kind, basisToken, extraAppFields? })` — the only `getDb()`-bound caller of
    (now module-private) `blueprintSnapshotFields`. One `tx.update(docs.appRaw(appId), {
    ...blueprintSnapshotFields(committedDoc, { basisToken, runId }), mutation_seq: seq,
    ...extraAppFields })` (`extraAppFields` carries the move's `project_id` flip into the one
    allowed write); `tx.set(docs.acceptedMutation(appId, seq), { …, expireAt: now +
    ACCEPTED_MUTATIONS_TTL_MS })`; `tx.set(docs.batchDedup(appId, batchId), { seq, basisToken,
    expireAt: now + BATCH_DEDUP_TTL_MS })`; `tx.delete(docs.acceptedMutation(appId, seq −
    RETENTION_COUNT))` when positive. (Constants from `lib/db/constants.ts`.)
  - Post-commit `syncMediaReferences`; return `{ seq, basisToken, committedDoc, deduped:
    false }`.
  - `appendSyntheticBatchTx(db, appId, migratedDoc)` — the migration-client twin; builds
    **all** refs from the passed `db` (`db.collection('apps').doc(appId)` + subcollections),
    never the `getDb()`-bound `docs.*` helpers. One transaction: `blueprint` + `mutation_seq`
    + an `acceptedMutations/{seq}` reload sentinel (`mutations:[]`, `kind:'migration'`,
    `batchId: randomUUID()`, `actorId:'migration'`) + the dedup latch. May call the pure
    `blueprintSnapshotFields`, never `writeCommittedSnapshot`.
  - `commitAppProjectMove` — **retain its existing `already_moved`/`media_stale`/`busy`
    branches, the `remapAssetRefs`/`assetIdMap` repoint, and the no-media flip path
    unchanged.** The only change: compute `seq = (fresh.mutation_seq ?? 0) + 1` inside the txn
    and route the final `tx.update` through `writeCommittedSnapshot(tx, { …, seq, mutations:[],
    kind:'migration', actorId:'migration', extraAppFields:{ project_id: toProjectId } })` (one
    `appRaw` write); the no-media branch passes `committedDoc = fresh.blueprint`.
  - **Remove** `updateAppGuardedMutating`, `updateAppForRunTransactional`, `updateAppForRun`,
    and the dead non-guard whole-doc path (grep to confirm; remove `updateApp` if dead).
  - **Extend `batchTargetsMissing`** (now in `commitGuard.ts`) with an arm for every P2 kind
    **and add an `assertNever` default** over the `Mutation` union (today there is no
    `default`, so an unlisted kind silently returns `false` — invisible data loss). The
    `assertNever` forces explicit `case` arms for the existing app-level kinds the current
    code covers only by a fall-through comment — add **no-op arms for `setAppName`,
    `setConnectType`, `setCaseTypes`, `setAppLogo`**. Build a `caseTypeNames` set from the
    fresh `doc.caseTypes` plus intra-batch `declareCaseType`s; a catalog kind
    (`addCaseProperty`/`removeCaseProperty`/`setCaseProperty`/`setCaseTypeMeta`/`retireCaseType`)
    against an absent type name is a conflict. For a collection kind, resolve the owning
    module/field, then assert the item uuid still exists in `caseListConfig.columns` /
    `.searchInputs` / `field.options`.
- `lib/db/applyBlueprintChange.ts` — thread `{ batchId, runId, actorUserId, kind }`; add a
  **top-level `batchId` dedup** (read `docs.batchDedupRaw` non-transactionally before the
  Postgres work). `ApplyBlueprintChangeResult` gains `seq` and `committedDoc?: BlueprintDoc`
  (**optional** — the top-level dedup hit returns `{ seq, basisToken }` with no committed doc
  rather than paying an extra app-doc read; MCP/auto-save tolerate `undefined` on a dedup
  hit; the in-txn dedup inside `commitGuardedBatch` does supply `hydrate(fresh.blueprint)`).
- `lib/agent/toolExecutionContext.ts` — the **shared** interface `recordMutations` /
  `recordMutationStages` return `Promise<{ events: MutationEvent[]; committedDoc:
  BlueprintDoc }>`. Both implementations satisfy it.
- `app/api/apps/[id]/route.ts` — GET adds `mutation_seq`; PUT body `{ mutations, batchId }`
  (`batchId: z.string().uuid()`), response `{ ok, basisToken, seq }`; thread `batchId`,
  `actorUserId`, `kind:'autosave'`.
- **Chat-SA port — awaited-inline:**
  - `lib/agent/generationContext.ts`: `recordMutations`/`recordMutationStages` **await**
    `commitGuardedBatch` and return `{ events, committedDoc }` (the hydrated `BlueprintDoc`
    the writer returns — no re-hydration here). `recordMutationStages` concatenates all
    stages into **one** body (one `batchId`, one `seq`) — preserving `editField` atomicity.
    The `data-mutations` SSE emit happens **after** the commit resolves, carrying the
    committed `seq` + `batchId`; on a `BlueprintCommitRejectedError` no `data-mutations` is
    emitted. **`saveChain`/`drainIntermediateSaves` are removed** (the SA `serial()` mutex
    serializes; `consumeStream()` resolving implies every inline commit settled). Add a
    `latestCommittedSeq()` accessor.
  - `lib/mcp/context.ts`: `recordMutations`/`recordMutationStages` return `{ events,
    committedDoc }`. The shared interface keeps `committedDoc: BlueprintDoc` **non-optional**;
    MCP coalesces `committedDoc: result.committedDoc ?? <the post-mutation doc the tool passed
    in>` (the result's `committedDoc` is undefined only on a top-level dedup hit). Mint
    `batchId`, `kind:'mcp'`.
  - `lib/agent/tools/common.ts`: on a pre-commit `mutationCommitVerdict` finding,
    `guardedMutate`/`guardedMutateStages` return the existing `{ ok:false, error }`
    (self-correctable — the SA's working doc is valid, no reload); on success
    `newDoc = committedDoc`. They **do not catch** `BlueprintCommitRejectedError` (the
    authoritative conflict) — it propagates, as does any generic throw (Firestore fault / txn
    contention / the concurrent-move reject). `GuardedMutateOutcome` and `MutatingToolResult`
    are unchanged — **no `conflict` flag, no shared failure-result helper** (there is none
    today; ~13 tools each inline `result:{error}`, so the propagate-the-throw design touches
    one place, not every tool).
  - `lib/agent/solutionsArchitect.ts`: `wrapMutating` sets `doc = committedDoc` on success.
    It runs each tool body inside the `serial()` mutex and **catches a
    `BlueprintCommitRejectedError`** (a peer deleted the target): it returns the standard
    `{ error }` envelope to the SA **and** reloads fresh before the next tool call —
    `loadApp(appId).blueprint` → `rebuildFieldParent` + `buildReferenceIndex` + the P2
    `backfillOrderKeys`/`backfillOptionUuids` (idempotent). A pre-commit `{ error }` (no
    throw) does **not** reload.
  - `app/api/chat/route.ts` **(P3 edits)**: remove both `await ctx.drainIntermediateSaves()`
    calls; the finalize reads `ctx.latestPersistedDoc()` and stamps `ctx.latestCommittedSeq()`
    on `data-done` (`{ doc, seq, success }`).
- Migration scripts `scripts/migrate-expression-asts.ts`, `repair-legacy-findings.ts` call
  `appendSyntheticBatchTx(theirClient, appId, migratedDoc)`. `recover-app.ts` writes no
  `blueprint` → exempt.

**Code facts to handle.**
- Chat intermediate saves don't rotate `blueprint_token` today; under the port every chat
  stage commits via `commitGuardedBatch` (rotates the token, advances the seq). The author's
  own tab absorbs its own chat frames as echoes (P6).
- A pre-commit gate finding returns `{ error }` without throwing (no reload); an authoritative
  commit conflict throws `BlueprintCommitRejectedError`, which `wrapMutating` catches to reload.

**Tests** (emulator): atomic `mutation_seq` + `acceptedMutations` + `batchDedup`; gap-free
seqs under contention; `batchId` idempotency does zero schema work; per-commit reauth denies
a non-member; null `project_id` owner fallback; concurrent `project_id` change rejects;
`batchTargetsMissing` covers every new kind; `appendSyntheticBatchTx` advances seq + stream
atomically on a passed client. Chat-port: a stage surfaces the merged `committedDoc`; a
conflict reloads + continues; a pre-commit finding does not reload.

**Depends on.** P1; converges with P2 before P6.

---

### Phase 4 — Postgres schema sync under concurrency

**Goal.** Concurrent additive case-type edits both materialize, without losing a per-row
migration. The sync splits by change kind:

- **Migration-bearing** entries (a `change` hint — single-actor reshapes): keep the
  **Postgres-first + `compensate()`** path, derived from the client prospective
  (`prospectiveSchemas = buildCaseTypeMap(prospectiveBlueprint)`), run before the commit.
- **Post-commit sweep of the committed doc's touched case types.** After `commitGuardedBatch`
  returns (skip if `committedDoc` is undefined — a top-level dedup hit), build
  `committedSchemas = buildCaseTypeMap(committedDoc)` and `applySchemaChange` at
  `syncedSeq = committed seq` **for the case types the classify entries name** — keep the
  existing `entries.length === 0` fast path (a non-case-type commit, e.g. form-text or
  order-only, runs no Postgres at all; it touched no case type, so no sync is owed). Do
  **not** re-run the classifier or reuse `prospectiveSchemas`. The monotone `synced_seq` guard
  fully no-ops only a *stale lower-seq* sync; a normal forward sync (incoming > existing)
  still issues the SELECT + UPSERT + Phase-B `readLiveIndexSet` per swept type — the price of
  the concurrent-merge guarantee, not a no-op. It covers a peer's concurrently-added property
  **and** advances the migration-bearing type's `synced_seq` (its per-row work ran
  pre-commit). A failure logs at `warn` and returns success (idempotent, re-derivable via the
  next save / heal); never rethrown.

**Files & changes.**

- `lib/db/applyBlueprintChange.ts` — partition `classifyCaseTypeChanges` entries: run the
  migration-bearing ones Postgres-first + `compensate()` **pre-commit**, then run the single
  post-commit `committedDoc` sweep above (no re-classify). **Rewrite the module + function
  docblocks** to the two-arm split — `compensate()` now only ever receives migration entries,
  and its case-type-**addition** `dropSchema` arm becomes unreachable, so **delete that arm**
  (additions are post-commit/additive). The existing docblock describes the old
  Postgres-first + full-compensation model.
- `lib/case-store/store.ts` — `ApplySchemaChangeArgs` gains `syncedSeq?: number`.
- `lib/case-store/postgres/store.ts::applySchemaChange` — when `syncedSeq` is set, read the
  row's existing `synced_seq` (coerce `Number(...)`; an absent row means "proceed"); if the
  incoming is **lower**, no-op the entire call (schema UPSERT + per-row migration + Phase-B
  index DDL skipped). Else UPSERT `{ schema, synced_seq }` with the SET value
  `eb.ref('excluded.synced_seq')` guarded by `WHERE excluded.synced_seq >=
  case_type_schemas.synced_seq`. (The Phase-B index-DDL skip is perf-only — a lost SELECT→UPSERT
  race re-converges on the next sync, not a correctness gate.)
- `lib/db/materializeCaseStoreSchemas.ts` (chat drain-end) — args `{ appId, blueprint,
  syncedSeq }`; `syncedSeq` = the seq of the **exact** blueprint materialized
  (`ctx.latestCommittedSeq()`, threaded from the chat route — **never** a fresh
  `loadApp().mutation_seq`). **This signature change AND the chat-route call-site threading
  both land in P4.** Additive-only and monotone like the sweep; its failure contract becomes
  swallow + `warn` (**remove** `withTransientRetry`), so the chat route's build arm no longer
  routes a materialize failure through `failRun` — the transiently-unsynced store is closed
  by the point-of-use `withSchemaHeal`. Rewrite its docblock (and any `lib/case-store/CLAUDE.md`
  text) to the swallow+warn contract.
- The point-of-use `withSchemaHeal` — read `syncedSeq` off the **same** `loadApp` snapshot as
  the blueprint. Additive only.

**Code facts to handle.**
- The heal/materialize are additive-only — never a per-row migration — which is why
  migration-bearing changes stay Postgres-first (recoverability).
- `classifyCaseTypeChanges` emits no entry for case-type removals (orphan rows left; the
  retire-while-another-adds case is convergent under the monotone guard).
- `classifyCaseTypeChanges` is **not modified** here — it serves only as the cheap "which
  types changed" signal for scoping the sweep. Its property comparison is positional
  (index-aligned, length-gated), so it over-reports a reorder as a change; harmless, since
  the sweep re-syncs the full schema from `committedDoc` regardless. Do not rewrite it to a
  name-keyed compare.

**Tests** (testcontainers): two concurrent additive adds both materialize; a stale lower-seq
additive sync is a full no-op; a migration-bearing change compensates on a Firestore failure;
a post-commit additive failure self-heals on the next save.

**Depends on.** P1, P3.

---

### Phase 5 — Relay transport: gRPC client, `/stream` + `/presence`, cadence revocation

**Goal.** A same-origin SSE relay over a dedicated gRPC client, with bounded-cadence
revocation and clean teardown.

**Files & changes.**

- `lib/db/firestoreListen.ts` *(new)* — `getListenDb()`, a module-level lazy singleton:
  `_db ??= new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT,
  ...firestoreClientOptions(), preferRest: false })` (the trailing `preferRest: false`
  override wins — gRPC is required for `onSnapshot`). Built on first connect, not at import.
- `app/api/apps/[id]/stream/route.ts` *(new)* — `GET`, Node runtime, `dynamic =
  'force-dynamic'`. Gate: `requireSession(req)` + `resolveAppScope(appId, userId, 'view')`
  (copy `threads/route.ts`; auth rides the session cookie). Then:
  - **Cursor** = `Number.parseInt(Last-Event-ID header ?? ?since ?? '0', 10)` (floor 0 on
    NaN); `seq` is numeric, the header/query are strings.
  - Return a `ReadableStream` (`text/event-stream`, `no-cache, no-transform`, keep-alive).
    **Build the listen queries on `getListenDb()`**: `collections.acceptedMutations(appId,
    getListenDb()).where('seq','>',cursor).orderBy('seq').onSnapshot(...)` → `event:
    mutation`, `id:<seq>`; a `kind:'migration'` entry → `event: reload`.
    `collections.presence(appId, getListenDb()).onSnapshot(...)` → `event: presence`.
    (`getDb()` is `preferRest:true` — REST has no listen channel, so a query on it silently
    never fires in prod.) Iterate `snapshot.docChanges()` filtered to `type === 'added'`, so
    a retention-prune `removed` change never re-emits the window.
  - A `setInterval(~10_000)` re-running `getSessionSafe(req)` (applies `sessionUserIsActive`
    → ban/deletion) **and** `resolveAppScope('view')` (membership) → `event: revoked` + close
    on either denial.
  - `event: revoked`/`reload` are seq-less and carry **no `id:` line**. If `cursor < head −
    RETENTION_COUNT` (read `app.mutation_seq` once at connect) or the first delivered seq
    isn't `cursor + 1`, emit `event: reload`.
  - **Teardown:** `req.signal` `abort` → unsubscribe both `onSnapshot` listeners +
    `clearInterval`, and set a `closed` flag every enqueue/close checks first (so a cadence or
    `onSnapshot` callback resolving after teardown is a no-op) (CI `--detect-async-leaks`;
    tests drive disconnect).
  - The 60-min Cloud Run cap is a transparent EventSource reconnect via `Last-Event-ID`
    (where `requireSession` re-runs); `maxDuration` is advisory.
- `app/api/apps/[id]/presence/route.ts` *(new)* — `POST` (server-stamps `userId`; client
  supplies `sessionId`; writes `docs.presence(appId, \`${userId}:${sessionId}\`)`) and
  `DELETE` (removes that session's doc), both `requireSession` + `resolveAppScope('view')`,
  on `getDb()`.
- No `lib/hostnames.ts` change (the `/api/apps` prefix admits both); no CSP change
  (`connect-src 'self'`).
- TTL provisioning: `scripts/infra/apply-firestore-ttl.ts` *(new, mirrors
  `apply-media-bucket-lifecycle.ts`)* or a documented gcloud runbook — an out-of-band
  per-field policy on `acceptedMutations.expireAt`, `presence.expireAt`, `batchDedup.expireAt`.

**Code facts to handle.**
- `resolveAppScope` reads only `project_id` + the `auth_member` role; it does not check
  ban/deletion. The cadence must also run `getSessionSafe`/`sessionUserIsActive`.
- Use `resolveAppScope` (throws), not `resolveActiveProjectId` (which falls back to the
  personal Project and would mask revocation).
- Verify SSE flushes through the fronting ALB + Cloud Armor (response buffering) against
  deployed infra.

**Tests** (emulator, gRPC): replay-from-cursor, reload below retention, reconnect via
`Last-Event-ID`, bounded revocation (membership **and** ban) closes within the cadence,
disconnect tears down all listeners; **a test asserting the listen query is built on
`getListenDb()`** (so the prod `preferRest` failure isn't masked).

**Depends on.** P1 (client-param helpers, schemas, constants), P3.

---

### Phase 6 — Client reconciler, collaborative undo, auto-save rewrite

**Goal.** One session-scoped owner of confirmed-vs-displayed state; the auto-save base is
`confirmedDoc ⊕ sentPending`; undo/redo stay valid under concurrent edits. `confirmedDoc`
advances **only** via inbound stream frames; the PUT 200 is advisory; a solo editor receives
its own batches back as echoes.

**Files & changes.**

- `lib/collab/reconciler.ts` *(new)* — `createReconciler(docStore, sessionApi, { appId,
  baseSeq, baseDoc, userId })` (a new build mounts with `appId` undefined — see bootstrap):
  - `confirmedDoc`, `baseSeq`, `selfUserId`, `selfActiveRunId` (set when a chat run starts —
    fed from `data-run-id`, before any frame can arrive), `sentPending: Array<{ batchId,
    runId?, mutations, ackedSeq? }>`, `awaitingEcho: Set<batchId>`, `localBase()`,
    `humanUncommitted()`, a transient `remoteFrameApplyInProgress` flag,
    `reloadPending`/`revoked`.
  - **Invariant**: `displayed === fold(confirmedDoc, [...sentPending, humanUncommitted()])`,
    the fold `produce(confirmedDoc, d => applyMutations(d, batch))`.
  - **Dispatch:** PUT `{ mutations, batchId }`; register in `sentPending` + `awaitingEcho` at
    send. The 200 records the assigned `seq` and never advances `confirmedDoc`; the batch
    leaves `sentPending` only when its own frame returns as an echo.
  - **Inbound frame:** drop `seq ≤ baseSeq` (a stale/duplicate echo — no reload, no apply);
    `seq === baseSeq + 1` proceeds; `seq > baseSeq + 1` is a true gap → reconcile-reload.
    **Echo** = `batchId ∈ awaitingEcho`, **or** `actorId === selfUserId && runId != null &&
    runId === selfActiveRunId` (a `runId`-less frame from another tab of the same user is
    **remote**, not a self-echo — so two tabs of one user don't misclassify each other's
    autosave). Echo advances `confirmedDoc`, drops the batch, no undo rebase; remote advances
    `confirmedDoc`, re-folds `sentPending`, and folds the batch through the undo stacks
    (`rebaseHistory`). Each write runs inside the suppression bracket with
    `remoteFrameApplyInProgress` set for that synchronous frame only.
  - **Reload reconciliation** (gap / retention-overrun / sentinel / a PUT 409): defer until
    no PUT is un-acked, GET the fresh blueprint at seq `M`, then drop from
    `sentPending`/`awaitingEcho` (a) every batch with `ackedSeq ≤ M` **and** (b) **the
    specific `batchId` the server rejected with a 409** — a 409 is terminal for that batch
    (its delta cannot apply to fresh state; the user is told to redo it, matching today's
    behavior). Without (b) the rejected batch (no `ackedSeq`) would be re-folded and re-sent,
    409 again — an infinite PUT→409→reload loop. Re-fold only the remaining un-acked batches +
    `humanUncommitted` onto the reloaded `confirmedDoc`, clear the undo stack, and resubscribe
    the stream at cursor `M` (so frames in `(connectCursor, M]` don't each trip the gap
    check). Revocation cancels a pending reload, closes the stream, freezes the canvas.
- **New-build bootstrap (`/build/new`).** The RSC page mounts the builder with no
  `initialDoc`/`appId`/`mutation_seq`; the `appId` is minted mid-run and announced via
  `data-app-id`. The reconciler mounts **dormant** when `appId` is undefined: `data-mutations`
  during the initial build apply directly to the store (bypassing `sentPending`/the stream,
  since there is no stream yet), and `humanUncommitted` PUTs are disabled. When `data-app-id`
  arrives, the reconciler seeds `{ appId, baseSeq: 0, baseDoc: <current store doc> }`, opens
  the stream at cursor 0, and the invariant takes over. Route `data-app-id` into the
  reconciler (today it does not reach `streamDispatcher`).
- **Reconciler mounting + wiring.** A `ReconcilerProvider` in the builder layout owns the
  single reconciler **and the single EventSource**, exposes the reconciler via context, and
  exposes `subscribePresence(cb)` (P7's presence frames ride the same EventSource). The RSC
  build page passes `app.mutation_seq` → `baseSeq` and the loaded blueprint → `baseDoc` (and
  the session `userId`). The chat path
  (`lib/generation/streamDispatcher.ts` + `components/chat/ChatContainer.tsx`) takes the
  reconciler in its signature: the `data-mutations` handler registers each server-minted
  `batchId` (+ the run's `runId`) into `sentPending`/`awaitingEcho` and applies inside the
  suppression bracket, and **records the committed seq on the entry as `ackedSeq`** (so the
  drain below can drop it). **`data-done` runs the same `sentPending` reconciliation as a
  reload** (drop every batch with `ackedSeq ≤` the carried seq, then re-fold) and reseeds
  `confirmedDoc`/`baseSeq` from the carried `{ doc, seq }` via a **suppressed `commitDoc`
  inside `beginRemoteApply`** (carrying `fieldParent` + `refIndex`) + `temporal.clear()` —
  **not `load()`**, which would trip the "`load()` illegal inside an open bracket" assert (the
  agent suppression bracket is still open at `data-done`; `endAgentWrite` runs only on stream
  close). `data-run-id` sets `selfActiveRunId` before any frame arrives.
- `lib/doc/store.ts` — the **store owns `suppressionDepth`** and derives `isTracking` from it
  (zundo `temporal.pause/resume` become internal helpers the store calls when the depth
  crosses 0). `beginAgentWrite`/`endAgentWrite` and a new `beginRemoteApply`/`endRemoteApply`
  increment/decrement the depth. Provider and `useAutoSave` call store methods that
  **decrement** — never `temporal.resume()` directly. Concrete depths (depth > 0 ⇒ paused):
  factory init → 1 (no history at birth); the provider after `load()` decrements to 0 when
  `startTracking` (the live builder) and **stays at 1** when `startTracking === false` (an
  agent-stream/replay mount stays paused); `beginAgentWrite`/`beginRemoteApply` `++`,
  `endAgentWrite`/`endRemoteApply` `--`; `load()`/`clear()` reset depth to 1 (paused) + clear
  temporal, and the caller decrements to 0 afterward if it wants tracking. `load()` is never
  legal inside an open `begin*/end*` bracket (assert). Add `rebaseHistory(fold)` —
  `store.temporal.setState({ pastStates: past.map(fold), futureStates: future.map(fold) })`,
  `fold` preserving full state. Expose `remoteFrameApplyInProgress`.
- `lib/doc/hooks/useAutoSave.ts` — rewrite: **delete `lastSavedDocRef`** + the
  advance-base-on-200 line; base = `reconciler.localBase()`; PUT `{ mutations, batchId }`,
  register at send. Gate the re-PUT on `remoteFrameApplyInProgress` only (one frame's
  bracket), **before** the `canEdit`/`replay` gates. **Replace** the `events.length > 0`
  early-return with reconciler-aware logic (a human edit during a run is `humanUncommitted`
  and PUTs on the next tick). The 409 path delegates to the reconciler's reload. On a
  **non-409 failure (network / 5xx)** the batch stays in `sentPending` (so `localBase()` keeps
  folding it) and is **re-sent by a dedicated retry loop, not the normal diff path** — a
  `sentPending` batch is already in `localBase()`, so `diff(localBase(), displayed)` no longer
  contains it and the subscriber would never re-PUT it. Mark each `sentPending` entry
  `sent`/`acked`; the retry loop re-PUTs each un-acked, un-echoed entry verbatim (idempotent
  via the P3 `batchDedup` latch) on backoff until its echo arrives. Keep the existing 404
  "changes aren't being saved" warning.
- **Collaborative undo** in `lib/routing/builderActions.ts::useUndoRedo` — **gate before
  mutating, then let autosave emit the one PUT**: peek `temporal.pastStates[last]` for
  `rebasedTarget`, compute `diff(displayed, rebasedTarget)`, run `mutationCommitVerdict`; on a
  finding **refuse** with a person-readable reason and apply nothing (no `temporal.undo()`, no
  PUT). On a pass, call `temporal.undo()` **without** an autosave-suppression bracket — its
  synchronous store mutation fires `useAutoSave`'s leading edge exactly once, which PUTs
  `diff(localBase(), displayed)` (one PUT per undo). The undo handler itself never PUTs.
  **`redo` mirrors this** (the same `useUndoRedo.run()` drives both): peek
  `temporal.futureStates[last]`, run the same `mutationCommitVerdict` pre-check, refuse on a
  finding (no `temporal.redo()`, no PUT), else `temporal.redo()` and let autosave emit the one
  PUT — a remote rebase folds `futureStates` too, so an ungated redo could reintroduce a
  finding and 409-churn.

**Code facts to handle.**
- `useAutoSave`'s leading edge fires synchronously from the store subscriber — the
  `remoteFrameApplyInProgress` gate must be first, and undo must gate before mutating.
- One user with two tabs shares a single `actorId` — the echo match needs `batchId` and, for
  chat, a non-null `runId`; an `actorId`-only match would make a peer tab's autosave look like
  a self-echo.

**Tests** (state-model): echo advances base without double-applying; a disjoint remote batch
rebases; a stale `seq ≤ baseSeq` frame is dropped (no reload); a two-tab same-user autosave
from the other tab takes the **remote** branch; concurrent reorders/catalog/column-option
edits converge with no clobber/snap; undo refused before any PUT on a finding, exactly one
PUT otherwise; a human edit during a run persists; the invariant holds across relay-first and
local-first orderings, a new-build bootstrap, and a `data-done` reseed (no double-apply).

**Depends on.** P2, P3, P5.

---

### Phase 7 — Presence: roster, follow, canvas markers, live highlight

**Goal.** The full presence experience.

**Files & changes.**

- `lib/collab/presence.ts` *(new)* — mint a per-tab `sessionId`; heartbeat `POST
  /api/apps/[id]/presence` every ~15 s and promptly (debounced ~300 ms) on `useLocation()`
  change; `DELETE` (with `sessionId`) on unmount / `beforeunload`. Receive `event: presence`
  frames via the `ReconcilerProvider`'s `subscribePresence(cb)` (the shared EventSource —
  P6); dedupe self by `userId`; hide an entry whose `updatedAt` is stale (> ~2× heartbeat).
  Color = `hash(userId) → palette`.
- `lib/collab/usePeersAt.ts` *(new)* — group the roster (deduped by `userId`) by the entity a
  peer occupies, with target extraction for all six `Location` kinds: `home` → roster-only
  (no canvas marker); `module` / `cases` / `search-config` / `detail-config` → the module
  (`caseId` is case data, not a blueprint entity); `form` → the `selectedUuid` field when set,
  else the form. Surface **one marker per peer at its most-specific entity** (not one per
  ancestor level).
- `components/builder/PresenceRoster.tsx` *(new)* — avatars in `BuilderHeader.tsx`'s right
  cluster; click → `useNavigate().push(recoverLocation(peer.location, doc))` (`recoverLocation`
  exists; pass `Pick<BlueprintDoc,'modules'|'forms'|'fields'>`).
- `components/builder/PeerBadge.tsx` *(new)* — a colored marker on the entity a peer occupies
  (module list, flipbook/form tiles, field rows, inspector header); a live "editing this" ring
  on the entity matching a peer's `selectedUuid`.

**Code facts to handle.**
- Presence is keyed per session, so two tabs of a user don't clobber and one tab's `DELETE`
  doesn't drop the other; the roster dedupes self by `userId`.

**Tests** (state-model): `usePeersAt` grouping + self-dedupe across two sessions; most-specific
target extraction per `Location` kind; stale-hide; `recoverLocation` follow lands on the
nearest valid ancestor when the target was deleted.

**Depends on.** P5, P6 (the `subscribePresence` seam).

---

### Phase 8 — Preview & export under multiplayer

**Goal.** A remote batch updates the running preview correctly; every export names its version.

**Files & changes.**

- `lib/preview/engine/engineController.ts::classifyChange` — add a `kind_change` branch
  checked **before** both the id-first short-circuit **and** the expression/label
  fall-through, so a **same-id retype** (`convertField` keeps the uuid + id) **and** a combined
  retype+rename both route to `onKindChanged` (today there is no `kind` comparison, so a
  same-id retype classifies `none`/`expression` and the stale value never drops). Add
  `'kind_change'` to the return union + switch arm. `onKindChanged` re-inits the field —
  **delete the value at the old path**
  (`DataInstance.delete`, since `addFieldState` only seeds `""` when `!instance.has(path)`) and
  rebuild the path maps + DAG + re-evaluate dependents at the new path (subsuming
  `onIdRenamed`'s work).
- `lib/preview/engine/dataInstance.ts` — add `delete(path: string): void`.
- `engineController.ts::onFieldsRemoved` / `formEngine.ts::removeFieldState` — on a remote
  field delete, also delete the `DataInstance` value; keep the uuid-keyed runtime mirror and
  the path-keyed engine store consistent.
- `app/api/compile/prepareCompileRequest.ts` — `PreparedCompileRequest` gains `compiledAtSeq`,
  read as `app.mutation_seq` from the same `resolveAppAccess` `loadApp` snapshot that carries
  `app.blueprint`.
- **Stamp the seq at each of the FOUR export outputs** (web `.ccz`, web JSON, MCP `.ccz`, MCP
  JSON) without inventing a foreign `HqApplication` field (its version slots are
  load-bearing / typed `null`) and without altering a byte-identical HQ-import body:
  - **`.ccz` (web + MCP):** `lib/commcare/compiler.ts::compileCcz`/`generateProfile` stamp
    `compiledAtSeq` into the profile.ccpr `cc-content-version` (do not replace the per-compile
    `uniqueid`). `app/api/compile/route.ts` **and** the **`'ccz'` branch of
    `lib/mcp/tools/compileApp.ts`** (it has both branches; `loadAppBlueprint` returns
    `{ doc, app }`, so `app.mutation_seq` is in hand) thread `compiledAtSeq` into `compileCcz`.
  - **Web JSON** (`app/api/compile/json/route.ts`): the body is the byte-identical HQ-import
    artifact, so carry the seq in an `X-Compiled-At-Seq` **response header**, not the body.
  - **MCP JSON** (`compileApp.ts` `'json'` branch): the media-free case returns a bare
    `{ content:[{ type:'text', text: JSON.stringify(hqJson) }] }` with **no wrapper**, so carry
    the seq on the tool result's **`_meta`/`structuredContent`** (leaving the `text` body
    byte-identical) for both the media-free and the media-bearing (`{format:'zip'}`) shapes.
- The test asserts `compiledAtSeq === app.mutation_seq` on the web `.ccz` profile, the MCP
  `.ccz` profile, the web JSON `X-Compiled-At-Seq` header, and the MCP JSON tool-result
  `_meta` (four outputs).

**Tests** (state-model): a remote retype re-inits the value (no stale resurface); a remote
delete drops the answer and a re-add seeds empty; `compiledAtSeq === app.mutation_seq` across
all four outputs (web + MCP `.ccz` profiles, the web JSON `X-Compiled-At-Seq` header, the MCP
JSON `_meta`).

**Depends on.** P1, P3.

---

### Phase 9 — SA runs under multiplayer

**Goal.** A second collaborator's SA request **waits** instead of 429-ing — for builds **and**
edits — and a stranded credit hold is reclaimed without clawing back a kept charge.

**Files & changes.**

- **Per-app run serialization for both modes.** Today only builds claim a per-app window
  (`claimBuildRun`); edits gate on per-user `hasActiveGeneration(userId, appId)` (which
  excludes the app), so two co-editors edit one app concurrently and both `tx.set` the single
  app-doc reservation marker wholesale. Generalize to `claimRun(appId, mode)`: a build flips
  `status:'generating'` (as today); an edit transactionally claims the `run_lock` field (P1)
  `{ runId, actorUserId, expireAt }` **without** changing status (edits stay `complete`). The
  claim treats an absent or past-`expireAt` `run_lock` as claimable. Specify the cross-mode
  matrix (a build claim waits on a held edit-lock and vice-versa). At most one run holds the
  app, so the single reservation marker is never contended. `claimRun`/`reapStaleReservation`
  read `run_lock`; add it to the `hasActiveGeneration`/`projectAppSummary` projections.
- **Release `run_lock` on every terminal state.** `clearRunLock(appId)` deletes the
  `run_lock` whenever an edit run reaches a terminal state — clean **or failed** — except a
  paused (`askQuestions`) hold. Fold it into `finalizeRun`'s edit path **unconditionally**,
  gated only on `ctx.pausedOnInput()`. A failed edit routes `failRun → finalizeRun`, which
  never enters the clean editing arm — releasing only on clean completion would strand the
  lock until `expireAt` and starve the serialize-with-wait waiter. A hard kill leaves a
  `run_lock` past `expireAt`, which the next `claimRun` treats as claimable; its stranded
  reservation is reaped below.
- **Serialize-with-wait, inside the stream.** `claimRun` treats the app as busy when *either*
  a build holds it (`status === 'generating'` within the staleness window **and not
  `awaiting_input`** — a paused `askQuestions` build is a *claimable takeover*, exactly as
  `claimBuildRun`/`hasActiveGeneration` treat it today, never busy) *or* an edit holds it
  (`run_lock` present, not past `expireAt`); a new claim of **either** mode waits on that busy
  condition, else takes its own form (build → `status:'generating'`; edit → write `run_lock`)
  — that is the full cross-mode matrix, and a paused run is taken over, not waited on. All
  gating runs **before**
  `createUIMessageStream` today and rejects with `Response.json`, but a `data-phase` status can
  only be written inside `execute`. So on a claim conflict the route opens the SSE stream
  immediately and, **inside `execute`**, runs: emit `data-phase` "busy: <name>'s request"
  (holder name from `auth_user`), poll-wait (poll ~750 ms, max wait ~120 s; on timeout emit a
  friendly "still busy" and end), `claimRun`, then `reserveCredits`. The pre-stream bail-outs
  that move inside `execute` are the post-`claimRun` ones — the cross-app concurrency guard
  (`hasActiveGeneration(userId, appId)` → release the claim + end), out-of-credits (emit an
  error data event + release the claim via `clearRunLock`/status-restore), and a
  reservation-failure (release the claim, emit error). **After** the in-`execute`
  `reserveCredits`, set the accumulator's reservation context —
  `usage.configureRun({ didReserve, reservedAmount, chargePeriod: reservation.period })`
  (**extend `AccumulatorRunConfig` in `lib/db/usage.ts` with these three fields** — today they
  are seed-only, so `configureRun` won't compile with them) — so the flush-time refund/settle
  targets the right period (the `UsageAccumulator` is built before the stream with no
  reservation context on this path, so leaving it unset misfires the refund). The non-conflict (free / first-claim) path keeps its existing pre-stream gating
  unchanged.
- **Settle the kept charge on success — gated on NOT paused.** `reserveCredits` writes
  `settled:false`; the only settle today is `refundReservation` (failure/zero-cost). Add
  `settleReservation(appId)` called from `finalizeRun`'s clean branch for **every kept-charge
  run, build or edit — but NOT when the run paused on `askQuestions`** (thread
  `ctx.pausedOnInput()` into `finalizeRun`; a paused run's marker is a live hold the resume's
  failure funnel must refund). Because the `askQuestions` flow is multi-POST (POST1 pauses →
  no settle; POST2 is a free continuation), `settleReservation` settles **whatever hold is on
  the app's marker once the charged run reaches a clean, non-paused completion** — regardless
  of whether *this* POST reserved — so the kept charge is `settled:true` before the
  status-agnostic reaper can reach it.
- **Reap stranded holds for edits.** Builds keep `reapStaleGenerating` (keyed on `updated_at`
  staleness, advanced by intermediate saves) **unchanged** — a fixed `expireAt` would wrongly
  reap a live long build. The new reaper is **edit-only**: the marker gains `expireAt` (P1),
  set at `reserveCredits` to `now + MAX_RUN_MINUTES`; `reapStaleReservation(appId)` fires only
  on a `status === 'complete'` app whose marker is unsettled **and** past `expireAt` (and the
  run is not `awaiting_input`), refunding (refund-first, idempotent via `settled`) without
  flipping status. Call it from `projectAppSummary` (the `listApps` scan sees `complete` apps;
  add `reservation`/`run_lock` to its projection) — **not** `hasActiveGeneration`, whose
  queries filter `status === 'generating'` and so never see an edit hold. `reserveCredits`
  refunds a stale unsettled marker **before** overwriting it.

**Code facts to handle.**
- Finalization is drain-driven (`consumeStream()` then `await drained`), not
  connection-driven. The waiting request is a pre-run poll loop, not a queued run object.
- Every kept charge is settled on a clean non-paused completion, so the status-agnostic edit
  reaper cannot claw back a completed (or completed-after-`askQuestions`) edit's charge.

**Tests** (integration): a second concurrent build *or edit* waits then runs (no 429); a clean
edit releases its `run_lock` (the next waiter proceeds); a successful edit (incl. one that
went through `askQuestions`) is settled and **not** reaped; a hard-killed edit's hold is
refunded and its `run_lock` is treated as claimable; a paused run's marker is never settled.

**Depends on.** P1 (`run_lock` + `reservation.expireAt`), P3. (Edits `app/api/chat/route.ts`.)

---

## Cross-cutting invariants

- **No `getDb()`-bound write advances `blueprint` without advancing `mutation_seq` and
  appending `acceptedMutations`** — `writeCommittedSnapshot` is the only `getDb()`-bound
  writer (`mutation_seq` required); `appendSyntheticBatchTx` is its migration-client twin.
- **`confirmedDoc` advances only via inbound stream frames** — a solo editor included; the PUT
  200 is always advisory.
- **Seqs are contiguous and gap-free** (literal recompute inside the txn retry).
- **`applyMutations` is total over every kind** — adding a kind means an arm in
  `dispatchMutation`, `scopeOfMutations`, `planReferenceIndexMaintenance`, and
  `batchTargetsMissing` (each is exhaustive/`never`-guarded or `default`-less; a missing arm is
  a compile break or a silent correctness hole).
- **Revocation closes the stream regardless of any signal** — the ~10 s cadence runs
  `getSessionSafe` (ban/deletion) **and** `resolveAppScope` (membership).
- **One identity** (the Better Auth session cookie) gates the stream, presence, and write
  routes.
- **`order` and option `uuid` never reach CommCare** — emitters read the `bySortKey` sequence
  and drop the keys.

---

## Rollout

Additive. `mutation_seq`/`run_lock` default empty and initialize on first write;
subcollections are created on first write. `order` keys + option uuids backfill
**deterministically** (position-seeded) at every hydration boundary and the commit re-apply —
so client and server agree on the same legacy doc before any diff — and persist at rest via
the scan/migrate scripts (through `appendSyntheticBatchTx`). Firestore TTL policies are
provisioned out-of-band on the three `expireAt` fields. No tenancy migration.

Order: land the merge → run the backfill scripts → provision the TTL policies. Validate first
with one user in two tabs (exercises the stream, reconciler, echo, undo; self avatars dedupe on
`userId`), then with a second Project member. The version-skew guard reloads any tab open
across the deploy into the new client, which subscribes to the stream shipped in the same merge.

The documented last-writer residuals — two members renaming the same case type/property at
once (no stable name anchor), and a case-type retirement leaving an orphan schema row — are the
only non-merging cases, both rare and convergent.

Subtree docs move with behavior: update `lib/agent/CLAUDE.md` (chat commit awaited-inline
through the guarded writer; `data-done` carries a seq), `lib/doc/CLAUDE.md`
(`ensureCatalogProperty` no longer auto-creates; declaration via the authoring chokepoint), and
`lib/db/CLAUDE.md` (an edit run's reservation is settled on success and reaped if stranded — no
longer an accepted residual).

---

## Touch points

- `lib/db/apps.ts` — `commitGuardedBatch` (returns a hydrated `BlueprintDoc`),
  `writeCommittedSnapshot` (private `blueprintSnapshotFields`, required `mutation_seq`,
  `extraAppFields`, constants-based `expireAt`), `appendSyntheticBatchTx`, `commitAppProjectMove`,
  retention prune, `claimRun` (per-app build + edit via `run_lock`), `clearRunLock`,
  serialize-with-wait, `settleReservation` (paused-gated), `reapStaleReservation`; remove the
  old writers + dead path.
- `lib/db/projectMembership.ts` *(new)* — the `auth_member` role read (breaks the
  apps↔appAccess cycle). `lib/db/commitGuard.ts` *(new)* — `batchTargetsMissing` +
  `BlueprintCommitRejectedError` (breaks the apps↔applyBlueprintChange cycle).
  `lib/db/constants.ts` *(new)* — `RETENTION_COUNT`, the three TTL durations, `MAX_RUN_MINUTES`.
- `lib/db/applyBlueprintChange.ts` — top-level `batchId` dedup; thread `{ batchId, runId,
  actorUserId, kind }`; `ApplyBlueprintChangeResult` gains `seq` + optional `committedDoc`; the
  migration-pre-commit / post-commit-`committedDoc`-sweep split; docblock rewrite + delete the
  `compensate()` `dropSchema` addition arm. (`batchTargetsMissing` moves to `commitGuard.ts`,
  extended per P3.)
- `lib/db/types.ts` — `mutation_seq`, `run_lock`, `acceptedMutationSchema` (with `runId`),
  `batchDedupSchema`, `presenceDocSchema` (per-session key), `reservation.expireAt`.
- `lib/db/firestore.ts` — client-param listen helpers + exported converters
  (`firestoreClientOptions()` unchanged).
- `lib/db/firestoreListen.ts` *(new)* — `getListenDb()`.
- `lib/db/credits.ts` — refund-before-overwrite + `settleReservation`.
- `lib/db/materializeCaseStoreSchemas.ts` — `syncedSeq` arg (the materialized doc's seq) +
  the chat-route call-site threading (both in P4).
- `lib/agent/toolExecutionContext.ts` — `recordMutations`/`recordMutationStages` return
  `{ events, committedDoc }` (shared interface).
- `lib/agent/generationContext.ts` — awaited-inline chat commit; `{ events, committedDoc }`
  return; concatenated `recordMutationStages`; `data-mutations` after commit;
  `latestCommittedSeq()`; remove `saveChain`/`drainIntermediateSaves`.
- `lib/agent/tools/common.ts` — pre-commit finding returns `{ ok:false, error }`,
  `BlueprintCommitRejectedError` propagates (no `conflict` flag, no shared failure helper);
  `lib/agent/solutionsArchitect.ts` — `wrapMutating` sets `doc = committedDoc`, catches the
  rejection in `serial()` and reloads fresh.
- `lib/mcp/context.ts` — `{ events, committedDoc }` return; minted `batchId`, `kind:'mcp'`.
- `app/api/chat/route.ts` — **(P3)** remove the two `drainIntermediateSaves` awaits, stamp the
  seq on `data-done`; **(P4)** thread `syncedSeq` into both `materializeCaseStoreSchemas` calls;
  **(P6)** the `data-done` seq the reconciler reseeds from + `data-app-id`/`data-run-id` into the
  reconciler; **(P9)** serialize-with-wait inside `execute`.
- `lib/doc/order/*` *(new)* — `keys.ts`, `backfill.ts` (deterministic), `compare.ts`.
- `lib/doc/types.ts` / `lib/doc/mutations/*` (incl. `app.ts`) / `lib/doc/diffDocsToMutations.ts`
  — `order` moves (order-key diff), granular catalog + collection kinds, switch arms, remove
  `ensureCatalogProperty` auto-create, options-skip + option-by-uuid diff, presence-transition
  `caseListConfig`; `lib/doc/fieldWalk.ts` sorts by `bySortKey`.
- `lib/commcare/validator/*` + `errors.ts` — `SELECT_TOO_FEW_OPTIONS`,
  `CASE_PROPERTY_ON_UNKNOWN_TYPE` (gating class); `scopeOfMutations.ts` arms for every new kind.
- `lib/doc/referenceIndex.ts` — `planReferenceIndexMaintenance` arms for every new kind.
- `lib/doc/scaffolds.ts` (`declareCaseTypeMutations` + `caseTypeCatalogMutations` granular) /
  `caseTypeRetirement.ts` (`retireCaseType`); `lib/agent/blueprintHelpers.ts` — the eight
  case-list-config builders → granular; the `declareCaseType` chokepoint helper (SA + MCP
  `add_fields`/`edit_field` + builder route through it).
- `lib/doc/store.ts` — store-owned `suppressionDepth` (derives `isTracking`), depth-aware at
  every temporal site, `beginRemoteApply`/`endRemoteApply`, `rebaseHistory`,
  `remoteFrameApplyInProgress`.
- `lib/doc/hooks/useAutoSave.ts` — reconciler base; delete `lastSavedDocRef` + advance-on-200;
  gate on `remoteFrameApplyInProgress`; replace the run gate.
- `lib/routing/builderActions.ts` — collaborative undo (gate-before-mutate, exactly one PUT).
- `lib/generation/streamDispatcher.ts` + `components/chat/ChatContainer.tsx` — thread the
  reconciler; `data-mutations`/`data-done`/`data-app-id`/`data-run-id` through it.
- `lib/collab/reconciler.ts` / `presence.ts` / `usePeersAt.ts` *(new)*; a `ReconcilerProvider`
  in the builder layout owning the single EventSource + `subscribePresence`.
- `lib/domain/blueprint.ts` / `modules.ts` / `fields/base.ts` — `order` slots, option `uuid`;
  `lib/routing/types.ts` — `locationSchema`.
- `app/api/apps/[id]/route.ts` — `mutation_seq` GET; `{mutations,batchId}` PUT /
  `{ok,basisToken,seq}` response.
- `app/api/apps/[id]/stream/route.ts` / `presence/route.ts` *(new)*.
- `components/builder/BuilderHeader.tsx` / `PresenceRoster.tsx` / `PeerBadge.tsx`.
- `lib/preview/engine/engineController.ts` / `formEngine.ts` / `dataInstance.ts` —
  `classifyChange` kind detection, `DataInstance.delete`, answer-drop on remote delete.
- `app/api/compile/route.ts` / `app/api/compile/json/route.ts` /
  `app/api/compile/prepareCompileRequest.ts` / `lib/commcare/compiler.ts` /
  `lib/mcp/tools/compileApp.ts` — `compiledAtSeq` (web + MCP `.ccz` profiles, web-JSON
  `X-Compiled-At-Seq` header, MCP-JSON `_meta`).
- `lib/case-store/sql/database.ts` + migration + `postgres/store.ts` + `store.ts` —
  `synced_seq` (`ColumnType`, numeric coerce) + monotone UPSERT + skip-stale.
- `scripts/` — `scan`/`migrate-order-keys`, `scan`/`migrate-select-option-keys`,
  `infra/apply-firestore-ttl`; `migrate-expression-asts` + `repair-legacy-findings` via
  `appendSyntheticBatchTx`; `recover-app` exempt (writes no blueprint).
- `lib/agent/CLAUDE.md` / `lib/doc/CLAUDE.md` / `lib/db/CLAUDE.md` — behavior updates.

---

## Testing

- **Pure transforms (state-model, Vitest):** echo advances base without double-applying; a
  disjoint remote batch rebases; a same-position order-key reorder persists; a stale-seq frame
  drops; a two-tab same-user autosave is treated as remote; concurrent reorders/catalog/
  column-option edits converge; undo refused before any PUT on a finding, exactly one PUT
  otherwise; a human edit during a run persists; the invariant holds across relay/local-first,
  a new-build bootstrap, and a `data-done` reseed; the order-key primitives are fuzz-total and
  the backfills deterministic; `removeOption` below 2 is gate-rejected; every
  `case_property_on`-setting surface emits `declareCaseType`.
- **`commitGuardedBatch` integration (emulator):** atomic seq + `acceptedMutations` +
  `batchDedup`; gap-free under contention; `batchId` idempotency; reauth + null-`project_id`
  fallback + concurrent-move reject; `batchTargetsMissing` covers every kind;
  `appendSyntheticBatchTx` atomic on a passed client.
- **Case-store saga (testcontainers):** two concurrent additive adds both materialize; a stale
  lower-seq additive sync is a no-op; a migration-bearing change compensates on a Firestore
  failure; a post-commit additive failure self-heals.
- **Stream route (emulator, gRPC):** replay-from-cursor, reload below retention, reconnect via
  `Last-Event-ID`, bounded revocation (membership + ban), disconnect tears down all listeners;
  the listen query is built on `getListenDb()`.
- **Runs (integration):** a second concurrent build *or edit* waits then runs (no 429); a clean
  edit releases `run_lock`; a successful edit (incl. via `askQuestions`) settles and is not
  reaped; a stranded edit hold is refunded.
- **Playwright (`npm run test:smoke`):** two Project members editing one app — B sees A's edit;
  B's in-progress edit and a different-column edit survive A's disjoint edit; reconnect recovers;
  a demoted member's stream closes within the cadence; presence avatars appear, follow jumps, and
  the live highlight tracks a peer's selection.
