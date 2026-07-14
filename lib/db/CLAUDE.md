# lib/db — the app-state data layer (Postgres) + the two-ledger credit model

Everything Nova persists about apps, runs, credits, threads, media metadata,
and settings lives in Postgres tables on the shared Cloud SQL pool. `pg.ts`
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
`nova_presence`. Payloads are pokes only — the relay
(`app/api/apps/[id]/stream`) SELECTs since its cursor, so a missed
notification degrades to the next poke/catch-up, never to lost data. The
dedicated LISTEN connection lives in `streamListener.ts` (one per instance,
outside the pool — see the connection budget in
`lib/case-store/postgres/connection.ts`).

## Two ledgers, different lifecycles

Cost and quota live in **separate tables** so an admin intervention on one
never disturbs the other:

- `usage_months` (`UsageDoc`) — dollar cost, **accumulate-only**, two counters
  side by side: `cost_estimate` (token math) and `actual_cost` (the gateway's
  own per-call meter, summed from `providerMetadata.gateway.cost`). Resets
  never touch it. Its sole gate consumer is the invisible dollar backstop
  (`ACTUAL_COST_BACKSTOP_USD`), read via `getMonthlyUsage` — trips on the
  larger of the two.
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
