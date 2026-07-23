# lib/db — the app-state data layer (Postgres) + the two-ledger credit model

Everything Nova persists about apps, runs, credits, threads, media metadata,
lookup tables, and settings lives in Postgres tables on the shared Cloud SQL pool. `pg.ts`
owns the wire: `getAppDb()` (a `Kysely<AppDatabase>` on the pool
`lib/case-store/postgres/connection.ts` owns), `withAppTx` (the one
transaction entry point — bounded deadlock/serialization retry; a body re-runs
from scratch on retry, so it stays pure of side effects), the table types
(lock-stepped with the DDL in `lib/case-store/migrations/`), and the
LISTEN/NOTIFY poke helpers. `types.ts` owns the assembled record shapes.

**Lock ordering is the concurrency discipline.** Every transaction that
decides anything about a run locks the APP ROW first (`SELECT … FOR UPDATE`
via `lockAppRow`), then touches other rows (credit months, entities, the
stream). Per-app contention resolves as row-lock waits, and every decision
reads row state inside the locking transaction.

**Builder hydration is one authorized snapshot.**
`appAccess.ts::resolveAuthorizedAppSnapshot` holds `apps FOR SHARE`, then the
shared Project-membership advisory gate and exact `auth_member` row, while
`apps.ts::loadAppInTransaction` assembles `blueprint_entities` on that same
transaction. The returned Project, role, `canEdit`, blueprint, and `baseSeq`
therefore belong to one serial winner. `GET /api/apps/[id]` keeps
`mutation_seq` as a rolling-client alias for `baseSeq`; new code must not
reintroduce separate app-row, entity, membership, or cursor reads for this
surface.

**There is no blueprint blob.** An app is its `apps` row (scalars +
denormalized list fields + the run lease and credit marker as nullable column
groups) plus one `blueprint_entities` row per module/form/field.
`blueprintRows.ts` is the projection: `assembleBlueprint` (rows → the exact
`PersistableDoc`, Zod-validated), `decomposeBlueprint` (inverse; membership
arrays round-trip via the stored `ordinal`), `diffBlueprints` (the minimal
row-set a commit changed — diffed per entity by content, NOT by mutation
targets, because reducer side effects like a rename's prose cascade touch
entities the batch never named). `apps.app_name` stores the TRUE (possibly
empty) name; list projections apply the `UNTITLED_APP_NAME` display fallback.

