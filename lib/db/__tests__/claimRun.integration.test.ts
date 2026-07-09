/**
 * Per-app run serialization + the reservation lifecycle, against a REAL Postgres
 * (the per-test-database harness). Composes the genuine `claimAndReserveRun` /
 * `reacquireLease` / `refreshEditLease` / `clearRunLock` / `clearRunLockAndSettle` /
 * `completeAndSettleRun` / `reapStaleReservation` / `reapStaleGenerating` (apps.ts)
 * with the real `refundReservation` / `refundStaleReservation` /
 * `refundStaleGeneration` (credits.ts), all sharing one Postgres database — so each
 * function reads exactly what the previous one wrote across the same
 * `SELECT … FOR UPDATE` round-trips production runs. Every liveness / ownership /
 * paused / settled decision inside them derives from the one `runLeaseState`
 * reader (`runLiveness.ts`).
 *
 * What this pins that the mocked-transaction unit suites can't:
 *
 *   - Serialize-with-wait at the DB layer: a second concurrent BUILD or EDIT
 *     claim THROWS `RunConflictError` while the app is held, and SUCCEEDS once
 *     the holder releases. Cross-mode: a build claim waits on a live edit-lock
 *     and an edit claim waits on a live build.
 *   - Claim AND reserve commit as ONE transaction: a claimed app always carries
 *     its claimant's marker, and a rejected claim is a rollback that held nothing.
 *   - A clean edit releases its `run_lock` (`clearRunLock`), and the next waiter's
 *     claim then proceeds.
 *   - A settled kept charge (build OR edit) is NOT reaped.
 *   - A hard-killed edit's hold is reaped off the SINGLE run-liveness horizon —
 *     its `run_lock` present but past its `lock_expire_at`; a live long edit
 *     (refreshed lock) is never reaped, and a build (no lock) is never touched.
 *   - A paused run of EITHER shape BLOCKS a claim (it is not a takeover); an
 *     abandoned paused run is freed by the reapers once its lease lapses, and a
 *     paused run's OWN resume (build OR edit) re-acquires or bails if superseded.
 *
 * Runs unconditionally under `npm test` — the case-store testcontainer boots in
 * globalSetup and each test gets a fresh database via the app-state harness.
 */

import { describe, expect, it } from "vitest";
import { CREDITS_PER_BUILD, CREDITS_PER_EDIT } from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import { MAX_GENERATION_MINUTES, MAX_RUN_MINUTES } from "../constants";
import { setupAppStateTestDb } from "./appStateTestDb";

const OWNER = "user-claimrun-owner";
const MEMBER = "user-claimrun-member";
const APP_ID = "app-claimrun-integration";

const h = setupAppStateTestDb("claimrun_");
const period = getCurrentPeriod();

/** A `lock_expire_at` `mins` minutes from now (negative = already lapsed). */
const lockExpiry = (mins: number) => new Date(Date.now() + mins * 60_000);
/** An `updated_at` past the build staleness window (a hard-killed build). */
const staleClock = () =>
	new Date(Date.now() - (MAX_GENERATION_MINUTES + 1) * 60_000);

/** Seed the fixed-id test app with a controlled run/credit state. */
async function seedApp(
	opts: Parameters<typeof h.seedApp>[0] = {},
): Promise<void> {
	await h.seedApp({ id: APP_ID, owner: OWNER, ...opts });
}
async function seedCredits(userId: string, consumed: number): Promise<void> {
	await h.seedCreditMonth(userId, period, {
		allowance: 2000,
		consumed,
		bonus: 0,
	});
}
const readConsumed = (userId: string) => h.readConsumed(userId, period);
const readStatus = async () => (await h.readAppRow(APP_ID))?.status;
const readAwaiting = async () => (await h.readAppRow(APP_ID))?.awaiting_input;

