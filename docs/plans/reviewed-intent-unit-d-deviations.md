# Unit D — deviations and binding decisions log (working file)

Working log for Unit D implementation. Folded into
`reviewed-intent-atomic-change-sets-plan.md` at the end of the unit, then
deleted. Entries are either **deviation** (plan said X, we did Y, why) or
**decision** (plan under-specified, we chose X, why).

## Decisions

1. **Advisory gate key derivation.** `pg_advisory_xact_lock(bigint)` (the
   64-bit single-key form, a DIFFERENT keyspace from the two-int32 form the
   Project-membership gate uses, so the two gates cannot collide). Key = first
   8 bytes of `SHA-256("nova:actor-generation-admission:v1:" + actorUserId)`
   read big-endian as a SIGNED int64 (`BigInt.asIntN(64, …)`). Versioned by
   the literal `v1` in the preimage; golden vectors pin the derivation.

2. **Gate scope on app-side writers.** Per §11.3's verb list ("creates,
   releases, pauses, resumes, settles, refunds, reaps, or transfers"), the
   gate becomes the FIRST lock in: `claimAndReserveRun`, `reserveForNewBuild`,
   `reacquireLease`, `setAwaitingInput`, `completeAndSettleRun`,
   `clearRunLockAndSettle`, `clearRunLock`, `failApp`, `recoverAppStatus`,
   `refundReservation`, `settleAndRelease`, `refundStaleGeneration`,
   `refundStaleReservation`. The heartbeats (`refreshEditLease`,
   `refreshBuildLiveness`) are unchanged-holder verification writes and stay
   row-first with no gate (plan: "read/write operations that merely verify an
   unchanged holder do not take the actor gate"). `createApp` also stays
   ungated: the chat flow's admission point is `reserveForNewBuild`, which is
   gated, and creation's membership-gate-first exception is load-bearing.

3. **Gate actor identity.** One gate per transaction. Admission-evaluating
   writers (claim/reserve/reacquire/pause) key on the caller's
   `actorUserId`. Holder-releasing/settling/reaping writers key on the
   HOLDER's actor derived from an unlocked pre-read of the authority row
   (build: `res_user_id ?? owner`; edit: `lock_actor_user_id ?? owner`),
   skipping the gate when no row exists. A pre-read that goes stale is
   harmless: the exact-holder compare-and-set already makes the write a
   no-op, and holding the "wrong" actor's gate serializes nothing incorrect.
   Deadlock-freedom needs only the uniform gate→row order, which this keeps.

4. **Design-session liveness lives in `runLiveness.ts`.** Instead of a new
   module (the plan's "do not copy timeout arithmetic into a second module"),
   `designSessionLeaseState` sits beside `runLeaseState` and derives from the
   session's explicit `run_lease_expires_at` lease column; the claim/refresh
   deadline shares `MAX_GENERATION_MINUTES` through a
   `buildLeaseDeadlineMs()` sibling of `editLeaseDeadlineMs()`.

5. **`chat_stream_chunks.design_session_id` gets a real FK**
   (`ON DELETE CASCADE`) even though `app_id` has none — §18.11 asks for FKs
   with explicit delete behavior on the target-polymorphic tables, and a
   pruned operational log cascading with a physically-deleted session is
   harmless. `app_id` keeps its historical FK-less shape (app-target
   behavior unchanged).

6. **`run_summaries` loses its PK.** The plan's partial unique indexes
   (`(app_id, run_id) WHERE app_id IS NOT NULL`,
   `(design_session_id, run_id) WHERE design_session_id IS NOT NULL`) replace
   `run_summaries_pkey` (PK columns must be NOT NULL, and `app_id` is now
   nullable). The first-write 23505 unique-race retry behaves identically
   under the partial unique index.

7. **Backfill runs INSIDE the migration, via imported production code, plus
   a post-deploy convergence script pair.** The repo's scan-then-migrate rule
   covers operator-timed data migrations; here the new deletion guard reads
   `thread_media_refs` the moment the new revision serves, so the backfill
   must be ordered before it (the migrate Job blocks the deploy). The
   `sequence_is_array_position` "frozen copy" precedent does not apply: that
   was an equivalence ORACLE (freezing is what made the proof meaningful);
   this is a derived-PROJECTION rebuild, where the projection's definition is
   the production walk (`walkAuthoredAssetRefs`,
   `collectThreadAttachments`) and a replay should converge on the CURRENT
   definition, exactly as the runtime writers would. A scan/migrate script
   pair re-runs the same convergence after the old revision drains (the old
   writer re-adds thread-contributed `media_asset_refs` edges during the
   deploy window); scripts are deleted after the production run per repo
   policy.

8. **Existing suites are the §19.3 characterization corpus.** threads.test.ts
   (49), claimRun.integration (42), runLifecycleInvariants (26), credits
   suites, streamResume (17), transportContract (4), clientCancel (22),
   durableStreamWriter (12), usage-accumulator (18), runSummary (13) already
   pin every behavior §19.3 lists for this unit. They are kept green through
   the refactor (mechanical signature updates only, no behavioral edits);
   the new §20.9–§20.12 suites extend rather than replace them.

9. **`threads.thread_type` stays `build | edit`** on both target kinds (a
   design-session thread is always `build` — sessions claim only in build
   mode; edit-mode sessions delegate to the app row and their threads are
   app-shaped until Unit E chooses otherwise).

10. **Internal design-session API surface** (consumed by Unit E, exercised by
    tests): `createDesignSession` (edit-mode artifact scope, no holder),
    `createAndClaimDesignSessionRun` (build mode: create + claim + reserve in
    ONE gated transaction — §11.13 rule 2), plus the §11.4 wrappers and
    `discardDesignSession` (§11.12). No route mounts them in Unit D.

## Deviations

(none yet)
