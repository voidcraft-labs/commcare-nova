# lib/db — the app-state data layer (Postgres) + the two-ledger credit model

Everything Nova persists about apps, runs, credits, threads, media metadata,
lookup tables, and settings lives in Postgres tables on the shared Cloud SQL pool. `pg.ts`
owns the wire: `getAppDb()` (a `Kysely<AppDatabase>` on the pool
`lib/case-store/postgres/connection.ts` owns), `withAppTx` (the one
transaction entry point — bounded deadlock/serialization retry; a body re-runs
from scratch on retry, so it stays pure of side effects; a build-slice commit
may also supply one absolute deadline, which every retry converts to
PostgreSQL 18 `transaction_timeout` so the transaction cannot commit after
executor authority expires), the table types
(lock-stepped with the DDL in `lib/case-store/migrations/`), and the
LISTEN/NOTIFY poke helpers. `types.ts` owns the assembled record shapes.

**Deployments are app-state tables too.** `app_deployments` and
`app_deployment_resources` are read-write. `app_deployments` carries both
`app_id` and `project_id` but deliberately NOT the composite
`(project_id, app_id)` key `cases` uses: the auth-app tenancy migration keeps
an exact catalog of everything referencing `apps.project_id` and blocks
additions to it, so a second one would fail every deploy's migration job.
Coherence is proved where the writes happen instead —
`lib/deployment/store.ts::lockAppForDeploymentWrite` takes the app row and
compares its Project first — and `apps.ts::commitAppProjectMoveInTransaction`
re-tenants these rows in the same transaction that flips `apps.project_id`. A partial unique index on
`(deployment_id, kind, nova_resource_id) WHERE superseded_at IS NULL` makes two
live ownership mappings for one Nova resource unrepresentable; superseded rows
are retained rather than deleted, because CommCare HQ has no atomic app update
and the app a later publish left behind has to stay nameable.
`lib/deployment/CLAUDE.md` owns the lifecycle.

**Lock ordering is the concurrency discipline.** Every transaction that
decides anything about a run locks its AUTHORITY ROW first (`SELECT … FOR
UPDATE` via `lockAppRow`, or the `design_sessions` row for a pre-app target),
then touches other rows (credit months, entities, the stream). Per-target
contention resolves as row-lock waits, and every decision reads row state
inside the locking transaction. ONE deliberate amendment sits in front of
that convention: a transaction that CREATES, claims, reacquires, pauses,
settles, refunds, reaps, or discards a holder/reservation — on either target
kind — takes the per-actor generation admission gate FIRST
(`actorGenerationGate.ts`, a 64-bit transaction advisory lock keyed on a
versioned hash of the actor id), then the authority row, then the membership
gate/member row, then credit rows. The gate is what makes cross-target
admission atomic: the claim's one-build-per-actor scan spans `apps` AND
`design_sessions` (`scanActorGenerationTargets`), and two concurrent new
design sessions for one actor can never both hold. Canonical commits,
thread writes, and unchanged-holder verification (the heartbeats) take NO
actor gate and keep authority-row-first ordering — gate-after-row on any
lifecycle path would permit a gate↔row deadlock, which is exactly what the
`actorGenerationGate.test.ts` source scan forbids.

**Builder hydration is one authorized snapshot.**
`appAccess.ts::resolveAuthorizedAppSnapshot` holds `apps FOR SHARE`, then the
shared Project-membership advisory gate and exact `auth_member` row, while
`apps.ts::loadAppInTransaction` assembles `blueprint_entities` on that same
transaction. The returned Project, role, `canEdit`, blueprint, and `baseSeq`
therefore belong to one serial winner. `GET /api/apps/[id]` returns exactly
`{ projectId, role, canEdit, blueprint, baseSeq }`; the client rejects unknown
keys. Do not reintroduce aliases or separate app-row, entity, membership, or
cursor reads for this surface.

**There is no blueprint blob.** An app is its `apps` row (scalars +
denormalized list fields + the run lease and credit marker as nullable column
groups) plus one `blueprint_entities` row per entity. Nine kinds share that table
(`EntityRowKind`): `module` / `form` / `field` encode their hierarchy in
`(parent_uuid, ordinal)`, while `user_property` / `user_type` / `persona` are
flat alongside `organization_level` / `location_property` / `automation`; no
parent, with the ordinal preserving that flat collection's sequence. **Every kind
branches explicitly in the assembler**; an unsupported kind fails closed before
assembly instead of being interpreted as another entity shape. The six flat collections' doc slots
are optional and OMITTED when empty, so an app declaring none assembles to
exactly the doc it did before they existed.
`blueprintRows.ts` is the projection: `assembleBlueprint` (rows → the exact
`PersistableDoc`, Zod-validated), `decomposeBlueprint` (inverse; membership
arrays round-trip via the stored `ordinal`), `diffBlueprints` (the minimal
row-set a commit changed — diffed per entity by content, NOT by mutation
targets, because reducer side effects like a rename's prose cascade touch
entities the batch never named). `apps.app_name` stores the blueprint name,
which the schema keeps non-blank, so projections read it directly.

**Persisted Blueprint JSON enters JavaScript as exact text.** `pg`'s default
JSONB decoder is never allowed to parse `apps.case_types`,
`blueprint_entities.data`, replayable `app_changes.mutations`, or
`app_change_fold_baselines.snapshot`: every ordinary reader selects each carrier
as `::text` and enters through `persistedJson.ts` before strict
schema/assembler admission. That parser builds null-prototype objects,
preserves prototype-shaped own keys, rejects duplicate keys, and admits only
PostgreSQL's canonical plain-decimal JSONB spelling that round-trips uniquely
to one finite JavaScript number. Scale aliases, exponent spellings, rounding
aliases, nonfinite overflow, nonzero-to-zero underflow, negative zero, and
integral values outside the safe-integer range fail closed. Domain authoring
uses the matching shared numeric predicate, so ordinary writes cannot create a
carrier the loader rejects. `apps.mutation_seq` and durable mutation `seq`
cross through `safePersistedSequence`; the head cannot advance beyond
`Number.MAX_SAFE_INTEGER`. Do not select these carriers as parsed JSON or use
raw `Number(...)` coercion at a sequence boundary.

App lifecycle status is the exact closed set `generating | complete | error`
and every row-to-view path parses it rather than casting arbitrary database
text. Soft deletion is only the independent `deleted_at` /
`recoverable_until` pair; there is no `"deleted"` status arm or compatibility
projection.

**`app_changes` is permanent history.** It is the durable edit log and realtime
catch-up source; there is no TTL or prune. Its closed kind set is `autosave`,
`mcp`, `chat`, `blueprint-migration`, `fold-baseline`, and `project-move`.
The first four carry a nonempty exactly admitted mutation batch and null
Project-move columns. `fold-baseline` carries exactly `[]`, null move columns,
and one matching immutable `app_change_fold_baselines` row whose snapshot,
digest, Project, sequence, root, and entity freshness are proved in the same
transaction. `project-move` carries `[]` or the nonempty media-remap batch and
requires distinct nonblank source and destination Project ids. Runtime never
updates or deletes either table. Its grants differ: `app_changes` is append-only
runtime DML (`SELECT, INSERT`), while `app_change_fold_baselines` is a control
table the runtime may only read. That is load-bearing — the genesis writer
(`appGenesis.ts`) reaches its baseline through the `SECURITY DEFINER` routine
`nova_insert_app_change_genesis_fold_baseline`, and a direct runtime insert
fails with `42501`. Every fixed public table is registered once by runtime
capability in `privilegeConvergence.ts`; inventory, grants, owned-sequence
access, and the source guard derive from that policy. PostgreSQL requires
`UPDATE` privilege for every table named by a row-lock clause, so serving code
must never use `FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`, or `FOR KEY SHARE`
on the append-only, insert-delete, or read-only capability sets.

