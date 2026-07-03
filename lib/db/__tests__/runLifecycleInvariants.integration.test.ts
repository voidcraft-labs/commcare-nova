/**
 * P9 run-lifecycle INVARIANT MATRIX — the capstone proof of the serialize-with-wait
 * + lease-reap model. Against a REAL Firestore emulator, it drives the genuine
 * db-layer primitives (`claimRun` / `reserveCredits` / `completeAndSettleRun` /
 * `clearRunLockAndSettle` / `settleAndRelease` / `reacquireLease` /
 * `refreshEditLease` / `reapStaleReservation` / `reapStaleGenerating`) the way
 * the chat route composes them, across the lifecycle cells
 * {build, edit} × {clean, failed, paused, hard-killed, resumed} + serialize-wait +
 * the reaper-race window, and asserts the FIVE global invariants hold in every cell:
 *
 *   I1 no double-charge     — a run's actor is debited AT MOST its one cost.
 *   I2 no stranded lock     — a terminal edit is never `complete` + lock present
 *                             + unsettled marker with no live run (a strand).
 *   I3 no clawed-back kept  — a settled/kept charge is never handed back.
 *   I4 no double-run        — at most ONE run is `live` on an app at a time.
 *   I5 resumed-keeps-charge — an edit resumed after its lease lapsed keeps its
 *                             charge (renew-not-reap).
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset — run via
 * `npm run test:integration`.
 */

import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore, type Timestamp } from "firebase-admin/firestore";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	CREDITS_PER_BUILD,
	CREDITS_PER_EDIT,
	MONTHLY_CREDIT_ALLOWANCE,
} from "@/lib/db/creditPolicy";
import { getDb } from "@/lib/db/firestore";
import { getCurrentPeriod } from "@/lib/db/period";
import { runLeaseState } from "@/lib/db/runLiveness";
import type { AppDoc } from "@/lib/db/types";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const PROJECT = "demo-test";
const OWNER = "user-lifecycle-owner";
const MEMBER = "user-lifecycle-member";
const APP = "app-lifecycle";
const APP_B = "app-lifecycle-b";

