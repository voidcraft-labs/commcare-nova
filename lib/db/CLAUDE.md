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

**`accepted_mutations` is permanent history.** Every committed batch appends
one row — no TTL, no prune. It is the realtime catch-up stream AND the app's
durable edit history: folding every batch from an app's first seq reproduces
its entity rows (an app whose history was seeded from a snapshot starts at
that snapshot's seq, not seq 1). `UNIQUE (app_id, batch_id)` is the idempotency latch (the guarded
commit reads it under the app row lock; a concurrent same-batch retry that
races past the read is caught by the constraint and converges on the deduped
result). Future blueprint-shape migrations must migrate the STORED MUTATIONS
alongside the entity rows or historical folds stop reproducing state — the
scan script's fold check is the tripwire.

**Realtime pokes ride LISTEN/NOTIFY.** `writeCommittedBatch` calls
`pg_notify('nova_app_stream', {appId, seq})` INSIDE the commit transaction
(delivered on commit, after the rows are visible); presence writes poke
`nova_presence`; chat chunk-log appends poke `nova_chat_stream`; lookup writers
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

**Lookup-reference storage is installed but dormant.**
`lookup_table_references` and `lookup_column_references` persist exact
Project/resource/app identity edges; a column edge is impossible without its
implied table edge. Resource deletion/identity changes are `RESTRICT`, while
physical app deletion cascades edges. `lookupReferenceEdges.ts` is the internal
materializer seam: after the app row is locked, it takes exact Project-scoped
table locks `FOR KEY SHARE` in lexical UUID order, reads stored targets app-wide
without a Project filter, and replaces complete sets child-delete/parent-delete
then parent-insert/child-insert. Empty replacement can clear stale source-Project
edges; a null-Project app cannot gain a nonempty set, and missing/foreign targets
share one opaque error. No production extractor or authoritative app-writer
integration exists yet, and all destructive-schema, carrier-commit, and true
Project-move flags remain false. `lookup_stream_capability_leases` carries an
app-scoped, database-minted connection UUID plus a required receiver version and
expiry; it is rollout state, not lookup data or blueprint state.

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
as a pooled session setting. `lookupReferenceWriter.ts` is the one runtime
declaration seam. This unit does not wire authoritative call sites; S02b
integration must make each one call `declareLookupReferenceWriter(tx)`, and S05
changes the single `CURRENT_LOOKUP_REFERENCE_WRITER_VERSION` constant from 0 to
1.

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
Both writers are row-locked and
MERGE by message id (`mergeTranscript` — union, richer version wins), never
rewrite: a stale tab or a late finalize can add turns, not erase them, and
an askQuestions continuation lands as ONE merged message. The finalize
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

`claimAndReserveRun(appId, mode, runId, actorUserId, cost)` (and its
new-build sibling `reserveForNewBuild`) runs, inside a single app-row-locked
transaction: the busy check (`lease.live`, or a paused run of ANOTHER actor →
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
(`MAX_RUN_MINUTES`). Both horizons refresh on SA activity AND a wall-clock
timer AND per commit (`refreshEditLease` / `refreshBuildLiveness` + the
guarded commit's per-commit stamp), so a LIVE run never lapses; the heartbeat
stops at finalize, so an abandoned paused run lapses for the reapers.

**Serialize-with-wait, not 429.** A conflicting chargeable POST opens its SSE
stream and polls `claimAndReserveRun` (each poll is the whole atomic
claim+reserve), surfacing a "waiting on <holder>" event; a win arrives fully
gated, a timeout ends friendly, and a gate rejection from a won poll held
nothing.

**Terminal writers gate on ownership IN THEIR TRANSACTION** —
`completeAndSettleRun` (build: `generating → complete` + settle, one commit;
plus the false-reap SELF-HEAL: a reaped-but-unclaimed build that finished
cleanly flips back to `complete` off the reaper's signature — settled marker,
`runId` cleared, `run_id === runId`), `clearRunLockAndSettle` (edit: release +
settle, one commit), `settleAndRelease` (the failed-run writer: refund-if-
unsettled + settle + optional lock release in one commit; its `settled`
return is the separate question "is this run's credit resolved — safe to
`failApp`?"), and the flush-driven `refundReservation`. The gate makes a
reaped-then-re-claimed run's stale terminal write a no-op rather than a
clobber. A failed EDIT never flips its `complete` app to `error` (that would
brick a working app over a transient model error).

**Reapers re-validate staleness IN-TXN.** `reapStaleGenerating` →
`refundStaleGeneration` (stale build: refund + `generating → error` +
`paused_timeout` classification for an abandoned pause) and
`reapStaleReservation` → `refundStaleReservation` (stranded edit: refund +
settle + release the lapsed lock) both re-derive `reapable*` off the locked
row, so a fresh run that re-claimed between the scan and the reap is never
clawed back. Both key on the LAPSED LEASE, not `awaiting_input`, so they free
hard-killed AND abandoned-paused runs; both CLEAR the reaped marker's `runId`
(the reaper's signature the self-heal + non-lenient `mine` read). Refunds
always target the marker's charged actor (`res_user_id`, falling back to
`owner` for markers that lack it).

**Resume re-acquires — renew, don't get reaped.** A free-continuation resume
calls `reacquireLease`: one transaction asserting `ownedByResume` (keyed on
the RESUME's own mode) and, on success, re-establishing the mode's horizon +
clearing `awaiting_input`. A lost resume touched nothing; the return
distinguishes `"superseded"` (another run occupies the app) from `"released"`
(the reap simply freed it) so the route's message is true.

## Guarded commit

`commitGuardedBatch` is the one blueprint write every surface shares (chat,
MCP, auto-save, the cross-Project move): lock the app row → dedup latch read
→ reauth against the fresh row (owner fallback for null-Project apps; a
concurrent move rejects retryably) → media expectations re-checked against
rows read `FOR SHARE` → assemble + hydrate the fresh doc →
`batchTargetsMissing` → re-run verdict → literal `seq + 1` → entity-row diff
write + the permanent stream row + the in-commit NOTIFY. The per-commit edit
lease refresh rides the same transaction when the committing run owns the
lock.

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
