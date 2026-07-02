/**
 * P9 — per-app run serialization + the edit reservation lifecycle, against a
 * REAL Firestore emulator. Composes the genuine `claimRun` / `reacquireLease` /
 * `refreshEditLease` / `clearRunLockAndSettle` / `completeAndSettleRun` /
 * `reapStaleReservation` (apps.ts) with the real `reserveCredits` /
 * `refundReservation` / `settleAndRelease` (credits.ts), sharing one emulator
 * document store — so each function reads exactly what the previous one wrote,
 * across the same `runTransaction` round-trips production runs. Every liveness /
 * ownership / paused / settled decision inside them derives from the one
 * `runLeaseState` reader (`runLiveness.ts`).
 *
 * What this pins that the mocked-transaction unit suites can't:
 *
 *   - Serialize-with-wait at the DB layer: a second concurrent BUILD or EDIT
 *     claim THROWS `RunConflictError` while the app is held, and SUCCEEDS once
 *     the holder releases — the poll-loop the chat route wraps this in is what
 *     turns that throw into a wait instead of a 429. Cross-mode: a build claim
 *     waits on a live edit-lock and an edit claim waits on a live build.
 *   - A clean edit releases its `run_lock` (`clearRunLock`), and the next
 *     waiter's claim then proceeds.
 *   - A settled kept charge (build OR edit, incl. one carried through
 *     `askQuestions`) is NOT reaped by `reapStaleReservation`.
 *   - A hard-killed edit's hold is reaped off the SINGLE run-liveness horizon —
 *     its `run_lock` present but past its (per-commit-refreshed) `expireAt`; a
 *     live long edit (refreshed lock) is never reaped, and a build (no lock) is
 *     never touched. A bailed claim reverts the EXACT prior shape (incl.
 *     `updated_at`, so no phantom in-progress).
 *   - A paused run of EITHER shape BLOCKS a claim (it is not a takeover); an
 *     abandoned paused run is freed by the reapers once its lease lapses, and a
 *     paused run's OWN resume (build OR edit) re-acquires or bails if superseded.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset — run via
 * `npm run test:integration`, which boots the emulator and exports the host.
 */

import { Timestamp } from "@google-cloud/firestore";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	CREDITS_PER_BUILD,
	CREDITS_PER_EDIT,
	MONTHLY_CREDIT_ALLOWANCE,
} from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import { MAX_RUN_MINUTES } from "../constants";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const TEST_PROJECT_ID = "demo-test";
const OWNER = "user-claimrun-owner";
const MEMBER = "user-claimrun-member";
const APP_ID = "app-claimrun-integration";

type AppShape = Record<string, unknown>;

/** A `run_lock` deadline `mins` minutes from now (negative = already expired). */
const lockExpiry = (mins: number) =>
	Timestamp.fromMillis(Date.now() + mins * 60_000);