describe.skipIf(!emulatorAvailable)("P9 run-lifecycle invariant matrix", () => {
	let db: Firestore;
	const period = getCurrentPeriod();

	beforeAll(() => {
		if (getApps().length === 0) initializeApp({ projectId: PROJECT });
		db = new Firestore({ projectId: PROJECT, preferRest: true });
	});
	afterAll(async () => {
		await db.terminate();
		for (const app of getApps()) await deleteApp(app);
	});

	async function seedCredits(userId: string, consumed = 0): Promise<void> {
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
	async function consumed(userId: string): Promise<number> {
		const snap = await db
			.collection("credits")
			.doc(userId)
			.collection("months")
			.doc(period)
			.get();
		return (snap.data()?.consumed as number | undefined) ?? 0;
	}
	/** Seed a full converter-parseable app at a fixed id, then merge P9 overrides. */
	async function seedApp(appId: string, over: Record<string, unknown> = {}) {
		const { createApp } = await import("../apps");
		const freshId = await createApp(OWNER, PROJECT, "seed", {
			status: "complete",
		});
		const fresh = (await db.collection("apps").doc(freshId).get()).data();
		await db.collection("apps").doc(freshId).delete();
		await db
			.collection("apps")
			.doc(appId)
			.set({ ...fresh, updated_at: new Date(), ...over }, { merge: false });
	}
	async function readApp(appId: string): Promise<Partial<AppDoc> | undefined> {
		const snap = await db.collection("apps").doc(appId).get();
		return snap.exists ? (snap.data() as Partial<AppDoc>) : undefined;
	}

	/** I2: a terminal app is never lock-present + unsettled-marker + no-live-run. */
	async function assertNoStrand(appId: string) {
		const app = await readApp(appId);
		if (!app) return;
		const lease = runLeaseState(app);
		// A settleable (unsettled) marker on a NON-live, NON-paused app whose lock is
		// still present is the exact "lock-cleared-while-unsettled" strand.
		const stranded =
			lease.markerSettleable &&
			!lease.live &&
			!lease.paused &&
			!!app.run_lock &&
			// …unless it's the reapable-edit shape the reaper is designed to clean up.
			!lease.reapableStrandedEdit;
		expect(stranded).toBe(false);
	}

	beforeEach(async () => {
		for (const id of [APP, APP_B]) await db.collection("apps").doc(id).delete();
		await seedCredits(OWNER);
		await seedCredits(MEMBER);
	});

	// ── BUILD lifecycle ──────────────────────────────────────────────────

	it("build · clean: charged once, settled-kept, not reaped (I1/I3)", async () => {
		const { claimRun, completeAndSettleRun, reapStaleReservation } =
			await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		await completeAndSettleRun(APP, "b1");

		expect(await consumed(OWNER)).toBe(CREDITS_PER_BUILD); // I1
		expect((await readApp(APP))?.reservation).toMatchObject({ settled: true });
		await reapStaleReservation(APP);
		await assertNoStrand(APP);
		expect(await consumed(OWNER)).toBe(CREDITS_PER_BUILD); // I3 — not clawed back
	});

	it("build · failed: refunded (I1=0), flipped to error, no strand", async () => {
		const { claimRun } = await import("../apps");
		const { reserveCredits, settleAndRelease } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		// The route's failure funnel for a build: settle+refund (no lock to release).
		const { settled } = await settleAndRelease(APP, "b1", {
			releaseLock: false,
		});
		expect(settled).toBe(true);
		expect(await consumed(OWNER)).toBe(0); // I1 — refunded
		await assertNoStrand(APP);
	});

	it("build · hard-killed: reaped off the staleness window, refunded once (I1)", async () => {
		const { claimRun, reapStaleGenerating } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		// Hard kill: freeze updated_at outside the window.
		await db
			.collection("apps")
			.doc(APP)
			.set({ updated_at: new Date(Date.now() - 60 * 60_000) }, { merge: true });
		await reapStaleGenerating(APP);
		expect(await consumed(OWNER)).toBe(0); // I1 — refunded
	});

	// ── EDIT lifecycle ───────────────────────────────────────────────────

	it("edit · clean: charged once, lock released + settled atomically, not reaped (I1/I2/I3)", async () => {
		const { claimRun, clearRunLockAndSettle, reapStaleReservation } =
			await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");
		await clearRunLockAndSettle(APP, "e1");

		const app = await readApp(APP);
		expect(app?.run_lock).toBeUndefined(); // released
		expect(app?.reservation).toMatchObject({ settled: true });
		await assertNoStrand(APP); // I2
		await reapStaleReservation(APP);
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // I1/I3
	});

	it("edit · failed with refund THROW-free settle+release: no strand (I2), refunded (I1)", async () => {
		const { claimRun } = await import("../apps");
		const { reserveCredits, settleAndRelease } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", MEMBER);
		await reserveCredits(MEMBER, CREDITS_PER_EDIT, APP, "e1");
		// The route's failure funnel for an edit: refund + settle + release, ONE txn.
		const { settled } = await settleAndRelease(APP, "e1", {
			releaseLock: true,
		});
		expect(settled).toBe(true);
		const app = await readApp(APP);
		expect(app?.run_lock).toBeUndefined(); // released only because settled
		expect(await consumed(MEMBER)).toBe(0); // I1 — refunded to the actor
		await assertNoStrand(APP); // I2 — the lock/settle strand can't happen
	});

	it("edit · hard-killed: reaped off the lapsed lock, refunded once (I1), never a live edit clawed (I3)", async () => {
		const { claimRun, reapStaleReservation } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", MEMBER);
		await reserveCredits(MEMBER, CREDITS_PER_EDIT, APP, "e1");
		// Hard kill: lapse the lease (dotted-path `update` so the dot is a PATH into
		// the nested `run_lock`, not a literal field name a merge-`set` would create).
		await db
			.collection("apps")
			.doc(APP)
			.update({ "run_lock.expireAt": new Date(Date.now() - 60_000) });
		await reapStaleReservation(APP);
		expect(await consumed(MEMBER)).toBe(0); // I1 — refunded

		// I3: a LIVE edit (future lease) is NEVER clawed back by the reaper.
		await seedApp(APP_B, { status: "complete" });
		await claimRun(APP_B, "edit", "e2", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP_B, "e2");
		await reapStaleReservation(APP_B);
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // not clawed
	});

	it("edit · resumed-after-lapse: reacquireLease renews the lease + keeps the charge (I5)", async () => {
		const { claimRun, reacquireLease, reapStaleReservation } = await import(
			"../apps"
		);
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");
		// The run paused; while the user answered, its lease LAPSED.
		await db
			.collection("apps")
			.doc(APP)
			.update({
				awaiting_input: true,
				"run_lock.expireAt": new Date(Date.now() - 1000),
			});
		// The resume re-acquires: still mine → renew the lease, don't get reaped.
		expect(await reacquireLease(APP, "e1", "edit")).toBe(true);
		const app = await readApp(APP);
		expect(app?.awaiting_input).toBeFalsy();
		expect(runLeaseState(app ?? {}).live).toBe(true); // lease renewed → live
		// A reaper pass now finds a LIVE edit and hands nothing back.
		await reapStaleReservation(APP);
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // I5
	});

	// ── Cross-run interactions ───────────────────────────────────────────

	it("cross-app: a user can edit app B while a live build holds app A (no cross-app block)", async () => {
		const { claimRun, hasActiveGeneration } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		// A live build on app A (owner).
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "a-build", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "a-build");

		// An EDIT on app B by the same owner claims cleanly — an edit serializes
		// per-app via its run_lock, never per-user, so app A's build must not block it.
		await seedApp(APP_B, { status: "complete" });
		await expect(
			claimRun(APP_B, "edit", "b-edit", OWNER),
		).resolves.toMatchObject({ mode: "edit" });
		// The build-only per-user concurrency query still sees app A's build (that's
		// the guard the route runs ONLY for a new build POST, not an edit).
		expect(await hasActiveGeneration(OWNER, APP_B)).toBe(true);
	});

	it("serialize-with-wait: a second live-run claim of EITHER mode throws until release (I4)", async () => {
		const { claimRun, clearRunLockAndSettle, RunConflictError } = await import(
			"../apps"
		);
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");

		// A concurrent claim (build OR edit) conflicts while the edit is live — I4.
		await expect(claimRun(APP, "build", "b2", MEMBER)).rejects.toBeInstanceOf(
			RunConflictError,
		);
		await expect(claimRun(APP, "edit", "e2", MEMBER)).rejects.toBeInstanceOf(
			RunConflictError,
		);

		// Once the holder releases, the next claim proceeds.
		await clearRunLockAndSettle(APP, "e1");
		await expect(claimRun(APP, "edit", "e2", MEMBER)).resolves.toMatchObject({
			mode: "edit",
		});
	});

	// ── Terminal writers gate on ownership in-txn (reaper-race no-op) ─────

	it("a REAPED-then-reclaimed edit's stale clean writer no-ops — the new run's lock + marker are untouched", async () => {
		const { claimRun, clearRunLockAndSettle, reapStaleReservation } =
			await import("../apps");
		const { reserveCredits } = await import("../credits");
		// e1 claims + reserves, its lease lapses (a long no-heartbeat stretch), the
		// REAPER frees it, and e2 then claims the freed app. e1's stale terminal clean
		// writer lands LAST and must NO-OP rather than clobber e2 (the surviving race
		// without a barge).
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");
		await db
			.collection("apps")
			.doc(APP)
			.update({ "run_lock.expireAt": new Date(Date.now() - 1000) });
		await reapStaleReservation(APP); // frees the app (refund e1 + release lock)
		await claimRun(APP, "edit", "e2", MEMBER); // e2 claims the now-free app
		await reserveCredits(MEMBER, CREDITS_PER_EDIT, APP, "e2");

		// e1's stale clean finalize must NO-OP (mode edit, but run_lock.runId === e2).
		await clearRunLockAndSettle(APP, "e1");

		const app = await readApp(APP);
		expect(runLeaseState(app ?? {}).mine("e2")).toBe(true);
		expect(app?.run_lock).toBeDefined();
		expect(app?.reservation).toMatchObject({ settled: false, runId: "e2" });
		// e1 was refunded by the reaper; e2's charge is intact (not clawed).
		expect(await consumed(OWNER)).toBe(0);
		expect(await consumed(MEMBER)).toBe(CREDITS_PER_EDIT);
	});

	it("a REAPED-then-reclaimed build's settleAndRelease no-ops (settled:false) — the new run's marker is untouched", async () => {
		const { claimRun, reapStaleGenerating } = await import("../apps");
		const { reserveCredits, settleAndRelease } = await import("../credits");
		// b1's build goes stale (long no-commit), the REAPER flips it to error +
		// refunds, and b2 claims the freed app. b1 then fails → settleAndRelease must
		// no-op (b2 owns the app) and report settled:false so the route won't failApp
		// b2's app.
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		await db
			.collection("apps")
			.doc(APP)
			.update({ updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP); // frees the app (refund b1 + flip to error)
		await claimRun(APP, "build", "b2", MEMBER); // b2 claims the freed app
		await reserveCredits(MEMBER, CREDITS_PER_BUILD, APP, "b2");

		const { settled } = await settleAndRelease(APP, "b1", {
			releaseLock: false,
		});
		expect(settled).toBe(false);
		expect((await readApp(APP))?.reservation).toMatchObject({
			settled: false,
			runId: "b2",
		});
		expect(await consumed(MEMBER)).toBe(CREDITS_PER_BUILD);
	});

	it("reaper-race window: a reaped-ghost BUILD's settleAndRelease returns settled:FALSE in the [b2-claim, b2-reserve) window — no failApp", async () => {
		const { claimRun, reapStaleGenerating } = await import("../apps");
		const { reserveCredits, settleAndRelease } = await import("../credits");
		// THE reaper-race the descope's 'no window' claim missed. b1's build goes
		// stale mid-run → reaped (marker SETTLED + runId CLEARED, status→error) → b2
		// re-claims (status→generating) but has NOT yet reserveCredits'd, so the marker
		// is still {settled:true, runId:CLEARED}. b1 then fatal-errors → settleAndRelease.
		// The runId-clear is what makes this safe: non-lenient mine(b1) on a
		// runId-cleared marker = FALSE → ownedByMe=false → settled:FALSE → the route
		// SKIPS failApp, so b2's live build is NOT bricked and its future hold survives.
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		await db
			.collection("apps")
			.doc(APP)
			.update({ updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP); // marker settled + runId cleared, status→error
		// The reaped marker: settled, runId gone (userId/reserved survive).
		const reaped = (await readApp(APP))?.reservation;
		expect(reaped).toMatchObject({ settled: true, userId: OWNER });
		expect(reaped?.runId).toBeUndefined();

		await claimRun(APP, "build", "b2", MEMBER); // b2 claims; does NOT reserve yet

		const { settled } = await settleAndRelease(APP, "b1", {
			releaseLock: false,
		});
		expect(settled).toBe(false); // reaped ghost → no failApp
		// b2's app is untouched — still generating (NOT flipped to error).
		expect((await readApp(APP))?.status).toBe("generating");
	});

	it("a NORMAL failed BUILD (not reaped) still returns settled:TRUE → failApp fires (no stuck-generating)", async () => {
		const { claimRun } = await import("../apps");
		const { reserveCredits, settleAndRelease } = await import("../credits");
		// The complement: a build whose marker was pre-settled by its OWN flush (not
		// the reaper) still carries runId=b1, so non-lenient mine(b1)=TRUE →
		// settled:TRUE → the route DOES failApp. Guards against regressing the
		// flush-pre-settled-failApp fix while adding the reaper-race clear.
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		// Simulate the flush pre-settling THIS run's own marker (runId intact).
		await db
			.collection("apps")
			.doc(APP)
			.set(
				{
					reservation: {
						period,
						reserved: CREDITS_PER_BUILD,
						settled: true,
						userId: OWNER,
						runId: "b1",
					},
				},
				{ merge: true },
			);

		const { settled } = await settleAndRelease(APP, "b1", {
			releaseLock: false,
		});
		expect(settled).toBe(true); // owns its outcome → failApp fires
	});

	it("a LEGACY no-runId marker is owned by NOBODY (non-lenient mine) and reaped by the reaper's own lenient clause", async () => {
		const { reapStaleGenerating } = await import("../apps");
		// A marker stranded from BEFORE the P9 deploy carries no runId. Non-lenient
		// `mine(anyone)` = false (owned by nobody), so no terminal writer touches it —
		// it's resolved by the REAPER, whose own hardcoded lenient clause (`!runId ||
		// ...`) still reaps it. A stale generating build with a legacy marker:
		await seedCredits(OWNER, CREDITS_PER_BUILD);
		await db
			.collection("apps")
			.doc(APP)
			.set(
				{
					status: "generating",
					updated_at: new Date(Date.now() - 60 * 60_000),
					reservation: {
						period,
						reserved: CREDITS_PER_BUILD,
						settled: false,
						userId: OWNER,
					},
				},
				{ merge: true },
			);
		// mine is false for everyone (no runId) — but the reaper still fires.
		const lease = runLeaseState((await readApp(APP)) ?? {});
		expect(lease.mine("anyone")).toBe(false);
		expect(lease.reapableStaleBuild).toBe(true);

		await reapStaleGenerating(APP);
		// Reaped: refunded + status→error.
		expect((await readApp(APP))?.status).toBe("error");
		expect(await consumed(OWNER)).toBe(0);
	});

	it("the build reaper does NOT claw a FRESH re-claimed build (in-txn staleness re-check)", async () => {
		const { claimRun, reapStaleGenerating } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		// A stale build row (b1) that a scan flagged as hard-killed…
		await seedApp(APP, {
			status: "generating",
			updated_at: new Date(Date.now() - 60 * 60_000),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
				runId: "b1",
			},
		});
		// …but a FRESH build (b2) re-claims + reserves between the scan and the reap.
		await claimRun(APP, "build", "b2", MEMBER);
		await reserveCredits(MEMBER, CREDITS_PER_BUILD, APP, "b2");

		// The reap re-validates in-txn: the row is now a LIVE fresh build → no-op.
		await reapStaleGenerating(APP);
		const app = await readApp(APP);
		expect(app?.status).toBe("generating"); // NOT flipped to error
		expect(await consumed(MEMBER)).toBe(CREDITS_PER_BUILD); // fresh charge intact
	});

	it("a clean edit completion RETRIES a transient Firestore fault and lands (no lockout)", async () => {
		const { claimRun, clearRunLockAndSettle } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");

		// Inject ONE transient (gRPC UNAVAILABLE=14) fault, then let the retry land.
		const realRunTx = getDb().runTransaction.bind(getDb());
		let faulted = false;
		const spy = vi.spyOn(getDb(), "runTransaction").mockImplementation((async (
			...args: Parameters<typeof realRunTx>
		) => {
			if (!faulted) {
				faulted = true;
				throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
			}
			return realRunTx(...args);
		}) as typeof realRunTx);
		try {
			await clearRunLockAndSettle(APP, "e1");
		} finally {
			spy.mockRestore();
		}
		expect(faulted).toBe(true); // the fault fired
		const app = await readApp(APP);
		expect(app?.run_lock).toBeUndefined(); // released despite the blip — no lockout
		expect(app?.reservation).toMatchObject({ settled: true });
	});

	it("the edit reaper RELEASES a persistently-stranded lock (not only settles)", async () => {
		const { reapStaleReservation } = await import("../apps");
		await seedCredits(OWNER, CREDITS_PER_EDIT);
		// A stranded edit whose lock persists (e.g. a clean settle+release kept
		// failing): complete, unsettled marker, lapsed lock of the same run.
		await seedApp(APP, {
			status: "complete",
			run_lock: {
				runId: "e1",
				actorUserId: OWNER,
				expireAt: new Date(Date.now() - 60_000),
			},
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: OWNER,
				runId: "e1",
			},
		});

		await reapStaleReservation(APP);
		const app = await readApp(APP);
		expect(app?.reservation).toMatchObject({ settled: true }); // refunded
		expect(app?.run_lock).toBeUndefined(); // AND released → no 15-min lockout
		expect(await consumed(OWNER)).toBe(0);
	});

	it("edit-claim on an ERROR app clears error_type (complete + null, not a stale classification)", async () => {
		const { claimRun } = await import("../apps");
		await seedApp(APP, { status: "error", error_type: "internal" });
		await claimRun(APP, "edit", "e1", OWNER);
		const app = await readApp(APP);
		expect(app?.status).toBe("complete");
		expect(app?.error_type).toBeNull(); // the projectAppSummary contract holds
	});

	// ── Terminal-writer transient retry ──────────────────────────────────

	it("settleAndRelease RETRIES a transient Firestore fault and lands (failed-edit lock released, no lockout)", async () => {
		const { claimRun } = await import("../apps");
		const { reserveCredits, settleAndRelease } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");

		const realRunTx = getDb().runTransaction.bind(getDb());
		let faulted = false;
		const spy = vi.spyOn(getDb(), "runTransaction").mockImplementation((async (
			...args: Parameters<typeof realRunTx>
		) => {
			if (!faulted) {
				faulted = true;
				throw Object.assign(new Error("UNAVAILABLE"), { code: 14 });
			}
			return realRunTx(...args);
		}) as typeof realRunTx);
		try {
			const { settled } = await settleAndRelease(APP, "e1", {
				releaseLock: true,
			});
			expect(settled).toBe(true);
		} finally {
			spy.mockRestore();
		}
		expect(faulted).toBe(true);
		const app = await readApp(APP);
		expect(app?.run_lock).toBeUndefined(); // released despite the blip
	});

	// ── Failed-build finalize ordering + paused-run self-resume ───────────

	it("a failed BUILD is resolved-for-failApp even when flush pre-settled its marker (no stuck-generating)", async () => {
		const { claimRun } = await import("../apps");
		const { reserveCredits, refundReservation, settleAndRelease } =
			await import("../credits");
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		// The route's failure funnel runs `flush()` FIRST — which refunds+SETTLES the
		// marker (the common failed-build path).
		await refundReservation(APP, "b1");
		expect((await readApp(APP))?.reservation).toMatchObject({ settled: true });

		// THEN settleAndRelease: the marker is already settled (markerSettleable
		// false), but this run still OWNS the app → it must return settled:TRUE so the
		// route's `failApp` fires (the return separates "resolved" from "I wrote a settle" —
		// and the build sat generating for ~10min).
		const { settled } = await settleAndRelease(APP, "b1", {
			releaseLock: false,
		});
		expect(settled).toBe(true);
		expect(await consumed(OWNER)).toBe(0); // stayed refunded (no double-touch)
	});

	it("a paused run's OWN untaken resume still succeeds (no takeover — marker runId + lock intact)", async () => {
		const { claimRun, reacquireLease } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		// A paused EDIT with NO takeover — its lock is present and marker.runId is its own.
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");
		await db
			.collection("apps")
			.doc(APP)
			.set({ awaiting_input: true }, { merge: true });

		// Its own answered-resume re-acquires cleanly (still owns the lock + marker).
		expect(await reacquireLease(APP, "e1", "edit")).toBe(true);
		const app = await readApp(APP);
		expect(app?.awaiting_input).toBeFalsy();
		expect(runLeaseState(app ?? {}).mine("e1")).toBe(true);
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // charge kept
	});

	// ── Descoped model: serialize-with-wait + lease-reap (no takeover) ────

	it("a waiter behind a LIVE run is blocked (RunConflictError) and proceeds once the holder COMPLETES", async () => {
		const { claimRun, clearRunLockAndSettle, RunConflictError } = await import(
			"../apps"
		);
		const { reserveCredits } = await import("../credits");
		// e1 holds a live edit; a co-member's claim (build OR edit) is blocked.
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");
		await expect(claimRun(APP, "edit", "e2", MEMBER)).rejects.toBeInstanceOf(
			RunConflictError,
		);
		await expect(claimRun(APP, "build", "b2", MEMBER)).rejects.toBeInstanceOf(
			RunConflictError,
		);

		// e1 completes cleanly (its terminal path frees the app) → the waiter proceeds.
		await clearRunLockAndSettle(APP, "e1");
		await expect(claimRun(APP, "edit", "e2", MEMBER)).resolves.toMatchObject({
			mode: "edit",
		});
	});

	it("a waiter behind a PAUSED run is blocked, and proceeds once the paused run's lease lapses and it is REAPED", async () => {
		const { claimRun, reapStaleReservation, RunConflictError } = await import(
			"../apps"
		);
		const { reserveCredits } = await import("../credits");
		// A PAUSED edit holds the app — a paused run now BLOCKS (no takeover).
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "edit", "e1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_EDIT, APP, "e1");
		await db
			.collection("apps")
			.doc(APP)
			.set({ awaiting_input: true }, { merge: true });
		await expect(claimRun(APP, "build", "b2", MEMBER)).rejects.toBeInstanceOf(
			RunConflictError,
		);

		// The paused run's lease lapses (no heartbeat while paused) and the user
		// never answers — an ABANDONED paused edit. The reaper keys on the lapsed
		// lease alone (`reapableStrandedEdit` does NOT exclude `awaiting_input`),
		// so it frees the still-paused run: refund + release lock + clear the pause.
		await db
			.collection("apps")
			.doc(APP)
			.update({ "run_lock.expireAt": new Date(Date.now() - 1000) });
		await reapStaleReservation(APP); // frees the app (refund + release lock)
		expect(await consumed(OWNER)).toBe(0); // the abandoned run was refunded
		await expect(claimRun(APP, "build", "b2", MEMBER)).resolves.toMatchObject({
			mode: "build",
		});
	});

	it("a waiter behind a HARD-KILLED run proceeds after the reaper frees it", async () => {
		const { claimRun, reapStaleGenerating } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		// A hard-killed BUILD (stale generating). A retry claim can proceed the moment
		// the row reads not-live (past the window) — but the reaper first frees the
		// stranded hold. Drive: stale the build, reap it (→ error + refund), then claim.
		await seedApp(APP, { status: "complete" });
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		await db
			.collection("apps")
			.doc(APP)
			.update({ updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP);
		expect(await consumed(OWNER)).toBe(0); // hard-killed hold refunded

		await expect(claimRun(APP, "build", "b2", MEMBER)).resolves.toMatchObject({
			mode: "build",
		});
	});
	// ── False-reap self-heal + build liveness heartbeat ───────────────────

	it("a reaped-but-UNCLAIMED build's clean completion self-heals error → complete (refund stands)", async () => {
		const { claimRun, completeAndSettleRun, reapStaleGenerating } =
			await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await seedCredits(OWNER);
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		// The live build's clock lapses mid-run (a long no-commit stretch on a
		// pre-heartbeat row) and a scan reaps it: refund + error + runId cleared.
		await db
			.collection("apps")
			.doc(APP)
			.update({ updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP);
		expect(await consumed(OWNER)).toBe(0);
		expect((await readApp(APP))?.status).toBe("error");
		// The zombie kept committing — the app's last committed batch is b1's
		// (writeCommittedSnapshot stamps run_id per commit); the self-heal's
		// run-specific gate keys on it.
		await db.collection("apps").doc(APP).update({ run_id: "b1" });

		// The surviving process finishes cleanly. Nothing re-claimed the app,
		// the row's content IS this run's commits, so the completion flips the
		// reaper's error back to complete — the dashboard and the celebration
		// agree — without re-charging (the reaper's refund stands) and without
		// touching the settled marker.
		await completeAndSettleRun(APP, "b1");
		const app = await readApp(APP);
		expect(app?.status).toBe("complete");
		expect(app?.error_type).toBeNull();
		expect(await consumed(OWNER)).toBe(0);
		await assertNoStrand(APP);
	});

	it("a reaped-then-RE-CLAIMED build's stale completion still no-ops (the taker is untouched)", async () => {
		const { claimRun, completeAndSettleRun, reapStaleGenerating } =
			await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await seedCredits(OWNER);
		await seedCredits(MEMBER);
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		await db
			.collection("apps")
			.doc(APP)
			.update({ updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP);
		// A second run re-claims the freed app and books its own marker.
		await claimRun(APP, "build", "b2", MEMBER);
		await reserveCredits(MEMBER, CREDITS_PER_BUILD, APP, "b2");

		// The ghost's completion must not flip the taker's live run.
		await completeAndSettleRun(APP, "b1");
		const app = await readApp(APP);
		expect(app?.status).toBe("generating");
		expect(runLeaseState(app as Partial<AppDoc>).mine("b2")).toBe(true);
		expect(await consumed(MEMBER)).toBe(CREDITS_PER_BUILD);
	});

	it("a zombie's completion never flips ANOTHER reaped run's error row (run_id gate)", async () => {
		const { claimRun, completeAndSettleRun, reapStaleGenerating } =
			await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await seedCredits(OWNER);
		await seedCredits(MEMBER);
		// R1 is falsely reaped; R2 re-claims, commits last (run_id = b2), and is
		// then hard-killed + reaped — the marker is runId-cleared AGAIN, so the
		// reaper signature alone cannot tell whose reap this is.
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		await db
			.collection("apps")
			.doc(APP)
			.update({ updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP);
		await claimRun(APP, "build", "b2", MEMBER);
		await reserveCredits(MEMBER, CREDITS_PER_BUILD, APP, "b2");
		await db
			.collection("apps")
			.doc(APP)
			.update({
				run_id: "b2",
				updated_at: new Date(Date.now() - 60 * 60_000),
			});
		await reapStaleGenerating(APP);
		expect((await readApp(APP))?.status).toBe("error");

		// Zombie R1 finishes cleanly — but the row's content is R2's (run_id b2),
		// so the self-heal must NOT flip R2's failure to complete.
		await completeAndSettleRun(APP, "b1");
		const app = await readApp(APP);
		expect(app?.status).toBe("error");
	});

	it("refreshBuildLiveness re-arms updated_at only for the OWNING live build", async () => {
		const { claimRun, refreshBuildLiveness } = await import("../apps");
		const { reserveCredits } = await import("../credits");
		await seedApp(APP, { status: "complete" });
		await seedCredits(OWNER);
		await claimRun(APP, "build", "b1", OWNER);
		await reserveCredits(OWNER, CREDITS_PER_BUILD, APP, "b1");
		// Age the clock, then beat as the owner — the clock re-arms.
		const aged = new Date(Date.now() - 9 * 60_000);
		await db.collection("apps").doc(APP).update({ updated_at: aged });
		await refreshBuildLiveness(APP, "b1");
		const afterOwned = await readApp(APP);
		const ownedMs = (afterOwned?.updated_at as Timestamp).toDate().getTime();
		expect(ownedMs).toBeGreaterThan(aged.getTime());
		// A NON-owning runId's beat leaves the clock untouched.
		await db.collection("apps").doc(APP).update({ updated_at: aged });
		await refreshBuildLiveness(APP, "ghost");
		const afterGhost = await readApp(APP);
		expect((afterGhost?.updated_at as Timestamp).toDate().getTime()).toBe(
			aged.getTime(),
		);
	});
});