**`accepted_mutations` is permanent history.** Every committed blueprint batch
appends one row — no TTL, no prune. It is the realtime catch-up stream AND the
app's durable edit history: folding every batch from an app's first seq
reproduces its entity rows (an app whose history was seeded from a snapshot
starts at that snapshot's seq, not seq 1). A `migration` row tells live clients
to reload, but it still stores the deterministic mutations when the blueprint
changed; an empty migration batch is reserved for an atomic non-blueprint
change such as a Project-only move, never a fake whole-document replacement.
System repair/migration writers use a named `system:<task>` actor; user-driven
synthetic writes retain the actual user id. `UNIQUE (app_id, batch_id)` is the idempotency latch (the guarded
commit reads it under the app row lock; a concurrent same-batch retry that
races past the read is caught by the constraint and converges on the deduped
result). Future blueprint-shape migrations must migrate the STORED MUTATIONS
alongside the entity rows or historical folds stop reproducing state — the
scan script's fold check is the tripwire.

**Realtime pokes ride LISTEN/NOTIFY.** `writeCommittedBatch` calls
`pg_notify('nova_app_stream', {appId, seq})` INSIDE the commit transaction
(delivered on commit, after the rows are visible); presence reauthorizes against
the app row + exact membership and writes/sweeps/deletes + pokes
`nova_presence` in that same transaction; chat chunk-log appends poke `nova_chat_stream`; lookup writers
poke `nova_lookup_stream` with an exact decimal Project revision. Payloads are
pokes only — the relay (`app/api/apps/[id]/stream`) and the chat-resume
endpoint SELECT durable state from their cursor/scope, so a missed notification
degrades to the next poke/catch-up, never to lost data. `streamListener.ts`
owns ONE dedicated client per instance outside the pool and LISTENs on all four
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
edges; a null-Project app cannot gain a nonempty set, and missing/foreign targets
share one opaque error.

`apps.ts` is the authoritative protocol. Every `createApp`,
`commitGuardedBatch`, `appendSyntheticBatch`, and dormant
`commitAppProjectMove` transaction declares lookup writer v0. Creation prepares
the template exactly once outside the retryable transaction, then takes the
shared Project-membership advisory gate, authorizes, inserts the root,
locks/reads lookup definitions, evaluates, checks template
export readiness, replaces edges, and inserts entity rows atomically. Ordinary
commits lock the app, compare the caller's required `expectedProjectId`, check
the dedup latch, take the shared membership gate,
lock and authorize the actor's exact `auth_member` row in the SAME transaction,
hydrate the fresh doc, reject
reducer-minted identity mutations, prepare once, lock the union of prior and
candidate lookup tables, evaluate against that snapshot, replace the complete
edge set, then write rows + history. Missing or foreign tables become one
Nova-language `BlueprintCommitRejectedError`; operational SQL errors are not
misreported as user fixes. `applyBlueprintChange` treats caller-supplied
whole-doc projections as advisory and derives schema work from the guarded
deterministic mutations.

`appendSyntheticBatch` requires an exact expected sequence and explicit user or
named-system authority. After locking fresh state it diffs to the requested
target, proves replay identity, and persists the actual mutations; a true no-op
writes no row and advances no sequence. The dormant Project move now implements
the final transaction but remains production-disabled. Its v1 test seam requires
the enabled compatibility row, writer/receiver v1, and no incompatible live
stream; the production wrapper declares the manifest's real writer v0 and fails
closed. Under the app lock it takes the membership gate, locks the actor and all
source-owner membership pairs across both Projects, enforces dual `delete` plus
owner retention, rejects deleted apps, classifies runs only through
`runLeaseState`, and requires structural/stored lookup targets to match exactly
and both be empty. The final transaction locks threads and destination assets,
remaps blueprint and canonical transcript attachment ids, re-tenants all cases,
purges presence, flips `project_id`, appends one attributed migration batch, and
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
`CREATE` only in that isolated case schema for concurrent index DDL and receives
read-only access to compatibility state, not control-table mutation. All
destructive-schema,
carrier-commit, and true Project-move flags remain false.

Run claim/reserve, paused-run reacquire, soft-delete, and restore use that same
app-row-first membership protocol; no route preflight decides their admission.
Migration-bearing blueprint saves use
`withAuthorizedAppEditSideEffect`: one non-retrying transaction and one physical
connection lock the app, compare the caller's Project snapshot, freshly authorize,
then run every sorted case-schema/data Phase A. The transaction commits as a unit;
only afterward do concurrent-index Phase B completions run, followed by a separately
fresh `commitGuardedBatch`. An admission denial or Phase-A/outer-commit failure
therefore has nothing to compensate; a Phase-B or blueprint-commit failure
compensates the already-durable reports.

`lookup_stream_capability_leases` carries an
app-scoped, database-minted connection UUID plus a required receiver version and
expiry; it is rollout state, not lookup data or blueprint state.
`streamReceiverCapabilities.ts` is the pure server admission boundary: it
requires exactly one strict browser `receiverVersion`, clamps compiled support
to the strictly parsed deployed environment, requires stream registry v1 on
both sides, and admits the minimum browser/server receiver version.
`streamCapabilityLeases.ts` owns the stateful half. Registration composes
`apps FOR SHARE` -> serialized fresh Project membership/view authorization ->
compatibility `FOR SHARE` -> floor verdict/lease insert in one transaction.
Postgres mints the UUID and derives `created_at` plus the exact manifest TTL
from statement time after lock waits. A below-floor request has no lease or
stream setup; the route returns only a seq-less `client-upgrade-required`
revocation. An admitted stream captures Project/role/canEdit and reloads when
that tuple changes, but cadence reauthorization deliberately does not read the
receiver floor, so raising it cannot evict an already-admitted connection.
Migration rows reauthorize before advancing their private cursor; transient
failure leaves the row pending for retry. Teardown disowns subscriptions,
pumps, timers, and transport first, then best-effort deletes the exact
app/connection lease; expiry is the crash fallback. Each registration then
runs a separately committed, best-effort purge of at most 256 expired rows.
Its `expires_at`-ordered candidate query uses the expiry index and `SKIP
LOCKED`; it never shares the admission transaction's app/membership/floor lock
set, and an operational purge failure cannot reject an admitted stream.

`lookup_reference_compatibility` is one permanent `id = 1` row. Its writer,
stream-receiver, and runtime-reader floors are nonnegative and monotonic; flags
may be turned off but can turn on only at their database-enforced floor
thresholds. Statement-level database guards protect app creation/deletion,
`apps.mutation_seq`/`project_id` changes, every blueprint-entity write,
accepted-mutation inserts, and destructive lookup table/column writes. Each
guard locks the singleton `FOR SHARE`, making a floor increase a linearizable
cutoff; missing state and stale writers fail with non-retryable SQLSTATE
`55000`. An unset writer is version 0. Later writers must call
`setTransactionWriterVersion(tx, version)` inside their transaction; its
`set_config(..., true)` value is transaction-local and must never be installed
as a pooled session setting. `lookupReferenceWriter.ts` is the one transaction
declaration seam. All authoritative call sites use
`declareLookupReferenceWriter(tx)`, whose current value derives from
`config/runtime-capabilities.json` through the validated runtime accessor; it never
owns a second numeric literal. S05 changes the manifest's single
`writerVersion` field from 0 to 1 when its first production carrier lands.

Runtime-reader rollout state is database-owned too. `runLeaseState` derives the
holder identity: edit is `(edit, lock_run_id, run_holder_nonce)`; build is
`(build, res_run_id, run_holder_nonce)`, with `run_id` used only while a
generating build has no reservation marker. `runId` remains stable attribution;
the server-minted UUID nonce is the per-claim generation. The
`apps_runtime_reader_holder_stamp` row trigger reads transaction-local
`nova.runtime_reader_version`, checks the runtime floor under `FOR SHARE`, and
uses the declaration as writer capability—not proof of ownership over an
existing holder. Below cutoff, an exact unchanged legacy holder stays v0 and
census-visible; an unchanged old stamp below the active floor fails closed. A
new/replaced v1 holder requires a concrete run id + nonce and receives the
current stamp. An absent declaration is deployed v0 and clears any inherited
nonce/stamp (even when a stable thread id makes mode/run appear unchanged).
Release clears the stamp—but
retains the nonce tombstone—when the holder disappears. Existing null-nonce
holders are not backfilled and census as v0; replay clears only present
null-nonce stamps, so a v1 holder survives migration replay. The trigger
includes `awaiting_input`, `lock_expire_at`, and `updated_at` because the
deployed v0 paused-resume SQL
sets no runtime GUC while updating only those columns. `runtimeReaderVersion.ts`
derives the v1 declaration from the capability manifest. Every current
holder-touching path calls `declareRuntimeReader(tx)` before DML: generating
creation, build/edit claim, reservation, paused reacquisition, same-holder
blueprint commits, heartbeats/pause writes, and terminal/failure/reaper/recovery
writes. Complete/template creation does not declare because it creates no
holder. Every build claim also stamps root `run_id` before emitting any mutation,
so a later no-mutation successor remains the durable latest-claim identity after
reap.

`runHolderWrites.ts` owns the shared SQL compare-and-set predicates.
`lookup_reference_compatibility.run_holder_nonce_enforced` defaults false: in
that compatibility state admission/CAS uses legacy `(mode, runId)`, and after
its irreversible activation it requires `(mode, runId, nonce)`. The database
constraint forbids activation below runtime-reader floor 1. Every lifecycle
transaction locks the app row first and then reads compatibility `FOR SHARE`
before credit rows or its holder write. Terminal, failure, heartbeat, pause,
and reaper updates repeat the admitted predicate; credit writers throw on a
zero-row result so their earlier ledger refund rolls back too. Operator
recovery is deliberately stricter and always requires the exact generation,
even before activation. An absent holder is never terminal authority, and a
present holder with a missing/blank run id is corrupt rather than canonically
reapable; a concrete run id with null nonce is a legacy v0 holder and MUST stay
reapable while compatibility is false so rollout can drain it. Chat mutation
commits carry a separate full `ChatRunHolderCapability`; ordinary `runId`
remains attribution because MCP also stamps one without owning a chat lease.
Migration Phase A checks that capability while holding the app row, and the
final guarded app-row write repeats it as a SQL compare-and-set;
entity/reference/history work rolls back on a lost CAS. The sole absent-holder
exception is the falsely-reaped-build self-heal, whose SQL predicate proves the
free row, marker-cleared reaper signature, and exact last `run_id` (plus nonce
after activation). A stale build whose marker was already settled keeps
`res_run_id`; that is deliberately not the reaper signature and is
non-self-healable. Reaper scans and conflict nudge/list queues narrow the observed holder
to a concrete identity before enqueueing it and carry that token all the way to
the locked write, so an arbitrarily delayed reap cannot target a later holder
that also went stale. `scripts/recover-app.ts` writes only through
`recoverAppStatus`: a present holder requires explicit `--holder-mode`,
`--holder-run-id`, and UUID `--holder-nonce` flags, and the service rechecks the
exact generation under the app lock and in SQL. A v0/null-nonce holder is not
operator-recoverable through this command.

Threads persist the active nonce in a dedicated `active_holder_nonce` column.
`upsertThreadTurn` locks the app row, reads compatibility `FOR SHARE`, and proves
the admitted holder before taking the thread lock or installing its marker. A
lost holder may merge its real incoming transcript into an existing same-app
thread, but the merge-only arm cannot replace or clear the successor's
`run_id`, `active_stream_id`, or `active_holder_nonce`; it commits that merge and
then throws `RunHolderLostError` so the route stops before publishing the stale
capability.
`loadThread` projects it only when fresh app authority says this exact run and
nonce is paused by the requesting actor; co-members, unscoped loaders,
mismatches, unpaused holders, and reaped holders receive no nonce. A paused
finalize retains it for the answer POST; a terminal finalize clears it only
when its stream id still owns the marker. The durable chunk log never stores
the nonce itself: the POST writer records one inert chunk at the same index,
carrying only the thread id and a SHA-256 nonce digest. The reconnect route
rehydrates it through the retained-thread/current-holder actor proof. Other
Project viewers receive the inert marker, so shared replay stays count-identical
without sharing continuation authority; an old same-run stream's digest also
cannot resolve to a successor generation. Every client activation from a
server-loaded thread adopts `run_id` and the optional `holder_nonce` together;
an omitted nonce authoritatively clears any capability from the prior
activation rather than retaining it by accident.

`runtimeReaderHolders.ts` is the fail-closed census projection over
`runLeaseState`: every present holder blocks a higher target when its effective
version is lower, including live, paused, reapable, corrupt, unstamped, and
soft-deleted rows. Reapable classification precedes paused/live. Floor raising
must never use the 10/15-minute renewable liveness horizons as total drain
bounds.

`rolloutCompatibility.ts` is the only named compatibility-operation service.
Its status read is one repeatable-read snapshot. Traffic reconciliation and
runtime-epoch preparation invoke their control-plane snapshot callback only
after taking the fixed deployment-cutover gate; that callback must perform a
fresh read when invoked and must never return a pre-captured/cached split. Their
in-transaction variants exist only for a future explicitly approved activation
mechanism that already holds the session gate on the same dedicated backend.
S02c2 does not mutate traffic, prepare an epoch, or raise a floor.
Reconciliation may preserve/start the
registry interval and delete invalid runtime epochs, but never auto-creates an
epoch. Runtime floor raise locks cutover → compatibility `FOR UPDATE` → plain
MVCC holder census (never app rows); the initial stream floor requires a full
manifest-derived stream TTL of continuous registry traffic. S02c1 exposes only
explicit emergency flag disablement—no flag-enable bypass. Stream registration
must compose `apps FOR SHARE` → membership gate/read →
`readStreamReceiverCompatibilityForShare(tx)` → floor verdict → lease insert in
one transaction.

**`chat_stream_chunks` is the resumable-chat log — operational, not
history.** The chat route's `DurableStreamWriter` (its ONE write choke point)
appends every UI chunk a POST streams, in write order, batched; the reconnect
endpoint (`app/api/chat/[streamId]/stream`, the server half of the AI SDK's
`WorkflowChatTransport` contract) replays from a client cursor and tails
live, so a broken connection (network blip, Cloud Run's 60-min request cap)
resumes instead of losing the run. Every stream is guaranteed to END: the
writer seals a terminal row (synthesizing the `finish` chunk on error paths),
and a run that died sealing nothing is closed by the endpoint's
`appHeldLive`-based fallback. Rows prune past `CHAT_STREAM_RETENTION_MS`
(opportunistically, on POST traffic) — conversation HISTORY lives in
`threads` + the event log, never here.

**`threads` is the durable conversation store — one row per CONVERSATION,
spanning runs.** `messages` holds the full `UIMessage[]` transcript,
server-written by the chat route at exactly two moments (`lib/db/threads.ts`
is the whole contract): `upsertThreadTurn` the instant a run claims the app
(persists the incoming history + marks the thread live via
`active_stream_id` — the page-refresh resume handle), and
`appendThreadResponse` at finalize (the assistant message assembled from the
chunk log by `assembleResponseMessage`). (A BAILED POST —
serialize-wait gate/timeout, superseded resume — additionally merges its
incoming messages via `mergeThreadTurnMessages`, identity/marker untouched,
so an answered question round survives the refresh the bail recommends.)
Every thread writer locks the app before its deterministic thread-row lock, so
the dormant Project move is a serial winner rather than a whole-history race.
Writers MERGE by message id (`mergeTranscript` — union, richer version wins),
never rewrite: a stale tab or a late finalize can add turns, not erase them,
and an askQuestions continuation lands as ONE merged message. For a shared
message id, stored `metadata.attachments` is authoritative even when an incoming
version wins the parts tiebreak; a stale source-Project history therefore cannot
restore asset ids the move already remapped. Every newly persisted canonical
attachment is admitted in that same app/thread transaction: its current Project
and ready status are rechecked under an asset `FOR SHARE` lock and its reverse
reference is inserted before the message write. Chat admission passes its expected
Project to turn/upsert and bail-history writers, which stop if the app moved
before they acquired the app lock. The finalize
retires the live marker ONLY while it still names its own run's stream (the
app releases before finalize completes, so a newer claim may already own a
fresh marker) — with one retry then a marker-only clear, because a marker
stranded on a FINALIZED run reads as an instance death and would re-drive
(re-charge) a completed turn. The loaders reconcile any marker against
actual app liveness (`appHeldLive`) REPORT-ONLY: a dead marker is stripped
from the projection and stamped `resume_interrupted`, but the row is never
written — the signal is LEVEL-TRIGGERED, standing load after load (any
reader may run first: the thread list, a heal refetch, the page) until an
acting client's RE-DRIVE retires the marker through its own claim +
finalize. The re-drive re-runs the interrupted turn through the normal
POST/claim/charge machinery (`redrive: true` on the wire; a claim conflict
there means another session already re-drove, so the request closes clean
instead of serialize-waiting a duplicate). A died BUILD (reaped to `error`)
is admitted by the build page only on this signal, and its re-drive claim
flips the row back to `generating`.
The reconnect endpoint resolves a GET id as stream-first, thread-second, so
`useChat`'s `resumeStream({chatId: threadId})` reconnects a refreshed page
to the in-flight run by thread id alone; a thread with nothing in flight
answers a bare `finish` (the transport errors on any non-OK response).
`updated_at` orders the list (a refresh opens the most recent thread);
`thread_id` is the PK (client-minted uuid) with writers app-guarded so a
forged id can't write across apps. Every POST sends the thread's FULL
history — there is no cache-window trim (the run summary's
`fresh_edit`/`cache_expired` fields retired with it).

## Two ledgers, different lifecycles

Cost and quota live in **separate tables** so an admin intervention on one
never disturbs the other:

- `usage_months` (`UsageDoc`) — dollar cost, **accumulate-only**: the
  `cost_estimate` counter (token math over `MODEL_PRICING`, which with a
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

Build = 100 credits, edit = 5 (`chargeAmount(appReady)`). `isChargeableTurn`
decides charge vs. free continuation off the **last message's role**: a fresh
instruction ends with `user` (charge); an answered-`askQuestions` auto-resend
ends with the SA's `assistant` (free). It MUST read the **raw
`body.messages`**, never the route's cache-expiry transform — that transform
leaves a `user` message last on every POST and would charge every
clarification round-trip.

## Claim and reserve are ONE transaction

`claimAndReserveRun(appId, mode, runId, actorUserId, cost, expectedProjectId,
holderNonce)`
(and its new-build sibling `reserveForNewBuild`) runs, inside a single app-row-locked
transaction: fresh Project `edit` authorization, compatibility `FOR SHARE`,
then the busy check
(`lease.live`, or a paused run of ANOTHER actor →
`RunConflictError`; the claimant's OWN paused run is SUPERSEDED instead — an
abandoned `askQuestions` round must not lock its own user out until the lease
lapses; the leftover refund + claim writes below resolve it and its late
answer bails via `reacquireLease`),
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
neither derives from the request cap or 3,900-second stream lease, and the edit
lease is renewable rather than a total runtime bound. Both horizons refresh on
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
`refundReservation`. Every SQL update repeats legacy mode/run authority while
the compatibility switch is false and the full nonce generation after it is
true; credit-mutating writers require exactly one affected row so a lost CAS
rolls the refund back. A reaped-then-re-claimed run's stale terminal write
therefore affects zero rows rather than clobbering its successor. A failed EDIT
never flips its `complete` app to `error` (that would brick a working app over
a transient model error).

**Reapers re-validate staleness IN-TXN.** `reapStaleGenerating` →
`refundStaleGeneration` (stale build: refund + `generating → error` +
`paused_timeout` classification for an abandoned pause) and
`reapStaleReservation` → `refundStaleReservation` (stranded edit: refund +
settle + release the lapsed lock) require the exact holder identity captured by
their scan, compare it again under the app lock, and repeat it in the SQL CAS.
They also re-derive `reapable*` off that locked row, so even a delayed reaper
cannot claw back a later holder that has independently gone stale. Both key on
the LAPSED LEASE, not `awaiting_input`, so they free hard-killed AND
abandoned-paused runs; both CLEAR the reaped marker's `runId` (the reaper's
signature for the self-heal + non-lenient holder read) when the reaper settles
an unsettled marker. A build marker already settled by its own failure flush
retains its `runId`; it deliberately cannot masquerade as a false reap or
self-heal. Refunds always target the
marker's charged actor (`res_user_id`, falling back to `owner` for markers that
lack it). A missing marker run id is still refundable for an edit whose lock
provides a concrete holder id; a build with neither a concrete reservation id
nor pre-reservation root id fails closed as corrupt and is never queued.