App creation writes the complete canonical starter, exact lookup/media
projections, a Project-bearing sequence-one baseline, and one attributed
`fold-baseline` change atomically. A canonical fold begins with the greatest
baseline and its Project, applies subsequent Project moves with exact
source/destination continuity, strictly reduces every mutation-bearing row,
and must end at both the persisted entity projection and `apps.project_id`.
Lookup admission checks only that final folded document against the final
Project's current definition snapshot. The browser collaboration wire accepts
only `autosave | mcp | chat`; the presence of any other kind in a validated
suffix forces fresh authorization and a whole-app reload before ordinary
frames from that suffix are consumed.

System repair/migration writers use a named `system:<task>` actor; user-driven
synthetic writes retain the actual user id. `UNIQUE (app_id, batch_id)` is the
idempotency latch (the guarded commit reads it under the app row lock; a
concurrent same-batch retry that races past the read is caught by the constraint
and converges on the deduped result). A blueprint-shape migration converts every replayable app change; no runtime
reader accepts an alternate stored dialect. Advancing the fold horizon is not a
route a future migration can simply take: the admit routine
`nova_admit_app_change_fold_baseline_insert` accepts exactly two identities —
the frozen `fold-baseline:canonical-identity-foundation` marker and the
sequence-one `genesis:<app_id>` — so writing a new baseline needs new DDL, by
design.