describe.skipIf(!emulatorAvailable)(
	"claimRun + edit reservation lifecycle",
	() => {
		let db: Firestore;
		const period = getCurrentPeriod();

		beforeAll(() => {
			if (getApps().length === 0) {
				initializeApp({ projectId: TEST_PROJECT_ID });
			}
			// Our own client for seed/read-back; the production `getDb()` inside the
			// functions under test connects to the SAME emulator via the host env var.
			db = new Firestore({ projectId: TEST_PROJECT_ID, preferRest: true });
		});

		afterAll(async () => {
			// Terminate our own client's gRPC/REST pool — an unterminated `Firestore`
			// leaks the connection under the async-leak detector.
			await db.terminate();
			for (const app of getApps()) {
				await deleteApp(app);
			}
		});

		/**
		 * Seed the test app at a known state. `claimRun` reads through the typed
		 * converter (`docs.app`), which rejects a partial doc, so this writes a
		 * FULL, converter-parseable `AppDoc` (via `createApp`) at a fixed id, then
		 * raw-merges the P9 fields each case controls (`status`, `run_lock`,
		 * `reservation`, `updated_at`). The blueprint content is irrelevant to the
		 * run-lock / reservation lifecycle under test.
		 */
		async function seedApp(app: AppShape): Promise<void> {
			const { createApp } = await import("../apps");
			// `createApp` mints a fresh id; delete our fixed-id row and re-point it by
			// copying the freshly-created full doc onto APP_ID, then merge overrides.
			const freshId = await createApp(OWNER, TEST_PROJECT_ID, "run-seed", {
				status: "complete",
			});
			const fresh = (await db.collection("apps").doc(freshId).get()).data();
			await db.collection("apps").doc(freshId).delete();
			await db
				.collection("apps")
				.doc(APP_ID)
				.set({ ...fresh, updated_at: new Date(), ...app }, { merge: false });
		}

		async function seedCredits(
			userId: string,
			consumed: number,
		): Promise<void> {
			await db
				.collection("credits")
				.doc(userId)
				.collection("months")
				.doc(period)
				.set({
					allowance: MONTHLY_CREDIT_ALLOWANCE,
					consumed,
					bonus: 0,
					updated_at: new Date(),
				});
		}

		async function readApp(): Promise<AppShape | undefined> {
			const snap = await db.collection("apps").doc(APP_ID).get();
			return snap.exists ? (snap.data() ?? undefined) : undefined;
		}

		async function readConsumed(userId: string): Promise<number | undefined> {
			const snap = await db
				.collection("credits")
				.doc(userId)
				.collection("months")
				.doc(period)
				.get();
			return snap.exists
				? ((snap.data() as { consumed?: number }).consumed ?? 0)
				: undefined;
		}

		beforeEach(async () => {
			// Clear the app doc + both users' credit docs between cases.
			await db.collection("apps").doc(APP_ID).delete();
			for (const u of [OWNER, MEMBER]) {
				await db
					.collection("credits")
					.doc(u)
					.collection("months")
					.doc(period)
					.delete();
			}
		});

		// ── Serialize-with-wait: conflict while held, success after release ──

		it("an EDIT claim on a complete app writes a run_lock without touching status", async () => {
			const { claimRun } = await import("../apps");
			await seedApp({ status: "complete" });

			const claim = await claimRun(APP_ID, "edit", "run-1", OWNER);
			expect(claim.mode).toBe("edit");

			const app = await readApp();
			// Status is untouched — an edit never flips to `generating`.
			expect(app?.status).toBe("complete");
			const lock = app?.run_lock as
				| { runId: string; actorUserId: string; expireAt: Timestamp }
				| undefined;
			expect(lock?.runId).toBe("run-1");
			expect(lock?.actorUserId).toBe(OWNER);
			expect(lock?.expireAt).toBeInstanceOf(Timestamp);
		});

		it("a second EDIT claim conflicts while the lock is live, then succeeds after clearRunLock", async () => {
			const { claimRun, clearRunLock, RunConflictError } = await import(
				"../apps"
			);
			await seedApp({ status: "complete" });

			await claimRun(APP_ID, "edit", "run-1", OWNER);
			// A concurrent editor's claim finds the app held — it throws, and the
			// chat route's poll loop turns that into a wait rather than a 429.
			await expect(
				claimRun(APP_ID, "edit", "run-2", MEMBER),
			).rejects.toBeInstanceOf(RunConflictError);

			// The holder finishes and releases; the waiter's next poll succeeds.
			await clearRunLock(APP_ID);
			const claim = await claimRun(APP_ID, "edit", "run-2", MEMBER);
			expect(claim.mode).toBe("edit");
			expect((await readApp())?.run_lock).toMatchObject({ runId: "run-2" });
		});

		it("cross-mode: a BUILD claim waits on a live edit-lock, an EDIT claim waits on a live build", async () => {
			const { claimRun, clearRunLock, RunConflictError } = await import(
				"../apps"
			);

			// A live edit-lock blocks a build claim.
			await seedApp({
				status: "complete",
				run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
			});
			await expect(
				claimRun(APP_ID, "build", "b1", MEMBER),
			).rejects.toBeInstanceOf(RunConflictError);

			// Release the edit-lock — the build claim then takes the window (flipping
			// to `generating` and clearing the dead lock).
			await clearRunLock(APP_ID);
			const buildClaim = await claimRun(APP_ID, "build", "b1", MEMBER);
			expect(buildClaim.mode).toBe("build");
			let app = await readApp();
			expect(app?.status).toBe("generating");
			expect(app?.run_lock).toBeUndefined();

			// Now a live build blocks an edit claim (the reverse of the matrix).
			await expect(
				claimRun(APP_ID, "edit", "e2", OWNER),
			).rejects.toBeInstanceOf(RunConflictError);
			app = await readApp();
			// The rejected edit claim wrote nothing.
			expect(app?.run_lock).toBeUndefined();
		});

		it("a BUILD claim takes over a stale (past-expireAt) edit-lock", async () => {
			const { claimRun } = await import("../apps");
			await seedApp({
				status: "complete",
				// A hard-killed edit left its lock behind; its lease has expired.
				run_lock: {
					runId: "dead",
					actorUserId: OWNER,
					expireAt: lockExpiry(-1),
				},
			});

			const claim = await claimRun(APP_ID, "build", "b1", MEMBER);
			expect(claim.mode).toBe("build");
			const app = await readApp();
			expect(app?.status).toBe("generating");
			// The dead edit-lock is cleared by the build takeover.
			expect(app?.run_lock).toBeUndefined();
		});

		it("an EDIT claim overwrites a stale (past-expireAt) edit-lock", async () => {
			const { claimRun } = await import("../apps");
			await seedApp({
				status: "complete",
				run_lock: {
					runId: "dead",
					actorUserId: OWNER,
					expireAt: lockExpiry(-1),
				},
			});

			const claim = await claimRun(APP_ID, "edit", "e2", MEMBER);
			expect(claim.mode).toBe("edit");
			expect((await readApp())?.run_lock).toMatchObject({
				runId: "e2",
				actorUserId: MEMBER,
			});
		});

		// ── Settle vs reap: a completed edit's kept charge survives ──────────

		it("a settled kept-charge edit is NOT reaped even with a lapsed lock", async () => {
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

			// `settled: true` guards it — the reaper hands nothing back.
			await reapStaleReservation(APP_ID);
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			expect((await readApp())?.reservation).toMatchObject({ settled: true });
		});

		it("a completed BUILD's kept charge is NOT reaped — a build marker has no run_lock", async () => {
			const { reapStaleReservation } = await import("../apps");
			// A long build finished and flipped to `complete`; its marker is unsettled
			// in the (now-atomically-closed) window before settle. A BUILD has NO
			// `run_lock`, and the reaper reaps only a hard-killed EDIT (lock PRESENT +
			// lapsed) — "no lock" is a build's kept charge, never reaped. (This is the
			// the kept-charge protection under the single run-lock horizon.)
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
			// The build's kept charge is untouched.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
			expect((await readApp())?.reservation).toMatchObject({ settled: false });
		});

		it("refundStaleReservation does NOT claw back a LIVE edit (run_lock present, not lapsed)", async () => {
			const { refundStaleReservation } = await import("../credits");
			// The TOCTOU + the single-horizon rule: a fresh edit that won the app has
			// a LIVE `run_lock` (future `expireAt`, refreshed per commit). The reaper's
			// in-txn re-check sees the live lock and skips, so the live run's unsettled
			// charge is never clawed back — even one running far past the initial lease.
			await seedCredits(OWNER, CREDITS_PER_EDIT);
			await seedApp({
				status: "complete",
				// Live edit run — its lock's expireAt is in the future.
				run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
				reservation: {
					period,
					reserved: CREDITS_PER_EDIT,
					settled: false,
					userId: OWNER,
				},
			});

			await refundStaleReservation(APP_ID);
			// The live charge is untouched and the marker stays unsettled.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			expect((await readApp())?.reservation).toMatchObject({ settled: false });
		});

		// ── Atomic settle+release ────────────────────────────────────────────

		it("completeAndSettleRun flips status→complete AND settles the kept charge in one write", async () => {
			const { completeAndSettleRun } = await import("../apps");
			// A build's marker has no expireAt; it's unsettled at drain end. It carries
			// its `runId` (reserveCredits wrote it) — non-lenient `mine` needs it to own.
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
			const app = await readApp();
			expect(app?.status).toBe("complete");
			// Settled-as-kept in the SAME write — no window where the app is
			// `complete` (claimable) with an unsettled marker.
			expect(app?.reservation).toMatchObject({ settled: true });
			// Kept, not refunded.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
		});

		it("a completing build's charge is NOT clawed back by a following edit claim+reserve (atomic settle closes the window)", async () => {
			const { claimRun, completeAndSettleRun } = await import("../apps");
			const { reserveCredits } = await import("../credits");
			// A build finishes, THEN an edit POST lands. With the atomic settle, by the
			// time the app is `complete` (claimable) the build's marker is already
			// settled, so the edit's reserveCredits (unconditional leftover refund) sees
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

			// Build's clean completion (atomic).
			await completeAndSettleRun(APP_ID, "b1");
			// A co-member's edit now claims + reserves.
			await claimRun(APP_ID, "edit", "edit-1", MEMBER);
			await reserveCredits(MEMBER, CREDITS_PER_EDIT, APP_ID, "edit-1");

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
					expireAt: lockExpiry(MAX_RUN_MINUTES),
				},
			});

			await clearRunLockAndSettle(APP_ID, "e1");
			const app = await readApp();
			expect(app?.run_lock).toBeUndefined();
			expect(app?.reservation).toMatchObject({ settled: true });
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
		});

		// ── Reaper's internal guards ─────────────────────────────────────────

		it("refundStaleReservation REAPS an ABANDONED paused edit (paused + lapsed lease) — frees the app for a waiter", async () => {
			const { refundStaleReservation } = await import("../credits");
			// Descoped model: a paused run blocks a claim, so an abandoned one (the user
			// never answered, its lease lapsed) MUST be reaped — else it holds forever.
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
					expireAt: lockExpiry(-1),
				},
			});

			await refundStaleReservation(APP_ID);
			const app = await readApp();
			// Hold refunded, marker settled, lock released, pause cleared — a clean,
			// claimable `complete` app.
			expect(await readConsumed(OWNER)).toBe(0);
			expect(app?.reservation).toMatchObject({ settled: true });
			expect(app?.run_lock).toBeUndefined();
			expect(app?.awaiting_input).toBeFalsy();
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
					expireAt: lockExpiry(MAX_RUN_MINUTES),
				},
			});

			await refundStaleReservation(APP_ID);
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			expect((await readApp())?.reservation).toMatchObject({ settled: false });
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
					// Even with a past expireAt, a `generating` row is the build reaper's.
					expireAt: lockExpiry(-1),
				},
			});

			await refundStaleReservation(APP_ID);
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_BUILD);
			expect((await readApp())?.reservation).toMatchObject({ settled: false });
		});

		// ── Reap a stranded edit hold (hard kill) ────────────────────────────

		it("reapStaleReservation refunds a hard-killed edit's hold — run_lock present but lapsed — without flipping status", async () => {
			const { reapStaleReservation } = await import("../apps");
			// A member ran an edit on the owner's shared app, was charged 5, then
			// hard-killed: the app stays `complete`, the marker is unsettled, and its
			// `run_lock` is PRESENT but PAST its expireAt (it stopped being refreshed).
			// Per-actor billing: the MEMBER's ledger is un-booked, not the owner's.
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

			// The member's hold is handed back; the owner's ledger is untouched.
			expect(await readConsumed(MEMBER)).toBe(0);
			expect(await readConsumed(OWNER)).toBe(0);
			const app = await readApp();
			// Refund-first idempotency: the marker is settled, status unchanged.
			expect(app?.reservation).toMatchObject({ settled: true });
			expect(app?.status).toBe("complete");
		});

		it("reapStaleReservation does NOT refund a LIVE edit (run_lock present, not lapsed)", async () => {
			const { reapStaleReservation } = await import("../apps");
			await seedCredits(OWNER, CREDITS_PER_EDIT);
			await seedApp({
				status: "complete",
				// A live edit run — its lock's lease is still in the future.
				run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
				reservation: {
					period,
					reserved: CREDITS_PER_EDIT,
					settled: false,
					userId: OWNER,
				},
			});

			await reapStaleReservation(APP_ID);
			// Nothing reaped — the run is still live.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			expect((await readApp())?.reservation).toMatchObject({ settled: false });
		});

		it("reapStaleReservation does NOT reap when the marker's runId doesn't match the lapsed lock (identity guard)", async () => {
			const { reapStaleReservation } = await import("../apps");
			await seedCredits(OWNER, CREDITS_PER_EDIT);
			await seedApp({
				status: "complete",
				// A lapsed lock from run X, but the marker was written by run Y — the
				// two belong to different runs (a partial-write anomaly), so the refund
				// must NOT run off a marker that isn't the lapsed lock's.
				run_lock: {
					runId: "lock-run-X",
					actorUserId: OWNER,
					expireAt: lockExpiry(-1),
				},
				reservation: {
					period,
					reserved: CREDITS_PER_EDIT,
					settled: false,
					userId: OWNER,
					runId: "marker-run-Y",
				},
			});

			await reapStaleReservation(APP_ID);
			// The identity guard skipped it — nothing clawed back, marker still unsettled.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			expect((await readApp())?.reservation).toMatchObject({ settled: false });
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
			expect((await readApp())?.reservation).toMatchObject({ settled: true });
		});

		// ── reserveCredits refunds a leftover unsettled marker before overwriting ──

		it("reserveCredits refunds a leftover unsettled hold before booking a fresh one (same user, same month)", async () => {
			const { reserveCredits } = await import("../credits");
			// A prior hard-killed edit left an unsettled 5-credit hold on the owner's
			// own current-month doc; the owner re-edits before the reaper fired.
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

			await reserveCredits(OWNER, CREDITS_PER_EDIT, APP_ID, "run-fresh");

			// Net: the leftover 5 was refunded, then the fresh 5 booked → still 5, not 10.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			// The marker is the FRESH run's — unsettled, and carries NO `expireAt`
			// (scrubbed; liveness is the run_lock's single horizon).
			const marker = (await readApp())?.reservation as {
				settled: boolean;
				reserved: number;
				expireAt?: unknown;
			};
			expect(marker.settled).toBe(false);
			expect(marker.reserved).toBe(CREDITS_PER_EDIT);
			expect(marker.expireAt).toBeUndefined();
		});

		it("reserveCredits refunds any leftover unsettled hold UNCONDITIONALLY on overwrite", async () => {
			const { reserveCredits } = await import("../credits");
			// The caller only reaches `reserveCredits` after WINNING the claim, and
			// at-most-one-run means any unsettled marker present is a superseded run's
			// stranded hold — so it is refunded before the fresh marker overwrites it,
			// with no expiry gate of its own (the marker carries no expireAt anyway).
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

			await reserveCredits(OWNER, CREDITS_PER_EDIT, APP_ID, "run-fresh");

			// The leftover was refunded, netted into the fresh debit → 5, not 10.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			expect((await readApp())?.reservation).toMatchObject({
				settled: false,
				reserved: CREDITS_PER_EDIT,
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
			const app = await readApp();
			expect(app?.run_lock).toBeUndefined();
			expect(app?.status).toBe("complete");
			expect(app?.reservation).toMatchObject({ settled: true });
		});

		// ── A paused run's live hold stays unsettled + refundable ─────────────

		it("a paused edit's unsettled hold survives (never settled) and a failed resume refunds it in full", async () => {
			// The route's paused finalize skips `settleReservation` + `clearRunLock`
			// (gated on `ctx.pausedOnInput()`), so a paused edit's marker stays a LIVE
			// hold and its lock persists for the resume. This composes that state: the
			// hold is unsettled after the pause, and when a later resume FAILS, the
			// failure funnel's `refundReservation` hands it back off the untouched
			// marker — a paused run within its lease is a live hold, not a kept charge.
			const { refundReservation } = await import("../credits");
			await seedCredits(OWNER, CREDITS_PER_EDIT);
			await seedApp({
				status: "complete",
				// The paused edit still holds its lock (the route left it, paused).
				run_lock: { runId: "e1", actorUserId: OWNER, expireAt: lockExpiry(10) },
				// The hold booked at reserve time — UNSETTLED, because a paused run is
				// never settled.
				reservation: {
					period,
					reserved: CREDITS_PER_EDIT,
					settled: false,
					userId: OWNER,
					expireAt: lockExpiry(MAX_RUN_MINUTES),
				},
			});

			// The paused hold is unsettled and the lock is still held — nothing
			// settled it, exactly as the route's paused finalize leaves it.
			let app = await readApp();
			expect(app?.reservation).toMatchObject({ settled: false });
			expect(app?.run_lock).toMatchObject({ runId: "e1" });

			// A later resume FAILS — the failure funnel refunds off the marker.
			await refundReservation(APP_ID, "e1");
			expect(await readConsumed(OWNER)).toBe(0);
			app = await readApp();
			expect(app?.reservation).toMatchObject({ settled: true });
		});

		// ── loadAppHolderName projected read ──────────────────────────────────

		it("loadAppHolderName resolves the holder from a projected read without pulling the blueprint", async () => {
			const { loadAppHolderName } = await import("../apps");
			// Seed an edit-lock holder. The projected read (`documentId()` +
			// `.select("run_lock.actorUserId", …)`) must pick up the holder id without
			// a full `loadApp`. The `auth_user` name lookup has no Postgres in the
			// emulator harness, so it fails-safe to "someone" — this asserts the
			// projected APP read succeeds (no throw) and yields a string.
			await seedApp({
				status: "complete",
				run_lock: {
					runId: "e1",
					actorUserId: OWNER,
					expireAt: lockExpiry(10),
				},
			});

			const name = await loadAppHolderName(APP_ID);
			// Falls back to "someone" (no auth DB), but the point is the app read
			// resolved the holder id from the projection and didn't throw.
			expect(typeof name).toBe("string");
			expect(name.length).toBeGreaterThan(0);
		});

		// ── Faithful bail-out restore ─────────────────────────────────────────

		it("a bailed edit-over-complete restores plain complete (no lock, no pause flag)", async () => {
			const { claimRun, restoreRunState } = await import("../apps");
			await seedApp({ status: "complete" });

			const claim = await claimRun(APP_ID, "edit", "e1", OWNER);
			expect((await readApp())?.run_lock).toMatchObject({ runId: "e1" });

			await restoreRunState(APP_ID, claim.prior);

			const app = await readApp();
			expect(app?.status).toBe("complete");
			// The lock the edit claim wrote is gone; no stray pause flag.
			expect(app?.run_lock).toBeUndefined();
			expect(app?.awaiting_input).toBeFalsy();
		});

		// ── Restore reverts updated_at VERBATIM ───────────────────────────────

		it("a bailed build-over-stale-generating restore reverts updated_at VERBATIM (no phantom in-progress)", async () => {
			const { claimRun, restoreRunState } = await import("../apps");
			// A hard-killed build left the row `generating` with a STALE `updated_at`
			// (past the staleness window → immediately reclaimable). A retry's claim
			// displaces it, then BAILS. The revert must write the ORIGINAL stale
			// `updated_at` back — NOT a fresh stamp that re-arms the ~10-min staleness
			// clock (which would make `hasActiveGeneration` read it live → a phantom
			// "in progress" rejecting every retry for 10 min).
			const staleAt = new Date(Date.now() - 20 * 60_000);
			await seedApp({ status: "generating", updated_at: staleAt });
			// The seeded stale timestamp, read back as a Firestore Timestamp.
			const before = (await readApp())?.updated_at as Timestamp;

			const claim = await claimRun(APP_ID, "build", "b1", OWNER);
			// The claim re-armed updated_at (fresh); the prior snapshot kept the stale one.
			expect(claim.prior.updated_at).toBeDefined();

			await restoreRunState(APP_ID, claim.prior);

			const after = (await readApp())?.updated_at as Timestamp;
			// Reverted VERBATIM — the stale timestamp is back (still past the window),
			// so the row is immediately reclaimable, not a fresh phantom.
			expect(after.toMillis()).toBe(before.toMillis());
			expect(Date.now() - after.toDate().getTime()).toBeGreaterThan(
				15 * 60_000,
			);
		});

		// ── A live long edit (lease refreshed) is NOT reaped ──────────────────

		it("a live edit past the initial MAX_RUN_MINUTES lease is NOT reaped once its run_lock is refreshed", async () => {
			const { reapStaleReservation } = await import("../apps");
			// An edit running longer than the initial MAX_RUN_MINUTES lease refreshes
			// its `run_lock.expireAt` per commit. The reaper keys ONLY on the run_lock,
			// so a refreshed (future) lock reads as live, not reaped — even though the
			// run started well over MAX_RUN_MINUTES ago.
			await seedCredits(OWNER, CREDITS_PER_EDIT);
			await seedApp({
				status: "complete",
				// The lock was refreshed to a fresh future deadline (a live long edit).
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
			// Live — not clawed back.
			expect(await readConsumed(OWNER)).toBe(CREDITS_PER_EDIT);
			expect((await readApp())?.reservation).toMatchObject({ settled: false });
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

			// Owns it → true, and atomically re-arms updated_at + clears the pause.
			expect(await reacquireLease(APP_ID, "build-run", "build")).toBe(true);
			const app = await readApp();
			expect(app?.awaiting_input).toBeFalsy();
			expect(app?.status).toBe("generating");
			// updated_at re-armed to ~now (the frozen-during-pause clock restarts).
			const updatedAt = (app?.updated_at as Timestamp).toDate().getTime();
			expect(Date.now() - updatedAt).toBeLessThan(30_000);
		});

		it("reacquireLease (edit): a paused edit whose lease LAPSED while answering is renewed, not reaped", async () => {
			const { reacquireLease } = await import("../apps");
			// A paused edit whose 15-min lease already lapsed during the user's answer
			// (the lapsed-lease-during-answer case): still `mine` (lock present, runId matches), but a
			// check that ignored the lease would proceed on a dead lock and be reaped.
			await seedApp({
				status: "complete",
				awaiting_input: true,
				run_lock: {
					runId: "edit-paused",
					actorUserId: OWNER,
					expireAt: lockExpiry(-1),
				},
			});

			expect(await reacquireLease(APP_ID, "edit-paused", "edit")).toBe(true);
			const app = await readApp();
			expect(app?.awaiting_input).toBeFalsy();
			// The lease was RE-STAMPED to a fresh future deadline — not left lapsed.
			const lock = app?.run_lock as { expireAt: Timestamp };
			expect(lock.expireAt.toDate().getTime()).toBeGreaterThan(Date.now());
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

			// The lock's deadline was pushed back to ~a full MAX_RUN_MINUTES lease.
			const lock = (await readApp())?.run_lock as {
				expireAt: Timestamp;
			};
			const remainingMs = lock.expireAt.toDate().getTime() - Date.now();
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

			const lock = (await readApp())?.run_lock as {
				runId: string;
				expireAt: Timestamp;
			};
			expect(lock.runId).toBe("co-member-run");
			// The taker's deadline is untouched (not extended by the old run).
			expect(lock.expireAt.toMillis()).toBe(takenExpiry.toMillis());
		});

		it("refreshEditLease is a clean no-op for a BUILD (no run_lock to match)", async () => {
			const { refreshEditLease } = await import("../apps");
			await seedApp({ status: "generating" });
			// A build has no lock; the heartbeat matches nothing and writes nothing.
			await refreshEditLease(APP_ID, "some-build-run");
			expect((await readApp())?.run_lock).toBeUndefined();
		});

		// ── An edit always leaves the app 'complete' ──────────────────────────

		it("an EDIT claim on a stale generating row normalizes status to complete", async () => {
			const { claimRun } = await import("../apps");
			// A hard-killed build B left the app `generating` past the staleness
			// window; co-editor A's tab still shows Ready and sends an edit. The edit
			// claim must normalize status→complete so A's clean finalize
			// (`clearRunLockAndSettle`, which doesn't touch status) doesn't leave a
			// `generating` row for `reapStaleGenerating` to flip to error — bricking a
			// cleanly-edited app.
			await seedApp({
				status: "generating",
				updated_at: new Date(Date.now() - 20 * 60_000), // past staleness
			});

			const claim = await claimRun(APP_ID, "edit", "e1", OWNER);
			expect(claim.mode).toBe("edit");
			const app = await readApp();
			// Normalized to complete + holds the edit lock.
			expect(app?.status).toBe("complete");
			expect(app?.run_lock).toMatchObject({ runId: "e1" });
		});

		// ── A fresh reservation over a legacy marker scrubs any stale expireAt ──

		it("reserveCredits over a legacy marker with expireAt scrubs it (no merge inheritance)", async () => {
			const { reserveCredits } = await import("../credits");
			// A LEGACY marker carries an `expireAt` (from before the single-horizon
			// consolidation). `reserveCredits` merges a fresh marker over it — with
			// `merge:true` the nested `expireAt` would be INHERITED unless explicitly
			// deleted. The `FieldValue.delete()` scrub must leave the fresh marker with
			// NO expireAt (liveness is the run_lock's single horizon).
			await seedCredits(OWNER, 0);
			await seedApp({
				status: "generating",
				reservation: {
					period,
					reserved: CREDITS_PER_EDIT,
					settled: true,
					userId: OWNER,
					// The legacy marker's expireAt that must NOT survive.
					expireAt: lockExpiry(-1),
				},
			});

			await reserveCredits(OWNER, CREDITS_PER_BUILD, APP_ID, "build-fresh");

			const marker = (await readApp())?.reservation as
				| { expireAt?: unknown; reserved: number }
				| undefined;
			// The fresh marker booked, and its expireAt is GONE (not inherited).
			expect(marker?.reserved).toBe(CREDITS_PER_BUILD);
			expect(marker?.expireAt).toBeUndefined();
		});

		/* A live edit refreshes its `run_lock.expireAt` on each
		 * `commitGuardedBatch` (so a >MAX_RUN_MINUTES edit isn't barged) — is
		 * exercised in `commitGuardedBatch.integration.test.ts`, which already has
		 * the full committable-app + `projectRoleFor` mock harness a guarded commit
		 * needs. */
	},
);