**Resume re-acquires — renew, don't get reaped.** A free-continuation resume
calls `reacquireLease`: one transaction asserting `ownedByResume` (keyed on
the RESUME's own mode), freshly authorizing its actor, and, on success,
re-establishing the mode's horizon +
clearing `awaiting_input`. Before activation, a legacy browser may omit the
nonce; a v0 pause is upgraded with a server-minted nonce in this same locked
write and the authoritative value is returned to the client. After activation,
a missing/mismatch returns `"refresh_required"`. Other lost resumes touch
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

`commitGuardedBatch` is the one blueprint write every surface shares (chat,
MCP, auto-save, the cross-Project move): lock the app row → dedup latch read
→ reject when the row no longer matches the caller's required
`expectedProjectId` → reauth against the fresh row (owner fallback for
null-Project apps) → assemble + hydrate the fresh doc →
`batchTargetsMissing` → re-run verdict → literal `seq + 1` → entity-row diff
write + the permanent stream row + the in-commit NOTIFY. The per-commit edit
lease refresh rides the same transaction when the committing run owns the
lock. Before any blueprint write, it computes newly introduced real media refs,
locks their rows sorted `FOR SHARE`, rechecks Project/readiness plus explicit
slot expectations, and inserts exact `media_asset_refs` edges in that SAME
transaction. Atomic creation and `appendSyntheticBatch` apply the identical
admission rule; post-commit `syncMediaReferences` is legacy/backfill help only.

**Media deletion is one authoritative transaction.**
`mediaDeletion.ts` takes the shared membership gate, freshly proves Project
`edit`, locks the asset `FOR UPDATE`, then re-walks live persisted carriers
without taking app locks and deletes metadata only when the result is empty.
Each app root, its normalized blueprint entities, and thread messages come from
one correlated SQL statement snapshot, so an atomic carrier relocation cannot
fall between separate READ COMMITTED reads.
Until `media_reference_index_state.audited_complete_at` is stamped by an audited
backfill, it scans every live app in the asset Project; afterward the exact index
may narrow candidates. This lock conflicts with the introduced-ref share lock,
so attach/delete has two safe winner orders. Object cleanup is post-commit and
serialized with every publisher by the canonical GCS-key session advisory lock.

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