**Realtime pokes ride LISTEN/NOTIFY.** `writeCommittedBatch` calls
`pg_notify('nova_app_stream', {appId, seq})` INSIDE the commit transaction
(delivered on commit, after the rows are visible); `completeAndSettleRun`
pokes the same channel with a `statusChanged` marker so connected builder
streams re-read and re-announce the app status the moment a build commits
`complete` (the one status transition that changes a tab's pricing; every
other transition stays on the stream route's reauthorization cadence);
every deployment write pokes it with a `deploymentChanged` marker
(`notifyAppDeployments`, called by `lib/deployment/store.ts` inside each
record-writing transaction) so connected streams re-resolve what Preview
may name for `commcare_project` and announce it as a
`preview-project-space` frame;
presence reauthorizes against
the app row + exact membership and writes/sweeps/deletes + pokes
`nova_presence` in that same transaction; chat chunk-log appends poke `nova_chat_stream`; lookup writers
poke `nova_lookup_stream` with an exact decimal Project revision. Payloads are
pokes only — the relay (`app/api/apps/[id]/stream`) and the chat-resume
endpoint SELECT durable state from their cursor/scope, so a missed notification
degrades to the next poke/catch-up, never to lost data. `streamListener.ts`
owns ONE dedicated client per instance outside the pool and LISTENs on all five
channels. Replacement waits for bounded closure of the old client before a new
one is constructed, preserving the exact connection budget in
`lib/case-store/postgres/connection.ts`.

**Lookup data uses snapshot invalidation, not mutation replay.**
`lookup_project_state.revision` is the commit-ordered Project clock;
definition and row revisions on each lookup table form its optimistic token.
Every lookup writer locks the Project-state row first and its table row second,
updates the service-maintained counts/bytes, then calls the transactional
`notifyLookupProject` helper. The shared listener fans lookup pokes only to the
matching Project; the app SSE route subscribes before its initial read and emits
a seq-less complete manifest over the existing builder EventSource. There is no
lookup revision log: catch-up replaces the complete manifest (and an opened
table's complete body) from a consistent snapshot. Mutation and lookup readers
use separate single-flight pumps whose retry delay is capped but whose attempts
continue until success or stream teardown. The SQL and value rules live in
`lib/lookup`, which is the only lookup write boundary.

**Lookup-reference carriers are dormant; authoritative writers are integrated.**
`lookup_table_references` and `lookup_column_references` persist exact
Project/resource/app identity edges; a column edge is impossible without its
implied table edge. Resource deletion/identity changes are `RESTRICT`, while
physical app deletion cascades edges. `lookupReferenceEdges.ts` is the internal
materializer seam: after the app row is locked, it takes exact Project-scoped
table locks `FOR KEY SHARE` in lexical UUID order, reads stored targets app-wide
without a Project filter, and replaces complete sets child-delete/parent-delete
then parent-insert/child-insert. Empty replacement can clear stale source-Project
edges; missing/foreign targets share one opaque error.

`apps.ts` is the authoritative protocol for existing-app writes, and
`appGenesis.ts` is the ONE closed birth owner (`explicit-blank |
design-slice`): `prepareGenesisCandidate` reduces the construction batch from
the canonical empty Blueprint (`lib/doc/scaffolds.ts::emptyBlueprintDoc`, the
one spelling both genesis and change-set base loading share) exactly once
outside the retryable transaction, and `writePreparedGenesisInTransaction`
then asserts membership in-transaction, inserts the root (with the run's
holder + reservation columns when a transfer rides the birth), locks/reads
lookup definitions, evaluates the absolute verdict, checks full export
readiness, applies organization cross-store integrity, admits media references,
replaces exact edges, admits runtime
case schemas (`applySchemaChangePhaseA` at synced seq 1; concurrent index
work drains post-commit off `index_pending_seq`), and inserts entity rows,
the sequence-one `fold-baseline` change, and immutable baseline atomically.
`createExplicitBlankApp` (the builder action + MCP `create_app`) births the
canonical survey starter `complete`; the design-slice arm is
`lib/agent/change-set/materializeGenesis.ts`, which replays the genesis
change set's committed steps and transfers the design session's holder +
reservation onto the app row in that same transaction. Every
`commitGuardedBatch`, `appendSyntheticBatch`, and `commitAppProjectMove`
transaction declares lookup writer v1 from the shared runtime manifest. Ordinary
commits lock the app, compare the caller's required `expectedProjectId`, check
the dedup latch, take the shared membership gate,
lock and authorize the actor's exact `auth_member` row in the SAME transaction,
hydrate the fresh doc, reject
reducer-minted identity mutations, prepare once, lock the union of prior and
candidate lookup tables, evaluate against that snapshot, run the organization
cross-store integrity hook under the same app-first lock, replace the complete
lookup and location edge sets, then write rows + history. An automation tool
that returns location-derived setup guidance additionally passes the exact
organization revision it read. After the app lock and any dedup return, the
writer compares that clock before a fresh commit; every location write shares
the app-first prefix, so the successful Blueprint and guide have one
organization serialization point without a fallible post-commit read. A
lost-response replay still returns its already-committed batch even if the
organization advanced later. Missing or foreign tables become one
Nova-language `BlueprintCommitRejectedError`; operational SQL errors are not
misreported as user fixes. `applyBlueprintChange` treats caller-supplied
whole-doc projections as advisory and derives schema work from the guarded
deterministic mutations.

**Every app belongs to exactly one Project.** `apps.project_id` is `NOT NULL`
and has the validated
`apps_project_id_auth_organization_fk` to `auth_organization(id)` with
RESTRICT update/delete actions. The Nova auth-app migration ledger installs
that FK plus `app_changes_from_project_id_auth_organization_fk`,
`app_changes_to_project_id_auth_organization_fk`, and
`app_change_fold_baselines_project_id_auth_organization_fk`, all with RESTRICT
update/delete actions, because Better Auth creates `auth_organization` after
the case-store ledger runs. Runtime types and APIs carry `project_id: string`;
missing-app reads use an explicit not-found result and never overload a
nullable Project. Authorization is Project membership only—`apps.owner` is
creation provenance and never an owner-only access fallback.

That auth-app migration is an exact locked cutover. It inventories every
Project-bearing column on `apps`, `app_changes`, and
`app_change_fold_baselines`, `auth_organization.id`, their
types/defaults/nullability/indexes, and the complete set of local or referencing
constraints whose key touches one of those columns—including names, local and
referenced relations/columns, actions, validation, and deferrability—before
reading the orphan census and before its first write. The only writable state
is the exact pristine set with all four named Project FKs absent. The exact
final set reruns read-only; an alternate-name duplicate, alternate action,
`NOT VALID`/deferrable variant, partial catalog, extra constraint/index, blank
Project, or missing Better Auth Project blocks. Its `down` is forward-only.

`appendSyntheticBatch` requires an exact expected sequence and explicit user or
named-system authority. After locking fresh state it diffs to the requested
target, proves replay identity, and persists the actual mutations; a true no-op
writes no row and advances no sequence. A named-system repair may load a source
that strictly parses but fails today's absolute gate—the reason the repair is
needed—while its requested target still passes the complete current gate before
anything commits; user-attributed synthetic writes retain strict source
admission. `repairLookupReferenceEdges` is the
app-locked maintenance sibling for derived edge state only: it rederives the
structural target set from the committed blueprint and replaces the stored
edge sets, writing no entity, history, or sequence. It is server-only and
script-driven, with no route, action, or MCP exposure. The cross-Project move enables an admin/owner of both ends to move the app plus its case,
media, and chat data as one transaction. It requires no incompatible live stream. Under the app lock it takes the membership gate, locks the actor and all
source-owner membership pairs across both Projects, enforces dual `delete` plus
owner retention, rejects deleted apps, classifies runs only through
`runLeaseState`, and requires structural/stored lookup targets to match exactly
and both be empty. The final transaction locks threads and destination assets,
remaps blueprint and canonical transcript attachment ids, re-tenants all cases,
purges presence, flips `project_id`, re-tenants the app's materialized design
sessions and Project-scoped external-action receipts, appends one attributed
`project-move` change, and
emits app/presence notifications atomically. Media byte copies are the only
non-destructive pre-transaction work. Exact same-Project recovery instead locks
the app, derives its fresh Project, and repairs only case tenancy: no migration
row and no presence purge.
Membership `INSERT`/`UPDATE`/`DELETE` take the matching exclusive transaction
lock from a Better Auth `BEFORE STATEMENT` trigger; `TRUNCATE` raises SQLSTATE
`55000` once its `BEFORE TRUNCATE` trigger fires, without ever waiting on the
advisory gate (ordinary table locks still apply). Existing-app protocols lock
the app first, while creation is the only shared-gate-first exception. This serializes
missing rows and zero-row DML without a tuple/advisory deadlock. While runtime
and migrations use separate database roles, the migration role owns the
database, `public`, and every fixed/auth/control object. Runtime receives
ordinary application DML but owns none of those objects, has no `TRUNCATE` on
them, and cannot create in `public`, so the trigger is backed by a privilege
boundary.
Migration is a one-way member of runtime solely to maintain runtime-owned
`nova_case_runtime.cases`; runtime cannot inherit migration. Runtime gets
`CREATE` only in that isolated case schema for concurrent index DDL.

`runtimeDatabaseProbe.ts` is the production post-migration proof for this
boundary. On the migration connection it `SET LOCAL ROLE`s to runtime, strictly
assembles every app's exact text carriers through the same persisted JSON
decoder with no sample cap, reruns the complete empty-batch mutation gate, and
proves incremental-vs-rebuilt local reference-index equality plus
structural-vs-stored Project lookup-edge equality even when the gate reports
findings. It then strictly loads a gate-clean candidate through
`loadAppInTransaction`, reauthorizes a real editable Project member, and sends a
no-op name batch through the real guarded writer inside one transaction. It
then executes the SSE route's shared `app_changes` plus immutable-baseline read
under that same runtime role, starting at the pre-write sequence so the
permanent history is never loaded, and proves exactly the fresh write is
visible. The integration test separately runs the shared query over a real
baseline row. Its content-free report carries actual parser, gate, and
reference-index finding counts; its intentional rollback must leave both the
app sequence and stream unchanged.
`commitGuardedBatchInTransaction` is the narrow seam for that probe: ordinary
callers use `commitGuardedBatch`, while an externally-owned transaction neither
retries nor emits post-commit side effects.

The dedicated canonical-identity audit login is separate from runtime,
migration, cleanup, and operators. It owns a pool-one `audit` workload, no
parent role, and only schema `USAGE` plus `SELECT` on the frozen scanner's exact
public/runtime relation inventory. Privilege convergence rejects every extra
table read, DML, sequence, routine, database/schema `CREATE`, or missing exact
read. The immutable image entrypoint additionally makes its only session
read-only before opening the scanner's transaction.

Run claim/reserve, paused-run reacquire, soft-delete, and restore use that same
app-row-first membership protocol; no route preflight decides their admission.
Explicit `renameCaseProperties` saves and case-type removals compose their
dedicated case-schema/data Phase A through the guarded writer's `beforeWrite`
seam. A removal marks the durable schema inactive at the same mutation sequence
without deleting retained case data; its concurrent expression-index cleanup is
post-commit retryable work. Fresh Blueprint
admission, Project authorization, all live and parked row collision checks and
moves, Blueprint persistence, and the accepted event share one app-locked
transaction. Any correctness-bearing failure rolls the whole transaction back.
Only concurrent-index Phase B runs after commit; it is idempotent derived work
tracked by durable convergence state.


Run generation is holder identity. `runLeaseState` derives it: edit is
`(edit, lock_run_id, run_holder_nonce)`; build is `(build, res_run_id,
run_holder_nonce)`, with `run_id` used only while a generating build has no
reservation marker. `runId` remains stable attribution; the server-minted UUID
nonce is the per-claim generation. Every holder-touching path uses
`(mode, runId, nonce)` identity: generating creation, build/edit claim,
reservation, paused reacquisition, same-holder blueprint commits,
heartbeats/pause writes, and terminal/failure/reaper/recovery writes.
Complete creation does not use holder identity because it creates no holder.
Every build claim also stamps root `run_id` before emitting any mutation, so a
later no-mutation successor remains the durable latest-claim identity after
reap.

`runHolderWrites.ts` owns the shared SQL compare-and-set predicates for
holder identity. Every lifecycle transaction locks the app row first before
credit rows or its holder write. Terminal, failure, heartbeat, pause, and
reaper updates use `(mode, runId, nonce)` identity; credit writers throw on a
zero-row result so their earlier ledger refund rolls back too. Operator
recovery is deliberately strict and always requires the exact generation. An
absent holder is never terminal authority, and a present holder with a
missing/blank run id is corrupt rather than reapable. Chat mutation commits
carry a separate full `ChatRunHolderCapability`; ordinary `runId` remains
attribution because MCP also stamps one without owning a chat lease. Migration
Phase A checks that capability while holding the app row, and the final
guarded app-row write repeats it as a SQL compare-and-set; entity/reference/history
work rolls back on a lost CAS. The sole absent-holder exception is the
falsely-reaped-build self-heal, whose SQL predicate proves the free row,
marker-cleared reaper signature, and exact last `run_id` plus nonce. A stale
build whose marker was already settled keeps `res_run_id`; that is deliberately
not the reaper signature and is non-self-healable. Reaper scans and conflict
nudge/list queues narrow the observed holder to a concrete identity before
enqueueing it and carry that token all the way to the locked write, so an
arbitrarily delayed reap cannot target a later holder that also went stale.
`scripts/recover-app.ts` writes only through `recoverAppStatus`: a present
holder requires explicit `--holder-mode`, `--holder-run-id`, and UUID
`--holder-nonce` flags, and the service rechecks the exact generation under the
app lock and in SQL.

Threads persist the active nonce in a dedicated `active_holder_nonce` column.
`upsertThreadTurn` locks the app row and proves the admitted holder before
taking the thread lock or installing its marker. A lost holder may merge its
real incoming transcript into an existing same-app thread, but the merge-only
arm cannot replace or clear the successor's `run_id`, `active_stream_id`, or
`active_holder_nonce`; it commits that merge and then throws
`RunHolderLostError` so the route stops before publishing the stale capability.
`loadThread` projects it only to the actor who OWNS the run under fresh app
authority: the paused round's answering actor, or a LIVE run's holding actor
(the cold-resume replay redacts the nonce chunk for every viewer, so the owner
re-seeds the capability from this projection at activation). Co-members,
unscoped loaders, mismatches, and reaped holders receive no nonce. A paused
finalize retains it for the answer POST; a terminal finalize clears it only
when its stream id still owns the marker. The durable chunk log never stores
the nonce itself: the POST writer records one inert chunk at the same index,
carrying only the thread id and a SHA-256 nonce digest. The reconnect route
rehydrates it through the retained-thread/current-holder actor proof. Other
Project viewers receive the inert marker, so shared replay stays count-identical
without sharing continuation authority; an old same-run stream's digest also
cannot resolve to a successor generation. A client resuming from a
server-loaded thread adopts `run_id` and `holder_nonce` together, so it can
never carry a stale generation's continuation authority into a new one.



**`design_sessions` is the pre-app generation target.** A chat build's
durable scope before any app row exists: mode `build` sessions carry the
SAME holder + reservation nullable column groups the `apps` row carries
(`run_id`/`run_holder_nonce`/`run_actor_user_id`/`run_mode`/
`run_lease_expires_at` + `res_*`), claimed, paused, settled, refunded, and
reaped by protocol-identical twins in `designSessions.ts`
(`createAndClaimDesignSessionRun` — creation, cross-target scan,
affordability, reservation, and holder write in ONE gated transaction —
plus claim/reacquire/heartbeat/pause/complete/fail/reap/discard). Sessions
are STRICTER than apps by construction: the table CHECKs force each column
group whole, tie `res_run_id` to `run_id`, forbid authority columns on
terminal states and on `mode = 'edit'` rows (an edit design session is an
artifact scope only — its bound app row stays the sole run/credit
authority), so a marker never outlives its holder and every terminal writer
settles/refunds and clears BOTH groups in one transaction
(`designSessionAuthorityCleared`) — there is no reaper-signature/self-heal
arm to preserve. A failed or reaped session stays `active` with
`last_error_type` set (recoverable by a fresh chargeable claim, or
`discardDesignSession` → `abandoned`); materialization transfers authority to
the app exactly once.
Liveness derives from the explicit lease column via
`runLiveness.ts::designSessionLeaseState` (same module, same
`MAX_GENERATION_MINUTES` horizon — never a second timeout arithmetic).
`generationTargetScope.ts` is the ONE resolver boundary for target
authorization (`resolveGenerationTargetScope` — opaque
`AppAccessError("not_found")` on every denial, exactly like app routes);
an active pre-app build session additionally requires exact owner identity, so
Project co-members gain visibility only after the session binds an app;
`generationTargets.ts` stays a dependency-free TYPE LEAF holding
the closed `GenerationTarget` union every target-polymorphic table speaks
plus the column mappers. Keep them split: the leaf is imported across the
whole protocol layer, while the resolver reaches `apps` /
`designSessions` (and through them the commit kernel) — folding the
resolver into the leaf drags the run-protocol stack into every
type-consumer's import graph, which is the exact shape that deadlocked
the agent media suites' mocked-module factories under vitest.
The tables:
`threads`, `chat_stream_chunks`, and `run_summaries` each carry nullable
`app_id` XOR `design_session_id` (exactly-one CHECKs; `run_summaries`
replaced its PK with the two partial unique indexes). A build thread stays
design-session-targeted after materialization; the thread/stream writers
resolve a materialized session's bound app WITHOUT a held lock and then
lock the APP row as the authority (`threads.ts::lockThreadTargetAuthority`),
so run authority delegates exactly as §11.7 orders the locks — and target
LIVENESS delegates the same way (`generationTargetHeldLive`: a session
carrying an `app_id` answers with the app's liveness, so a stream reconnect
after materialization never reads the terminal session row as a dead run).
The chat route mounts the session surface: a fresh build creates+claims a
session pre-stream, a presented `designSessionId` continues one, and an
app-target BUILD turn resolves its bound `materialized` session (a
sessionless non-complete app is a legacy row the route refuses pending the
one-off repair). Materialization is one transfer transaction — app insert
with the session's holder + reservation, verdicts, entities, baseline,
sidecar receipts, then the session's atomic
`authority-cleared + materialized + app_id` flip. Thread READS on an app
target additionally include its bound materialized session's rows
(`appScopeThreadFilter`) so the build conversation stays on the app page;
every thread WRITE keeps the row's exact target guard.
`designInProgress.ts` is the §15.9 list read: the caller's own active
pre-app build sessions in the active Project, stage derived through
`lib/agent/build`'s orchestration fold (a deliberate data→agent import —
restating the fold here is how a list starts disagreeing with the
conversation it links to; no runtime cycle, the fold reaches only `pg` +
`persistedJson`).

The legacy pre-plan cutover scanner reads app snapshots through the lock-free
repeatable-read inspection loader, so the production scan identity needs no
write privilege. Its writer sibling handles a stale build holder only through
the result-bearing exact run/nonce reaper, re-reads the app after that locked
transition, and then invokes holder-free operator recovery. Live holders wait;
stale holders without an exact identity fail closed for operator inspection.

Compatibility inventories that deliberately search for state made invalid by
a new absolute rule use `loadSchemaAdmittedAppForInspection`: a repeatable-read,
read-only snapshot that applies persisted-schema admission but skips the current
commit gate. It is an operator-only seam, never an app-serving or authorization
path. Without it, the exact historical rows a scanner must name disappear behind
the rule the scan is evaluating.

Discard is one cleanup transaction after its owner/busy checks: refund the
unsettled reservation, abandon open change sets, supersede running slice
attempts, clear thread stream-holder markers, clear session authority, and
mark the session `abandoned`.

**`chat_stream_chunks` is the live-stream catch-up log — operational, not
history.** The chat route's `DurableStreamWriter` (its ONE write choke point)
appends every UI chunk a POST streams, in write order, batched — dropping ALL
per-token `tool-input-delta` chunks at the door (nothing rendered or durable
consumes partial tool JSON) and teeing the identical sequence into the
route's barrier fold. The route also mints the turn's response MESSAGE ID and
hands it to the SA stream (`generateMessageId`), so the `start` chunk carries
one identity upstream of the tee — log, fold, live client, and durable
transcript all name the answer the same. The reconnect endpoint
(`app/api/chat/[streamId]/stream`, the server half of the AI SDK's
`WorkflowChatTransport` contract) replays from a client cursor and tails
live, so a broken connection (network blip, Cloud Run's 60-min request cap)
resumes instead of losing the run; a COLD resume (page refresh onto a live
run) replays the WHOLE log from chunk 0 and the CLIENT windows it against its
own hydrated copy of the message the replay's `start` chunk NAMES
(`lib/chat/hydratedStepFilter`; the stream's first chunk, the transient
`data-seed-steps` offset, maps that message's step count onto this stream's):
only the client knows
which barrier-persisted steps it actually holds, so any server-picked
boundary would race the page's RSC hydration — and keying on identity rather
than trailing position means a locally appended user message can't zero the
window, and a stream growing a message the client never hydrated (a newer
turn claimed in between) windows nothing. The full replay is also
what re-delivers the transient `data-*` chunks (events, receipts) that live
nowhere else. Every
stream is guaranteed to END: the writer seals a terminal row (synthesizing
the `finish` chunk on error paths) STAMPED with the run's fold outcome — the
dead-marker reconciler's finished-vs-died breadcrumb, written only through
finalize, which a dead process never reaches — and a run that died sealing
nothing is
closed by the endpoint's `appHeldLive`-based fallback. Rows prune past
`CHAT_STREAM_RETENTION_MS` (opportunistically, on POST traffic) —
conversation HISTORY lives in `threads` + the event log, never here.

**`threads` is the durable conversation store — one row per CONVERSATION,
spanning runs, written AS THE RUN PRODUCES UNITS.** `messages` holds the full
`UIMessage[]` transcript, server-written by the chat route
(`lib/db/threads.ts` is the whole contract): `upsertThreadTurn` the instant a
run claims the app (persists the incoming history + marks the thread live via
`active_stream_id` — the page-refresh resume handle; a RE-DRIVE claim also
removes its dead predecessor's trailing partial assistant message, but ONLY
while the row still carries a live-stream marker — the standing proof of an
unrecovered interruption — so the client's `redrive` flag alone can never
delete an answer a completed successor already finished), then
`persistResponseSnapshot` at every SDK step barrier (the route's server-side
fold of the chunk sequence fires `onStepEnd` per completed step, and that
callback — never any Nova chunk interpretation — merges the growing
assistant message) and once at stream end (final state + marker retirement).
A FAILED turn's terminal write is `clawBackThreadResponse`: the marker
clears and the id is tombstoned in one transaction, with the transcript
settled by arm — a FRESH turn's streamed partial is KEPT as the
user-visible record (the tab that watched it fail still shows it, and a
reload must not show less; its dangling tool calls are closed as
`output-error` so nothing renders forever in flight, and its `{ id, cap: 0 }`
tombstone refuses every client copy so a stale tab can never grow the stored
record), while a CONTINUATION reverts to its pre-run seed (its retry
re-authors the same message id, and a kept partial would win the
richer-version merge over the retry's growing fold). "A
failed TURN" means the turn's own stream failed: a post-drain bookkeeping
fault (schema materialization, the settle) finalizes with `turnComplete`, so
the finished, fully-streamed answer is never clawed back over it. A
completed/paused fold whose terminal write failed gets the full retry
ladder WITH the latched final message, never a marker-only clear; a failed
claw-back that keeps failing leaves the marker deliberately STANDING (a
marker-only clear would leave the partial as durable history no
writer may trim): the next load reads it as an interruption and the re-drive
claim removes the partial. The history-bearing writers also ADMIT rather
than trust incoming history, refereed by the thread's claw-back TOMBSTONES
(`clawed_back_ids` — the assistant ids the server removed or reverted and
has not re-authored; the claw-back and the re-drive trim write them, a
landed fold snapshot clears its own id): a tombstoned id is refused
(deleted) or capped to its stored seed (reverted — within-part state such
as ask answers still upgrades), a FRESH thread admits no assistant
messages at all (no run ever wrote to it), and every other assistant
message merges by id — including one the store never learned, which is the
self-heal for a turn whose persistence writes all failed.
Finalize is bookkeeping, never a durability event; there is no end-of-run
transcript assembly. (A BAILED POST — serialize-wait gate/timeout,
superseded resume — additionally merges its incoming messages via
`mergeThreadTurnMessages`, identity/marker untouched, so an answered
question round survives the refresh the bail recommends.)
Every thread writer locks the app before its deterministic thread-row lock, so
the Project move is a serial winner rather than a whole-history race.
The merge writers MERGE by message id (`mergeTranscript` — union, richer
version wins), never rewrite: a stale tab or a late barrier can add to a
transcript, not erase it (the claw-back is the one deliberate,
triple-guarded exception), and an askQuestions continuation lands as ONE
merged message. For a shared
message id, stored `metadata.attachments` is authoritative even when an incoming
version wins the parts tiebreak; a stale source-Project history therefore cannot
restore asset ids the move already remapped. The history-bearing writers
(turn upsert, bail merge) derive the complete canonical post-merge attachment
set, lock all referenced assets sorted `FOR SHARE`, validate same
Project/readiness/kind, and replace THIS thread's exact `thread_media_refs`
rows after the message write in the same transaction (the split projection:
Blueprint commits own `media_asset_refs`, thread writes own only their
thread's rows); the barrier
write deliberately does NOT run that projection (an assistant snapshot
carries no attachments — stripped defensively — and the by-id merge cannot
alter stored user messages, so the projected set is unchanged by
construction). Chat admission passes its expected
Project to turn/upsert and bail-history writers, which stop if the app moved
before they acquired the app lock; a BARRIER write's MERGE arm is
stream-guarded (`active_stream_id` must still name this run's stream — a
falsely-reaped zombie must not re-deposit the mid-run partial its
successor's claim just removed), while a TERMINAL write's merge is not (a
finished, charged answer is a completed unit the record keeps even when a
successor claimed the thread mid-write); both merges are Project-guarded.
The MARKER arm is
guarded ONLY by the stream (the
app releases before the final write completes, so a newer claim may already
own a fresh marker), because a marker stranded on a completed run reads as
an instance death and would re-drive (re-charge) a finished turn. The
loaders reconcile any marker against
actual app liveness REPORT-ONLY: a dead marker is stripped
from the projection and stamped `resume_interrupted`, but the row is never
written — the signal is LEVEL-TRIGGERED, standing load after load (any
reader may run first: the thread list, a heal refetch, the page) until an
acting client's RE-DRIVE retires the marker through its own claim. The
finished-vs-died call reads the chunk log's SEAL (the terminal row's stamped
fold outcome, which only finalize writes): a stranded marker over a
`completed`/`paused` seal proves the run FINISHED and only its marker-clear
write was lost — build or edit alike — so it projects retired, never
interrupted, and a finished answer is never destroyed and re-charged by a
phantom re-drive; a `failed` seal or an unsealed stream keeps the
interruption stamp (a mid-turn death, or a claw-back that never landed and
needs the re-drive claim's trim), and a marker that outlived the pruned
log's evidence projects retired, because the destructive arm never runs on
guesswork. A full
load also projects `run_paused` (the app's holder is this thread's run and
it is parked awaiting an askQuestions answer), because barrier-persisted
transcripts make shape undecidable: the client re-drives on the
interruption stamp unless the trailing assistant message holds ANY answered
ask round (its answers live in the message a re-drive would trim — a died
continuation can leave completed steps after the round, so the whole
message is scanned, not its last step) or is genuinely paused. The
re-drive re-runs the interrupted turn through the normal
POST/claim/charge machinery (`redrive: true` on the wire; a claim conflict
there means another session already re-drove, so the request closes clean
instead of serialize-waiting a duplicate). The same capability is the explicit
continuation for a sealed recoverable reviewed build: even when its frozen
transcript ends in an assistant answer round, it takes a fresh claim rather
than trying to reacquire the released holder. A died BUILD (reaped to `error`)
is admitted by the build page only on this signal, and its re-drive claim
flips the row back to `generating`.
The reconnect endpoint resolves a GET id as stream-first, thread-second, so
`useChat`'s `resumeStream({chatId: threadId})` reconnects a refreshed page
to the in-flight run by thread id alone; a thread with nothing in flight
answers a bare `finish` (the transport errors on any non-OK response).
When that reconnect closes, the client performs one authoritative transcript
heal through the app-scoped thread route, or through the owner-private
`/api/design-sessions/{id}/threads/{threadId}` route before materialization.
The latter also returns a newly bound app id so a completion race leaves the
app-less shell and hydrates the canonical Blueprint from the app page.
`updated_at` orders the list (a refresh opens the most recent thread);
`thread_id` is the PK (client-minted uuid) with writers app-guarded so a
forged id can't write across apps. Every POST sends the thread's FULL durable
history — there is no UI/history trim; the server may project the model input
from a compatible provider compaction item and re-inject authoritative state
(the run summary's
`fresh_edit`/`cache_expired` fields retired with it).

## Two ledgers, different lifecycles

Cost and quota live in **separate tables** so an admin intervention on one
never disturbs the other:

- `usage_months` (`UsageDoc`) — dollar cost, **accumulate-only**: the
  `cost_estimate` counter (per-model, per-call token math over
  `MODEL_PRICING`, with short/long selected for that call at `>272k` input
  tokens before run aggregation; which with a
  direct OpenAI key is the deterministic bill). Resets never touch it. Its
  sole gate consumer is the invisible dollar backstop (`COST_BACKSTOP_USD`),
  read via `getMonthlyUsage`.
- `credit_months` (`CreditMonthDoc`) — the **resettable** user-facing gate.
  Balance is derived, not stored: `allowance(2000) + bonus − consumed`.
- `credit_grants` (`CreditGrantDoc`) — append-only admin audit of every
  `reset` / `grant`, written in the **same transaction** as the balance change.

**A missing credit row reads as a full 2000 balance everywhere** — gate and
dashboard share that rule, so a never-touched month needs no pre-seeding
write. That, plus per-month primary keys, is the entire "monthly refill, no
cron": the first chargeable turn of a month lazily seeds *that* month's row
with an explicit allowance (its value is credit policy, seeded in code).

## Pricing + the charge signal

Build = 100 credits, edit = 5 (`chargeAmount(appReady)`), with `appReady`
derived SERVER-SIDE from the app row's status (only a `complete` app charges
the edit rate; the client's own `appReady` claim feeds nothing but a
disagreement warn). The advisory pre-flight balance read keys on `appId`
PRESENCE: the exact build rate for a new build, the edit-rate floor for an
existing app. There is deliberately NO second advisory read at the derived
rate: on the direct path the claim transaction's own affordability check
rejects pre-stream with the same 429, and a queued turn's final rate is only
known at the winning poll (a turn that derived build because the app was
mid-build usually wins as a 5-credit edit once that build completes), so a
derived-rate reject would falsely turn away an affordable turn. `isChargeableTurn`
decides charge vs. free continuation off the **last message's role**: a fresh
instruction ends with `user` (charge); an answered-`askQuestions` auto-resend
ends with the SA's `assistant` (free). It MUST read the **raw
`body.messages`**, never the route's cache-expiry transform — that transform
leaves a `user` message last on every POST and would charge every
clarification round-trip.

## Claim and reserve are ONE transaction

`claimAndReserveRun(appId, mode, runId, actorUserId, cost, expectedProjectId,
holderNonce, opts?)`
(and its new-build sibling `reserveForNewBuild`) runs, inside a single app-row-locked
transaction: fresh Project `edit` authorization, then the busy check
(`lease.live`, or a paused run of ANOTHER actor →
`RunConflictError`; the claimant's OWN paused run is SUPERSEDED instead — an
abandoned `askQuestions` round must not lock its own user out until the lease
lapses; the leftover refund + claim writes below resolve it and its late
answer bails via `reacquireLease`),
then — when `opts.requireModeMatchesStatus` is set — a mode re-derivation off
the LOCKED row's status (`complete` → edit, else build) that rejects a stale
requested mode with `ClaimModeStaleError(statusMode)` carrying the row's own
mode (the chat route always passes the flag: its mode was read off an
unlocked snapshot, and on rejection it adopts the thrown mode + rate and
retries bounded, so a claim can never book a mode the locked row no longer
supports),
the cross-app one-build-per-user scan (`GenerationInProgressError`), the
unconditional refund of any leftover UNSETTLED marker (a superseded
hard-killed run's stranded hold, refunded to ITS charged actor/period), the
literal-balance affordability check (`OutOfCreditsError`), the debit, the
fresh marker, and the claim writes (build → `status: generating` + fresh
`updated_at`; edit → `run_lock` lease + `status → complete` normalize).

The atomicity is the structural fix that retired a whole failure class: a
claimed app ALWAYS carries its claimant's marker, "claimed but unreserved" is
unrepresentable, and every rejection is a rollback that held nothing — so
there is no prior-state capture, no restore path, and no bail-out arm that
can leave an app in a shape it wasn't already in. The credit-debit body is
`credits.ts::debitAndBookReservation`, which the claim owns; the route places
the claim after every pre-stream rejection point so a booked charge is never
stranded by an early return. The refund of a failed/no-op run folds into the
idempotent `UsageAccumulator.flush()` targeting the period **captured at
reservation**, so a flush that crosses midnight un-books the right month. A
**failed run still accrues actual-$** — only the credits refund; the two
decisions are independent.

## Client vs server split

- `creditPolicy.ts` — **client-safe**: pure constants + rules, every import
  `import type` so no server data-layer package (`kysely`/`pg`) enters a
  bundle. Imported by the chat gate, the send-button cost chip, and
  `AccountMenu`.
- `credits.ts` — the **server** ledger: the in-claim debit, the refund/settle
  transactions, reset/grant, the summary reads.

## Finalization invariant — run-completion, not the request

In `/api/chat`, finalization (the charge-vs-refund decision + run summary +
actual-$ accrual) runs **once, on the run's true terminal state**, driven by
the agent drain COMPLETING — not by the browser connection: a closed tab
neither cancels the run nor finalizes it, and a zero-step model error still
finalizes.

**One reader for run liveness — `runLeaseState` (`runLiveness.ts`).** Every
liveness / ownership / paused / settled decision derives from that ONE pure
function; no other module reads the lease/marker columns for a decision (the
grep-guard test enforces it; `apps.ts`/`credits.ts`'s `leaseView` /
`rowReservation` / `rowRunLock` are the sanctioned row→view builders). A
build holds its app via `status: 'generating'` + the `updated_at` window
(`MAX_GENERATION_MINUTES`); an edit holds via its `run_lock` lease
(`MAX_RUN_MINUTES`). Those legacy minute-valued constants project the runtime
manifest's independently authored 600-second build and 900-second edit fields;
neither derives from the request cap, and the edit lease is renewable rather
than a total runtime bound. Both horizons refresh on
SA activity AND a wall-clock timer AND per commit (`refreshEditLease` /
`refreshBuildLiveness` + the guarded commit's per-commit stamp), so a LIVE run
never lapses; the heartbeat stops at finalize, so an abandoned paused run
lapses for the reapers.

**Serialize-with-wait, not 429.** A conflicting chargeable POST opens its SSE
stream and polls `claimAndReserveRun` (each poll is the whole atomic
claim+reserve), surfacing a "waiting on <holder>" event; a win arrives fully
gated, a timeout ends friendly, and a gate rejection from a won poll held
nothing.

**Terminal writers gate on ownership IN THEIR TRANSACTION** —
`completeAndSettleRun` (build: `generating → complete` + settle, one commit;
plus the false-reap SELF-HEAL: a reaped-but-unclaimed build that finished
cleanly flips back to `complete` off the reaper's signature — settled marker,
marker `runId` cleared, `run_id === runId`), `clearRunLockAndSettle` (edit: release +
settle, one commit), `settleAndRelease` (the failed-run writer: refund-if-
unsettled + settle + edit-lock release in one commit; its required mode and
`settled` return answer the separate question "does this admitted holder
capability still own the outcome—safe to `failApp`?"), and the flush-driven
`refundReservation`. Every SQL update uses `(mode, runId, nonce)` identity;
credit-mutating writers require exactly one affected row so a lost CAS rolls
the refund back. A reaped-then-re-claimed run's stale terminal write therefore
affects zero rows rather than clobbering its successor. A failed EDIT never
flips its `complete` app to `error` (that would brick a working app over a
transient model error).

The reviewed initial-build path composes `completeAndSettleRunInTransaction`
with its append-only `finished` orchestration event after case-schema
convergence. It takes the actor gate, proves the still-live delegated app
holder or the exact unreclaimed false-reap signature, exact-sequence-CASes the
app, settles the charge, and inserts the event in one transaction. The reaped
arm still re-proves Project membership, actor, root run/nonce, canonical
sequence, and event head. Completion therefore cannot release the authority
required to record its own terminal state, and a rolled-back terminal event
cannot leave an app marked complete.

The canonical commit guard keeps a materialized reviewed build frozen until
its orchestration head is terminal. `finished` is the only current successful
terminal state; the retired `accepted-partial` arm remains terminal solely so
apps released through the historical **Use what’s built** path stay editable.
A failed or interrupted current build remains frozen even after its live lease
has gone away.

**Reapers re-validate staleness IN-TXN.** `reapStaleGenerating` →
`refundStaleGeneration` (stale build: refund + `generating → error` +
`paused_timeout` classification for an abandoned pause) and
`reapStaleReservation` → `refundStaleReservation` (stranded edit: refund +
settle + release the lapsed lock) require the exact holder identity captured by
their scan, compare it again under the app lock with `(mode, runId, nonce)`, and
repeat it in the SQL CAS. They also re-derive `reapable*` off that locked row,
so even a delayed reaper cannot claw back a later holder that has independently
gone stale. Both key on the LAPSED LEASE, not `awaiting_input`, so they free
hard-killed AND abandoned-paused runs; both CLEAR the reaped marker's `runId`
(the reaper's signature for the self-heal + non-lenient holder read) when the
reaper settles an unsettled marker. A build marker already settled by its own
failure flush retains its `runId`; it deliberately cannot masquerade as a false
reap or
self-heal. Refunds always target the
marker's charged actor (`res_user_id`, falling back to `owner` for markers that
lack it). A missing marker run id is still refundable for an edit whose lock
provides a concrete holder id; a build with neither a concrete reservation id
nor pre-reservation root id fails closed as corrupt and is never queued.

**Resume re-acquires — renew, don't get reaped.** A free-continuation resume
calls `reacquireLease`: one transaction asserting `ownedByResume` (keyed on
the RESUME's own mode), freshly authorizing its actor, and, on success,
re-establishing the mode's horizon +
clearing `awaiting_input`. A missing or mismatched nonce returns
`"refresh_required"`. Other lost resumes touch
nothing and distinguish `"superseded"` (another holder) from `"released"` (the
reap freed it).

**Pause and prelude cleanup are exact-holder writes.** `setAwaitingInput`
locks the app, compares the caller's Project snapshot, freshly authorizes the
actor, accepts the caller's mode, and applies the pause only while the locked
holder identity equals the currently admitted capability; its SQL update
repeats the same compare-and-set. It returns owned/superseded/released and
throws infrastructure faults. The route treats lost ownership as a terminal,
non-owning, non-paused stream, so no stale question becomes resumable on a
successor. `clearRunLock(appId, runId, holderNonce)` is the awaited
prelude-failure net: under the app lock and SQL CAS it clears only that admitted
edit holder; a replacement or reap is a clean no-op.

## Guarded commit

The transaction body lives in `canonicalCommitKernel.ts` — the ONE canonical
commit service (`commitCanonicalBatch`) plus the shared locked-app plumbing
every protocol in `apps.ts` composes (the strict persisted-app admission,
`lockAppRow`, the exact media projection, the authoritative lookup context,
the membership/Project assertions, `writeCommittedBatch`). `apps.ts` keeps the
public wrappers (`commitGuardedBatch`, `commitGuardedBatchInTransaction`) and
re-exports the moved symbols, so ordinary callers never import the kernel;
only server-owned commit hosts compose its transaction hooks
(`CanonicalCommitTransactionHooks` — the `beforeWrite` seam case-store Phase A
rides, plus the typed `sidecars` seam). The dependency arrow is one-way:
apps → kernel.

**Kernel sidecars are a closed, typed vocabulary** —
`canonicalCommitSidecars.ts`, never arbitrary closures. A sidecar runs inside
the same retryable app-locked transaction AFTER the committed-batch write
tail (so a lost holder CAS has already aborted), with the
kernel's authoritative seq/batch id/candidate — never caller-asserted ones.
The Atomic Change Set runtime has one variant: `commit-design-change-
set` (lock the `design_change_sets` row AFTER the app lock — canonical order
— verify status/revision/lineage, flip `open → committed`, insert the
immutable `design_committed_slices` receipt). A dedup hit skips sidecars entirely:
the original commit ran them, and a canonical batch without its receipt is
corruption for the caller to detect, never a new commit.

**The change-set tables are private staging state, not app history.**
`design_change_sets` is the one mutable authority row (read-write; row-locked
to serialize its ledgers); `design_change_set_requests` / `_steps` /
`_step_stages` / `_handles` and `design_committed_slices` are append-only runtime DML — never row-locked, never
updated, never streamed (no NOTIFY channel exists for them; nothing here may
poke realtime). Step mutations, receipts, and read sets are
authoritative persisted JSON: `::text` reads through `persistedJson.ts` +
strict schemas only. `design_session_id`, design revision, build plan, and
attempt identities are foreign-key-bound to the durable design/orchestration
tables. A Project
move deliberately does NOT re-tenant change-set rows: `base_project_id` is
captured base scope, an open set strands terminally (its commit rejects),
and committed lineage is app-keyed. The runtime contract lives in
`lib/agent/change-set/CLAUDE.md`.

**The design-artifact tables are the pipeline's durable record, not app
history.** `design_source_packages`, `design_revisions`, `design_reviews`,
`design_review_dispositions`, and `design_build_plans` are all append-only
runtime DML — insert-only artifacts, never row-locked, never updated,
never streamed. Every JSONB envelope/payload is authoritative persisted
JSON: `::text` reads through `persistedJson.ts` + the exact producer
schemas, with the canonical-JS artifact digest re-verified on every read.
`design_session_id` is bound to `design_sessions(id)`. The read/write
boundary and
integrity rules live in `lib/agent/design/artifactStore.ts`
(`lib/agent/design/CLAUDE.md` is the contract).

`design_artifact_workspaces` is the private mutable authoring carrier for one
contract, revision, or plan candidate; `design_artifact_workspace_steps` is
its append-only operation ledger. Every open/read/stage/finalize transaction
locks and authorizes the exact live design-session/app holder plus current
Project membership before touching the workspace. The operation ledger is
never row-locked. A stage is idempotent only for the same provider
`tool_call_id` and input digest, advances an exact expected revision, and is
invisible to app history and user surfaces. Finalization validates the replayed
candidate and changes `open → finalized` in the same transaction that inserts
the immutable artifact; lineage binds the exact source package plus immutable
base/reviews. A source-package change rebinds same-phase/base/review work only
when content-free projection digests prove a byte-identical prefix extension;
different or missing source and different immutable ancestry supersede the open
workspace. Per-call and cumulative per-POST bounds prevent runaway work
without a persistent stage cliff that could strand a candidate after final
validation.

`design_model_contexts` is the mutable ordinal carrier for the exact private
model transcript of each reviewed-design role. Its item and step children are
append-only tenant data: model-visible bytes live only in
`design_model_context_items`, while `design_model_steps` carries payload-free
request/response evidence. A model, prompt, tool digest, or context-format
change inserts the next linked generation and leaves the prior generation
immutable; stale writers are rejected once that successor exists. Ordinary
phase and workflow transitions append to the current generation rather than
creating another context.

`design_model_step_usage_accounts` is the exact-once bridge from a completed
provider step to cost accounting. The response bytes and usage-bearing
completion event commit together first. On request finalization, insertion of
its `(context_id, step_key)` account, the cumulative `run_summaries` delta, and
the `usage_months` dollar/token delta share one transaction. Recovery may offer
the same completed response repeatedly; only the transaction that inserts its
account includes that contribution. No timestamp or process-local watermark
decides whether paid work counts. The transaction also returns the cumulative
run cost; a zero-cost credit refund is legal only after that authoritative write
succeeds and proves the complete run still has no paid work.

`design_slice_attempt_budget_claims` is the append-only idempotency ledger for
executor sub-budget units. The mutable attempt row is locked while one stable
claim key is inserted and its matching counter advances; replay of that key
returns the existing claim without incrementing the counter again.

`commitGuardedBatch` is the one blueprint write every surface shares (chat,
MCP, auto-save, the cross-Project move): lock the app row → dedup latch read
→ reject when the row no longer matches the caller's required
`expectedProjectId` → reauth against the fresh Project membership row →
while a materialized initial design is unfinished, reject MCP/autosave callers
that cannot carry its exact live chat holder capability (the durable terminal
head keeps failed partial builds frozen after their lease is gone) →
assemble + hydrate the fresh doc →
`mutationTargetsInvalid` → re-run verdict → literal `seq + 1` → entity-row diff
write + the permanent app-change row + the in-commit NOTIFY. The per-commit edit
lease refresh rides the same transaction when the committing run owns the
lock. The media reference projection is SPLIT by carrier family: every app
writer derives the complete poststate AUTHORED projection from the
Blueprint's references alone, locks the referenced asset rows sorted
`FOR SHARE`, verifies same Project, `ready`, and exact media kind, then
deletes and reinserts the app's exact `media_asset_refs` rows in that SAME
transaction; every THREAD writer replaces only ITS thread's
`thread_media_refs` rows (`mediaAssets.ts::replaceExactThreadMediaReferences`,
same asset locks and verdicts, row written after the thread row it is a
child of) in the transcript transaction. Neither family can overwrite the
other, and deletion checks BOTH. Atomic creation, `appendSyntheticBatch`,
and Project move apply the identical rule. A Project move refuses an unfinished
materialized reviewed build even after its holder is reaped, so it cannot
advance the canonical sequence out from under the frozen plan. The move
additionally rewrites
each thread's rows from its remapped transcript with destination ids and
Project, and re-tenants the app's bound design sessions
(materialized/completed/edit; an active pre-app session never moves).

**Form attachments are a separate lane from `media_assets`, on purpose.**
`formAttachments.ts` holds the files a worker attaches while filling in a form:
`pending → staged → preparing → prepared → submitted`, tenant-scoped
`(app_id, project_id)` like case rows and additionally bound to `created_by`
because the idempotency/reservation key is client-minted. A preparation
transaction locks the current app row, freshly proves Project `edit`
membership, then locks the entry and moves the exact selected
`(attachment_name, field_uuid, instance_path)` rows to `preparing` before any
GCS copy. Revocation after the route's initial Submit gate therefore wins
before durable-copy work starts. `formAttachmentPreparation.ts` copies the
immutable confirmed generation to a deterministic create-only durable key,
verifies a pre-existing destination by size/CRC32C/type, and records
`prepared`. Every later case-store submission — text-only or attachment-bearing
— first claims `form_submission_intents` under the entry lock. When attachments
are present, that same transaction accepts only `prepared` and moves those rows
to `submitted`; it then applies every case effect and stores the replay result
atomically. A case failure removes the uncompleted receipt and restores
`prepared`; no post-commit external await can make an accepted form appear
failed.
The Server Action's preflight is ordered the same way: one transaction locks
the app `FOR SHARE`, proves fresh Project membership, and reads a durable
receipt before hydrating any form/capture topology. A receipt returns without a
blueprint read; otherwise the committed app snapshot from that transaction is
the sole input to operation-program and capture-authority derivation.
The intent is still built for a capture-capable committed form when the current
attachment projection is empty. `attachments: []` therefore reaches the prior
receipt check before any case effect: the same digest replays the stored result,
while a changed payload under that entry key is rejected. Text-only forms carry
the same submission receipt but create no capture intent or attachment rows.

The request prepares its selected rows immediately; the five-minute Cloud
Scheduler job leases bounded `preparing`/`discarding` batches with `FOR UPDATE
SKIP LOCKED` and retries with backoff. The DB-first transition plus deterministic
final key makes a crash before the row update recoverable by destination
verification. A foreground Submit retry may make a row due immediately only
when the prior worker recorded an error; an active lease has no recorded error
and cannot be stolen, while unattended scheduler failures keep their backoff.
`captureCleanupLease.ts` holds one session advisory lock for the whole
maintenance run, collapsing at-least-once or overlapping scheduler deliveries
to one active worker. The worker always runs the same preparation, verification,
discard, and expiry sweep; there is no alternate mode or deploy-time
invocation. Its pool max is two (the lock session plus one work connection).
Its isolated login role has no runtime membership and receives only
public-schema `USAGE` plus `SELECT`/`UPDATE`/`DELETE` on `form_attachments`;
migration-time convergence revokes access to every other managed table, the
case schema, and attachment insertion/administration. The cleanup role's hard
connection limit is three. A held lease or pre-lock SQLSTATE `53300` skips that
dispatch; a `53300` after this process owns the lock is an active-worker
failure. After winning, the owner prewarms its second connection with a bounded
retry so Kysely reuses that admitted session; a stuck reservation fails the
Job.

`captureCleanupSchemaProbe.ts` is the cleanup image's strict post-migration
proof. Under the cleanup login it compares the ordered
`form_attachments` column/type/nullability inventory to the checked-in final
contract, then executes zero-row `SELECT`/`UPDATE`/`DELETE` statements and
intentionally rolls the transaction back. `scripts/cleanup-form-attachments.ts
--probe-schema` runs only that proof, bundled into the image as
`capture-cleanup.cjs`. Cloud Build verifies the scheduler's preexisting state
was not changed by the Job update. It does NOT require the scheduler to be
paused: pausing is the maintenance-cutover prestate, and on an ordinary deploy
the scheduler is ENABLED while the probe runs.

GCS lifecycle remains the traffic-independent
backstop for ordinary staged/browser-abandoned source bytes, but cannot
atomically distinguish DB acceptance; accepted durability therefore requires
the verified destination outside that TTL prefix before commit. The scheduled
worker and initiate-route sweep share `purgeExpiredFormAttachments`. Repeat
compaction preserves attachment-id identity and CAS-moves only a `staged` row's
concrete `instance_path` under the same entry advisory lock; pending uploads
cancel, `preparing`/`prepared` rows are fenced from retarget, and `submitted`
rows are immutable. A CAS mismatch returns the locked row's authoritative path
instead of rejecting it, so a client that lost an earlier successful response
can adopt that coordinate and continue toward the latest repeat position.
Clear/expiry moves `preparing`/`prepared` through
`discarding`, where exact source and destination generations are deleted before
the metadata row.
Every item-route helper also takes the URL's `expectedAppId` and includes it in
all candidate, lock-following, CAS, and delete predicates. Project membership
alone never lets app B's URL read, confirm, retarget, or delete app A's row
inside the same Project; absent/foreign/terminal cases retain the same collapsed
not-found shape.
Initiation is bounded independently by a fixed-minute Project/actor counter,
per-entry attempt rows, and Project-wide row/byte quotas; the Project quota
advisory lock makes each admission decision serial across apps.

A captured photo is data, not an authoring asset; a library row would surface it
in the media picker, count it against the export budget, and make it deletable
through the library UI. Project moves currently block under the app lock if
either capture rows or submission intents exist; there is no partial move that
can strand capture evidence in the source tenant.

**Media deletion is one authoritative transaction.**
`mediaDeletion.ts` takes the shared membership gate, freshly proves Project
`edit`, locks the asset `FOR UPDATE`, then re-walks every persisted
Blueprint carrier (including soft-deleted app rows) named by that asset's
exact `media_asset_refs` candidates without taking app locks, checks the
conversation family through the asset's exact `thread_media_refs` rows
(pre-app design-session threads included), and deletes metadata only when
both families are empty. The thread writers' per-thread projection is the
family's authority, but deletion is the one IRREVERSIBLE consumer (the
bytes purge post-commit), so when the projection shows no conversation
reference the guard re-proves absence against the transcripts themselves —
a Project-scoped containment prefilter narrows to candidate threads, and a
candidate whose transcript names the asset, or whose attachment metadata
cannot be parsed to prove it doesn't, blocks the deletion.
Each app root, its normalized blueprint entities, and thread messages come from
one correlated SQL statement snapshot, so an atomic carrier relocation cannot
fall between separate READ COMMITTED reads.
The exact whole-app projection is the candidate authority; there is no
completion marker or full-Project fallback scan. This lock conflicts with the
writer's asset share lock, so attach/delete has two safe winner orders. Object
cleanup is post-commit and serialized with every publisher by the canonical
extension-independent Project/hash content session lock.

## Period leaf

`period.ts` is a dependency-free leaf holding `getCurrentPeriod` (UTC
`yyyy-mm`). Both ledgers key on it; keeping it out of `usage` breaks the
`usage ↔ credits` import cycle (`usage → credits → period`).

## Auth-adjacent modules

`api-keys.ts`, `oauth-consents.ts`, and `admin.ts`'s user-list half read the
`auth_*` tables through `getAuthDb` (`@/lib/auth/db`) — Better Auth owns
those tables' creation; this package reads/writes them directly for the admin
dashboard, revocation checks, and the OAuth consent surface. `admin.ts` joins
the per-user usage/credits/app-count figures from this package's own tables.