describe("claimAndReserveRun + reservation lifecycle", () => {
	// A never-seeded credit row reads as a full allowance, so a claim that
	// reserves succeeds without a seed; cases that assert on a refund seed first.

	// ── Serialize-with-wait: conflict while held, success after release ──

	it("an EDIT claim on a complete app writes a run_lock without touching status", async () => {
		const { claimAndReserveRun } = await import("../apps");
		await seedApp({ status: "complete" });

		const claim = await claimAndReserveRun(
			APP_ID,
			"edit",
			"run-1",
			OWNER,
			CREDITS_PER_EDIT,
		);
		expect(claim.mode).toBe("edit");
		expect(claim.reservation).toEqual({
			period,
			reserved: CREDITS_PER_EDIT,
		});

		// Status is untouched — an edit never flips to `generating`.
		expect(await readStatus()).toBe("complete");
		const lock = await h.readRunLock(APP_ID);
		expect(lock?.runId).toBe("run-1");
		expect(lock?.actorUserId).toBe(OWNER);
		expect(lock?.expireAt).toBeInstanceOf(Date);
		// Claim and reserve are atomic — the marker booked in the same commit.
		expect(await h.readReservation(APP_ID)).toMatchObject({
			settled: false,
			userId: OWNER,
			runId: "run-1",
		});
	});

	it("a second EDIT claim conflicts while the lock is live, then succeeds after clearRunLock", async () => {
		const { claimAndReserveRun, clearRunLock, RunConflictError } = await import(
			"../apps"
		);
		await seedApp({ status: "complete" });

		await claimAndReserveRun(APP_ID, "edit", "run-1", OWNER, CREDITS_PER_EDIT);
		// A concurrent editor's claim finds the app held — it throws, and the
		// chat route's poll loop turns that into a wait rather than a 429.
		await expect(
			claimAndReserveRun(APP_ID, "edit", "run-2", MEMBER, CREDITS_PER_EDIT),
		).rejects.toBeInstanceOf(RunConflictError);

		// The holder finishes and releases; the waiter's next poll succeeds.
		await clearRunLock(APP_ID);
		const claim = await claimAndReserveRun(
			APP_ID,
			"edit",
			"run-2",
			MEMBER,
			CREDITS_PER_EDIT,
		);
		expect(claim.mode).toBe("edit");
		expect(await h.readRunLock(APP_ID)).toMatchObject({ runId: "run-2" });
	});

	it("cross-mode: a BUILD claim waits on a live edit-lock, an EDIT claim waits on a live build", async () => {
		const { claimAndReserveRun, clearRunLock, RunConflictError } = await import(
			"../apps"
		);

		// A live edit-lock blocks a build claim.
		await seedApp({
			status: "complete",
			run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
		});
		await expect(
			claimAndReserveRun(APP_ID, "build", "b1", MEMBER, CREDITS_PER_BUILD),
		).rejects.toBeInstanceOf(RunConflictError);

		// Release the edit-lock — the build claim then takes the window (flipping
		// to `generating` and clearing the dead lock).
		await clearRunLock(APP_ID);
		const buildClaim = await claimAndReserveRun(
			APP_ID,
			"build",
			"b1",
			MEMBER,
			CREDITS_PER_BUILD,
		);
		expect(buildClaim.mode).toBe("build");
		expect(await readStatus()).toBe("generating");
		expect(await h.readRunLock(APP_ID)).toBeUndefined();

		// Now a live build blocks an edit claim (the reverse of the matrix).
		await expect(
			claimAndReserveRun(APP_ID, "edit", "e2", OWNER, CREDITS_PER_EDIT),
		).rejects.toBeInstanceOf(RunConflictError);
		// The rejected edit claim wrote nothing.
		expect(await h.readRunLock(APP_ID)).toBeUndefined();
	});

	it("a BUILD claim takes over a stale (past-expireAt) edit-lock", async () => {
		const { claimAndReserveRun } = await import("../apps");
		await seedApp({
			status: "complete",
			// A hard-killed edit left its lock behind; its lease has expired.
			run_lock: { runId: "dead", actorUserId: OWNER, expireAt: lockExpiry(-1) },
		});

		const claim = await claimAndReserveRun(
			APP_ID,
			"build",
			"b1",
			MEMBER,
			CREDITS_PER_BUILD,
		);
		expect(claim.mode).toBe("build");
		expect(await readStatus()).toBe("generating");
		// The dead edit-lock is cleared by the build takeover.
		expect(await h.readRunLock(APP_ID)).toBeUndefined();
	});

	it("an EDIT claim overwrites a stale (past-expireAt) edit-lock", async () => {
		const { claimAndReserveRun } = await import("../apps");
		await seedApp({
			status: "complete",
			run_lock: { runId: "dead", actorUserId: OWNER, expireAt: lockExpiry(-1) },
		});

		const claim = await claimAndReserveRun(
			APP_ID,
			"edit",
			"e2",
			MEMBER,
			CREDITS_PER_EDIT,
		);
		expect(claim.mode).toBe("edit");
		expect(await h.readRunLock(APP_ID)).toMatchObject({
			runId: "e2",
			actorUserId: MEMBER,
		});
	});

	// ── Settle vs reap: a completed edit's kept charge survives ──────────

	it("a settled kept-charge edit is NOT reaped even without a live lock", async () => {
		const { reapStaleReservation } = await import("../apps");
		// A completed edit that kept its charge: the clean finalize
		// (`clearRunLockAndSettle`) already flipped `settled: true` in the same txn
		// that released the lock. Seed that settled end-state (marker settled, no
		// live lock) — the reaper must hand nothing back.
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: true,
				userId: OWNER,
			},
		});

		await reapStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
	});

	it("a completed BUILD's kept charge is NOT reaped — a build marker has no run_lock", async () => {
		const { reapStaleReservation } = await import("../apps");
		// A long build finished; its marker is unsettled in the (now-atomically-
		// closed) window before settle. A BUILD has NO `run_lock`, and the reaper
		// reaps only a hard-killed EDIT (lock PRESENT + lapsed) — "no lock" is a
		// build's kept charge, never reaped.
		await seedCredits(OWNER, CREDITS_PER_BUILD);
		await seedApp({
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
			},
			// No run_lock — a build holds via status, never a lock.
		});

		await reapStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: false });
	});

	it("refundStaleReservation does NOT claw back a LIVE edit (run_lock present, not lapsed)", async () => {
		const { refundStaleReservation } = await import("../credits");
		// A fresh edit that won the app has a LIVE `run_lock` (future `expireAt`,
		// refreshed per commit). The reaper's in-txn re-check sees the live lock and
		// skips, so the live run's unsettled charge is never clawed back.
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await refundStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: false });
	});

	// ── Atomic settle+release ────────────────────────────────────────────

	it("completeAndSettleRun flips status→complete AND settles the kept charge in one write", async () => {
		const { completeAndSettleRun } = await import("../apps");
		// A build's marker is unsettled at drain end. It carries its `runId`
		// (the claim wrote it) — non-lenient `mine` needs it to own.
		await seedCredits(OWNER, CREDITS_PER_BUILD);
		await seedApp({
			status: "generating",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
				runId: "b1",
			},
		});

		await completeAndSettleRun(APP_ID, "b1");
		expect(await readStatus()).toBe("complete");
		// Settled-as-kept in the SAME write — no window where the app is
		// `complete` (claimable) with an unsettled marker.
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
		// Kept, not refunded.
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
	});

	it("a completing build's charge is NOT clawed back by a following edit claim+reserve (atomic settle closes the window)", async () => {
		const { claimAndReserveRun, completeAndSettleRun } = await import(
			"../apps"
		);
		// A build finishes, THEN an edit POST lands. With the atomic settle, by the
		// time the app is `complete` (claimable) the build's marker is already
		// settled, so the edit's claim+reserve (unconditional leftover refund) sees
		// a SETTLED marker and does NOT refund the build's kept 100 credits.
		await seedCredits(OWNER, CREDITS_PER_BUILD);
		await seedApp({
			status: "generating",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
				runId: "b1",
			},
		});

		await completeAndSettleRun(APP_ID, "b1");
		// A co-member's edit now claims + reserves in one transaction.
		await claimAndReserveRun(
			APP_ID,
			"edit",
			"edit-1",
			MEMBER,
			CREDITS_PER_EDIT,
		);

		// The build's 100 kept credits are intact (NOT clawed back); the edit's 5
		// booked on the member's own ledger.
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
		expect(await readConsumed(MEMBER)).toBe(CREDITS_PER_EDIT);
	});

	it("clearRunLockAndSettle releases the lock AND settles the kept charge in one write", async () => {
		const { clearRunLockAndSettle } = await import("../apps");
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await clearRunLockAndSettle(APP_ID, "e1");
		expect(await h.readRunLock(APP_ID)).toBeUndefined();
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
	});

	// ── Reaper's internal guards ─────────────────────────────────────────

	it("refundStaleReservation REAPS an ABANDONED paused edit (paused + lapsed lease) — frees the app for a waiter", async () => {
		const { refundStaleReservation } = await import("../credits");
		// A paused run blocks a claim, so an abandoned one (the user never answered,
		// its lease lapsed) MUST be reaped — else it holds forever.
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			awaiting_input: true,
			run_lock: { runId: "p", actorUserId: OWNER, expireAt: lockExpiry(-1) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await refundStaleReservation(APP_ID);
		// Hold refunded, marker settled, lock released, pause cleared — a clean,
		// claimable `complete` app.
		expect(await readConsumed(OWNER)).toBe(0);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
		expect(await h.readRunLock(APP_ID)).toBeUndefined();
		expect(await readAwaiting()).toBeFalsy();
	});

	it("a claim conflicting with an ABANDONED paused edit fires the reaper itself — the waiter's poll then claims", async () => {
		const { claimAndReserveRun, RunConflictError } = await import("../apps");
		// A collaborator polling `claimAndReserveRun` (the serialize-with-wait loop)
		// never touches the app-list scan, so without the claim-path nudge an
		// abandoned paused run blocks every waiter until someone loads the dashboard.
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			awaiting_input: true,
			run_lock: { runId: "p", actorUserId: OWNER, expireAt: lockExpiry(-1) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
				runId: "p",
			},
		});

		// The first poll conflicts (paused blocks) but carries the reapable flag and
		// AWAITS `reapStaleReservation` on its way out.
		const conflict = await claimAndReserveRun(
			APP_ID,
			"edit",
			"waiter",
			MEMBER,
			CREDITS_PER_EDIT,
		).then(
			() => undefined,
			(err) => err,
		);
		expect(conflict).toBeInstanceOf(RunConflictError);
		expect(conflict.reapableStrandedEdit).toBe(true);

		// The reap freed the app before the conflict surfaced, so the waiter's very
		// next poll claims it.
		const claim = await claimAndReserveRun(
			APP_ID,
			"edit",
			"waiter",
			MEMBER,
			CREDITS_PER_EDIT,
		);
		expect(claim.mode).toBe("edit");
		// The abandoned run's hold was refunded by the reap (not buried).
		expect(await readConsumed(OWNER)).toBe(0);
	});

	it("a claim conflicting with an ABANDONED paused build fires the reaper itself — the waiter's poll then claims", async () => {
		const { claimAndReserveRun, RunConflictError } = await import("../apps");
		await seedCredits(OWNER, CREDITS_PER_BUILD);
		await seedApp({
			status: "generating",
			awaiting_input: true,
			// The paused build's clock froze past the staleness window.
			updated_at: staleClock(),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
				runId: "p",
			},
		});

		const conflict = await claimAndReserveRun(
			APP_ID,
			"build",
			"waiter",
			MEMBER,
			CREDITS_PER_BUILD,
		).then(
			() => undefined,
			(err) => err,
		);
		expect(conflict).toBeInstanceOf(RunConflictError);
		expect(conflict.reapableStaleBuild).toBe(true);

		// The reap flipped the abandoned build to `error` and refunded its hold
		// before the conflict surfaced; the next poll claims the freed app.
		const claim = await claimAndReserveRun(
			APP_ID,
			"build",
			"waiter",
			MEMBER,
			CREDITS_PER_BUILD,
		);
		expect(claim.mode).toBe("build");
		expect(await readConsumed(OWNER)).toBe(0);
	});

	it("an abandoned-pause build reap labels the row `paused_timeout`, a hard-kill reap `internal`", async () => {
		const { refundStaleGeneration } = await import("../credits");
		// Paused at reap time: the run expired waiting for an answer — not an
		// internal fault, so the row must not read as a crash.
		await h.seedApp({
			id: "app-paused-reap",
			owner: OWNER,
			status: "generating",
			awaiting_input: true,
			updated_at: staleClock(),
		});
		await refundStaleGeneration("app-paused-reap");
		expect((await h.readAppRow("app-paused-reap"))?.error_type).toBe(
			"paused_timeout",
		);

		// Hard-killed (never paused): the process died mid-run — `internal` stands.
		await h.seedApp({
			id: "app-hardkill-reap",
			owner: OWNER,
			status: "generating",
			updated_at: staleClock(),
		});
		await refundStaleGeneration("app-hardkill-reap");
		expect((await h.readAppRow("app-hardkill-reap"))?.error_type).toBe(
			"internal",
		);
	});

	it("refundStaleReservation never reaps a RECENTLY-paused edit (paused + FUTURE lease) — its own resume can still renew", async () => {
		const { refundStaleReservation } = await import("../credits");
		// A paused edit whose lease is still in the future is alive — its own resume
		// re-acquires it. The reaper's own body (not just the caller) must skip it.
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			awaiting_input: true,
			run_lock: { runId: "p", actorUserId: OWNER, expireAt: lockExpiry(10) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await refundStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: false });
	});

	it("refundStaleReservation never reaps a generating (build) row (self-contained guard)", async () => {
		const { refundStaleReservation } = await import("../credits");
		await seedCredits(OWNER, CREDITS_PER_BUILD);
		await seedApp({
			status: "generating",
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
			},
		});

		await refundStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: false });
	});

	// ── Reap a stranded edit hold (hard kill) ────────────────────────────

	it("reapStaleReservation refunds a hard-killed edit's hold — run_lock present but lapsed — without flipping status", async () => {
		const { reapStaleReservation } = await import("../apps");
		// A member ran an edit on the owner's shared app, was charged 5, then
		// hard-killed: the app stays `complete`, the marker is unsettled, and its
		// `run_lock` is PRESENT but PAST its expireAt. Per-actor billing: the
		// MEMBER's ledger is un-booked, not the owner's.
		await seedCredits(MEMBER, CREDITS_PER_EDIT);
		await seedCredits(OWNER, 0);
		await seedApp({
			status: "complete",
			run_lock: {
				runId: "dead-edit",
				actorUserId: MEMBER,
				expireAt: lockExpiry(-1),
			},
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: MEMBER,
			},
		});

		await reapStaleReservation(APP_ID);

		expect(await readConsumed(MEMBER)).toBe(0);
		expect(await readConsumed(OWNER)).toBe(0);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
		expect(await readStatus()).toBe("complete");
	});

	it("reapStaleReservation does NOT refund a LIVE edit (run_lock present, not lapsed)", async () => {
		const { reapStaleReservation } = await import("../apps");
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await reapStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: false });
	});

	it("reapStaleReservation reaps the ORPHAN shape — the marker's run differs from the lapsed lock's", async () => {
		const { reapStaleReservation } = await import("../apps");
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			// Run Y hard-killed inside its own [claim, reserve) window left run X's
			// unsettled marker under Y's (now lapsed) lock. Both runs are dead; the
			// hold must still reap or it strands for the whole month.
			run_lock: {
				runId: "taker-run-Y",
				actorUserId: OWNER,
				expireAt: lockExpiry(-1),
			},
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
				runId: "prior-run-X",
			},
		});

		await reapStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(0);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
		expect(await h.readRunLock(APP_ID)).toBeUndefined();
	});

	it("reapStaleReservation reaps a legacy marker with no runId (lenient on the absent field)", async () => {
		const { reapStaleReservation } = await import("../apps");
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			run_lock: {
				runId: "dead-edit",
				actorUserId: OWNER,
				expireAt: lockExpiry(-1),
			},
			// A marker written before the `runId` field shipped — still reaped off
			// the lapsed lock (the identity guard is lenient on an absent runId).
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await reapStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(0);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
	});

	// ── The claim's leftover-refund before booking a fresh marker ─────────

	it("a claim refunds a leftover unsettled hold before booking a fresh one (same user, same month)", async () => {
		const { claimAndReserveRun } = await import("../apps");
		// A prior hard-killed edit left an unsettled 5-credit hold on the owner's own
		// current-month ledger; the owner re-edits before the reaper fired. The claim
		// (via `debitAndBookReservation`) refunds that leftover UNCONDITIONALLY
		// before booking its own — net consumed stays at 5, not 10.
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await claimAndReserveRun(
			APP_ID,
			"edit",
			"run-fresh",
			OWNER,
			CREDITS_PER_EDIT,
		);

		// Net: the leftover 5 refunded, then the fresh 5 booked → still 5, not 10.
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
		// The marker is the FRESH run's — unsettled.
		expect(await h.readReservation(APP_ID)).toMatchObject({
			settled: false,
			reserved: CREDITS_PER_EDIT,
			runId: "run-fresh",
		});
	});

	it("a claim's leftover-refund targets the CHARGED ACTOR of the stranded marker, not the owner", async () => {
		const { claimAndReserveRun } = await import("../apps");
		// A Project co-member (NOT the owner) ran a build on the owner's app, was
		// charged 100, then hard-killed — leaving an unsettled marker whose
		// `userId` is the MEMBER. The owner retries: the claim's leftover-refund
		// must un-book the MEMBER's hold (`marker.userId`), NOT `app.owner`, and
		// book the owner's fresh charge on the owner's own ledger.
		await seedCredits(MEMBER, CREDITS_PER_BUILD);
		await seedCredits(OWNER, 0);
		await seedApp({
			status: "complete",
			owner: OWNER,
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: MEMBER,
			},
		});

		await claimAndReserveRun(
			APP_ID,
			"build",
			"run-retry",
			OWNER,
			CREDITS_PER_BUILD,
		);

		// The dead member's hold handed back…
		expect(await readConsumed(MEMBER)).toBe(0);
		// …and the fresh 100 booked on the owner's own ledger.
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
		expect(await h.readReservation(APP_ID)).toMatchObject({
			userId: OWNER,
			runId: "run-retry",
		});
	});

	// ── clearRunLock is a clean field delete ─────────────────────────────

	it("clearRunLock removes the lock and leaves status + reservation untouched", async () => {
		const { clearRunLock } = await import("../apps");
		await seedApp({
			status: "complete",
			run_lock: { runId: "r", actorUserId: OWNER, expireAt: lockExpiry(10) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: true,
				userId: OWNER,
			},
		});

		await clearRunLock(APP_ID);
		expect(await h.readRunLock(APP_ID)).toBeUndefined();
		expect(await readStatus()).toBe("complete");
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
	});

	// ── A paused run's live hold stays unsettled + refundable ─────────────

	it("a paused edit's unsettled hold survives (never settled) and a failed resume refunds it in full", async () => {
		// The route's paused finalize skips settle + release, so a paused edit's
		// marker stays a LIVE hold and its lock persists for the resume. When a later
		// resume FAILS, `refundReservation` hands it back off the untouched marker.
		const { refundReservation } = await import("../credits");
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		// The paused hold is unsettled and the lock is still held.
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: false });
		expect(await h.readRunLock(APP_ID)).toMatchObject({ runId: "e1" });

		// A later resume FAILS — the failure funnel refunds off the marker.
		await refundReservation(APP_ID, "e1");
		expect(await readConsumed(OWNER)).toBe(0);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: true });
	});

	// ── loadAppHolderName projected read ──────────────────────────────────

	it("loadAppHolderName resolves the holder from a projected read without pulling the blueprint", async () => {
		const { loadAppHolderName } = await import("../apps");
		// The projected read must pick up the holder id without a full `loadApp`. No
		// auth DB is injected here, so the `auth_user` name lookup fails-safe to
		// "someone" — this asserts the projected APP read succeeds and yields a string.
		await seedApp({
			status: "complete",
			run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
		});

		const name = await loadAppHolderName(APP_ID);
		expect(typeof name).toBe("string");
		expect(name.length).toBeGreaterThan(0);
	});

	// ── A live long edit (lease refreshed) is NOT reaped ──────────────────

	it("a live edit past the initial MAX_RUN_MINUTES lease is NOT reaped once its run_lock is refreshed", async () => {
		const { reapStaleReservation } = await import("../apps");
		// An edit running longer than the initial lease refreshes its
		// `lock_expire_at` per commit. The reaper keys ONLY on the lock, so a
		// refreshed (future) lock reads as live, not reaped.
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		await seedApp({
			status: "complete",
			run_lock: {
				runId: "long-edit",
				actorUserId: OWNER,
				expireAt: lockExpiry(MAX_RUN_MINUTES),
			},
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
			},
		});

		await reapStaleReservation(APP_ID);
		expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
		expect(await h.readReservation(APP_ID)).toMatchObject({ settled: false });
	});

	// ── reacquireLease: paused-run resume re-acquire (supersede + renew) ──

	it("reacquireLease (build): a paused build's resume that STILL owns it renews + un-pauses", async () => {
		const { reacquireLease } = await import("../apps");
		// A paused build (generating + awaiting_input, no lock) with its run's
		// marker — a chargeable build always reserved before it could pause.
		await seedApp({
			status: "generating",
			awaiting_input: true,
			updated_at: new Date(Date.now() - 60_000),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
				runId: "build-run",
			},
		});

		expect(await reacquireLease(APP_ID, "build-run", "build")).toBe("owned");
		expect(await readAwaiting()).toBeFalsy();
		expect(await readStatus()).toBe("generating");
		// updated_at re-armed to ~now (the frozen-during-pause clock restarts).
		const updatedAt = (await h.readAppRow(APP_ID))?.updated_at as Date;
		expect(Date.now() - updatedAt.getTime()).toBeLessThan(30_000);
	});

	it("reacquireLease (edit): a paused edit whose lease LAPSED while answering is renewed, not reaped", async () => {
		const { reacquireLease } = await import("../apps");
		// A paused edit whose 15-min lease already lapsed during the user's answer:
		// still `mine` (lock present, runId matches), but a check that ignored the
		// lease would proceed on a dead lock and be reaped.
		await seedApp({
			status: "complete",
			awaiting_input: true,
			run_lock: {
				runId: "edit-paused",
				actorUserId: OWNER,
				expireAt: lockExpiry(-1),
			},
		});

		expect(await reacquireLease(APP_ID, "edit-paused", "edit")).toBe("owned");
		expect(await readAwaiting()).toBeFalsy();
		// The lease was RE-STAMPED to a fresh future deadline — not left lapsed.
		const lock = await h.readRunLock(APP_ID);
		expect(lock?.expireAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("reacquireLease distinguishes a timeout-RELEASED run from a takeover-SUPERSEDED one", async () => {
		const { claimAndReserveRun, reacquireLease } = await import("../apps");
		const { refundStaleGeneration } = await import("../credits");
		// A paused build reaped with NO re-claim: the app sits free (`error`, nothing
		// holds it). The late answer must read "released" — a takeover message would lie.
		await seedCredits(OWNER, CREDITS_PER_BUILD);
		await seedApp({
			status: "generating",
			awaiting_input: true,
			updated_at: staleClock(),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
				runId: "late-answer",
			},
		});
		await refundStaleGeneration(APP_ID);
		expect(await reacquireLease(APP_ID, "late-answer", "build")).toBe(
			"released",
		);

		// A co-member re-claims the freed app before the answer arrives: now a run
		// really does occupy it, so the late answer reads "superseded".
		await seedCredits(MEMBER, CREDITS_PER_BUILD);
		await claimAndReserveRun(
			APP_ID,
			"build",
			"taker",
			MEMBER,
			CREDITS_PER_BUILD,
		);
		expect(await reacquireLease(APP_ID, "late-answer", "build")).toBe(
			"superseded",
		);
	});

	// ── Per-step edit-lease heartbeat (refreshEditLease) ──────────────────

	it("refreshEditLease extends the run_lock deadline when this run still holds it", async () => {
		const { refreshEditLease } = await import("../apps");
		// A live edit whose lease is close to lapsing (1 min left).
		await seedApp({
			status: "complete",
			run_lock: {
				runId: "edit-live",
				actorUserId: OWNER,
				expireAt: lockExpiry(1),
			},
		});

		await refreshEditLease(APP_ID, "edit-live");

		const lock = await h.readRunLock(APP_ID);
		const remainingMs = (lock?.expireAt.getTime() ?? 0) - Date.now();
		expect(remainingMs).toBeGreaterThan((MAX_RUN_MINUTES - 1) * 60_000);
	});

	it("refreshEditLease does NOT extend a lock a co-member takeover now holds (ownership-gated)", async () => {
		const { refreshEditLease } = await import("../apps");
		// The lock is now a DIFFERENT run's (a takeover overwrote runId).
		const takenExpiry = lockExpiry(2);
		await seedApp({
			status: "complete",
			run_lock: {
				runId: "co-member-run",
				actorUserId: MEMBER,
				expireAt: takenExpiry,
			},
		});

		// The superseded run heartbeats with its OWN (stale) runId → no-op.
		await refreshEditLease(APP_ID, "my-superseded-run");

		const lock = await h.readRunLock(APP_ID);
		expect(lock?.runId).toBe("co-member-run");
		// The taker's deadline is untouched (not extended by the old run).
		expect(lock?.expireAt.getTime()).toBe(takenExpiry.getTime());
	});

	it("refreshEditLease is a clean no-op for a BUILD (no run_lock to match)", async () => {
		const { refreshEditLease } = await import("../apps");
		await seedApp({ status: "generating" });
		await refreshEditLease(APP_ID, "some-build-run");
		expect(await h.readRunLock(APP_ID)).toBeUndefined();
	});

	// ── An edit always leaves the app 'complete' ──────────────────────────

	it("an EDIT claim on a stale generating row normalizes status to complete", async () => {
		const { claimAndReserveRun } = await import("../apps");
		// A hard-killed build B left the app `generating` past the staleness window;
		// co-editor A's tab still shows Ready and sends an edit. The edit claim must
		// normalize status→complete so A's clean finalize doesn't leave a
		// `generating` row for `reapStaleGenerating` to flip to error.
		await seedApp({
			status: "generating",
			updated_at: staleClock(),
		});

		const claim = await claimAndReserveRun(
			APP_ID,
			"edit",
			"e1",
			OWNER,
			CREDITS_PER_EDIT,
		);
		expect(claim.mode).toBe("edit");
		expect(await readStatus()).toBe("complete");
		expect(await h.readRunLock(APP_ID)).toMatchObject({ runId: "e1" });
	});

	// ── The cross-app one-build-per-user concurrency guard ────────────────

	it("a BUILD claim throws GenerationInProgressError when the actor has another live build", async () => {
		const { claimAndReserveRun, GenerationInProgressError } = await import(
			"../apps"
		);
		// The actor already has a LIVE build on a different app; a second build claim
		// is rejected in-transaction (the cross-app one-build-per-user cap) — a
		// rollback that held nothing.
		await h.seedApp({
			id: "app-other-build",
			owner: MEMBER,
			status: "generating",
			updated_at: new Date(),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: MEMBER,
				runId: "other",
			},
		});
		await seedApp({ status: "complete" });

		await expect(
			claimAndReserveRun(APP_ID, "build", "b1", MEMBER, CREDITS_PER_BUILD),
		).rejects.toBeInstanceOf(GenerationInProgressError);
		// The claim rolled back — no marker, no status flip on the target app.
		expect(await readStatus()).toBe("complete");
		expect(await h.readReservation(APP_ID)).toBeUndefined();
	});
});
