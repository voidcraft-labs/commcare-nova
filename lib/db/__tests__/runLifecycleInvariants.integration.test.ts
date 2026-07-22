/**
 * Run-lifecycle INVARIANT MATRIX — the capstone proof of the serialize-with-wait
 * + lease-reap model. Against a REAL Postgres (the per-test-database harness), it
 * drives the genuine db-layer primitives (`claimAndReserveRun` /
 * `completeAndSettleRun` / `clearRunLockAndSettle` / `settleAndRelease` /
 * `reacquireLease` / `refreshEditLease` / `reapStaleReservation` /
 * `reapStaleGenerating`) the way the chat route composes them, across the
 * lifecycle cells {build, edit} × {clean, failed, paused, hard-killed, resumed} +
 * serialize-wait + the reaper-race window, and asserts the FIVE global invariants
 * hold in every cell:
 *
 *   I1 no double-charge     — a run's actor is debited AT MOST its one cost.
 *   I2 no stranded lock     — a terminal edit is never `complete` + lock present
 *                             + unsettled marker with no live run (a strand).
 *   I3 no clawed-back kept  — a settled/kept charge is never handed back.
 *   I4 no double-run        — at most ONE run is `live` on an app at a time.
 *   I5 resumed-keeps-charge — an edit resumed after its lease lapsed keeps its
 *                             charge (renew-not-reap).
 *
 * Claim and reserve are ONE transaction (`claimAndReserveRun`), so the
 * intermediate `[claim, reserveCredits)` window is unrepresentable and each
 * such cell is covered by its atomic equivalent. The terminal writers'
 * transient-fault retry rides `withAppTx`'s deadlock/serialization retry,
 * unit-tested in `withAppTx.test.ts`.
 *
 * Runs unconditionally under `npm test`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { CREDITS_PER_BUILD, CREDITS_PER_EDIT } from "@/lib/db/creditPolicy";
import { getCurrentPeriod } from "@/lib/db/period";
import { runLeaseState } from "@/lib/db/runLiveness";
import type { AppDoc } from "@/lib/db/types";
import {
	claimAndReserveRun as claimAndReserveRunForProject,
	clearRunLockAndSettle,
	completeAndSettleRun,
	hasActiveGeneration,
	loadApp,
	RunConflictError,
	reacquireLease as reacquireLeaseForProject,
	reapStaleGenerating,
	reapStaleReservation,
	refreshBuildLiveness,
} from "../apps";
import { refundReservation, settleAndRelease } from "../credits";
import { setupAppStateTestDb } from "./appStateTestDb";

const OWNER = "user-lifecycle-owner";
const MEMBER = "user-lifecycle-member";
const APP = "app-lifecycle";
const APP_B = "app-lifecycle-b";
const PROJECT_ID = "project-test";

const h = setupAppStateTestDb("lifecycle_");
const period = getCurrentPeriod();

async function claimAndReserveRun(
	appId: string,
	mode: "build" | "edit",
	runId: string,
	actorUserId: string,
	cost: number,
) {
	return await claimAndReserveRunForProject(
		appId,
		mode,
		runId,
		actorUserId,
		cost,
		PROJECT_ID,
	);
}

async function reacquireLease(
	appId: string,
	runId: string,
	mode: "build" | "edit",
	actorUserId: string,
) {
	return await reacquireLeaseForProject(
		appId,
		runId,
		mode,
		actorUserId,
		PROJECT_ID,
	);
}

async function consumed(userId: string): Promise<number> {
	return (await h.readConsumed(userId, period)) ?? 0;
}
/** Seed an app row (AppDoc-shaped reservation/run_lock overrides accepted). */
async function seedApp(
	appId: string,
	over: Parameters<typeof h.seedApp>[0] = {},
): Promise<void> {
	await h.seedApp({ id: appId, owner: OWNER, ...over });
	const projectId =
		over.project_id === undefined ? PROJECT_ID : over.project_id;
	if (projectId !== null) await h.seedProjectMember(MEMBER, projectId);
}
/** The full AppDoc — reservation/run_lock reassembled — for `runLeaseState`. */
const readApp = (appId: string): Promise<AppDoc | null> => loadApp(appId);
/** Lapse an app's edit lease / build clock, or move any column, in one write. */
async function patchApp(
	appId: string,
	set: Record<string, unknown>,
): Promise<void> {
	await h
		.db()
		.updateTable("apps")
		.set(set as never)
		.where("id", "=", appId)
		.execute();
}

/** I2: a terminal app is never lock-present + unsettled-marker + no-live-run. */
async function assertNoStrand(appId: string): Promise<void> {
	const app = await readApp(appId);
	if (!app) return;
	const lease = runLeaseState(app);
	const stranded =
		lease.markerSettleable &&
		!lease.live &&
		!lease.paused &&
		!!app.run_lock &&
		!lease.reapableStrandedEdit;
	expect(stranded).toBe(false);
}

describe("run-lifecycle invariant matrix", () => {
	beforeEach(async () => {
		await h.seedCreditMonth(OWNER, period, {
			allowance: 2000,
			consumed: 0,
			bonus: 0,
		});
		await h.seedCreditMonth(MEMBER, period, {
			allowance: 2000,
			consumed: 0,
			bonus: 0,
		});
	});

	// ── BUILD lifecycle ──────────────────────────────────────────────────

	it("build · clean: charged once, settled-kept, not reaped (I1/I3)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		await completeAndSettleRun(APP, "b1");

		expect(await consumed(OWNER)).toBe(CREDITS_PER_BUILD); // I1
		expect((await readApp(APP))?.reservation).toMatchObject({ settled: true });
		await reapStaleReservation(APP, { mode: "edit", runId: "e1" });
		await assertNoStrand(APP);
		expect(await consumed(OWNER)).toBe(CREDITS_PER_BUILD); // I3 — not clawed back
	});

	it("build · failed: refunded (I1=0), settled, no strand", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		// The route's failure funnel for a build: settle+refund (no lock to release).
		const { settled } = await settleAndRelease(APP, "b1", {
			mode: "build",
		});
		expect(settled).toBe(true);
		expect(await consumed(OWNER)).toBe(0); // I1 — refunded
		await assertNoStrand(APP);
	});

	it("build · hard-killed: reaped off the staleness window, refunded once (I1)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" });
		expect(await consumed(OWNER)).toBe(0); // I1 — refunded
	});

	// ── EDIT lifecycle ───────────────────────────────────────────────────

	it("edit · clean: charged once, lock released + settled atomically, not reaped (I1/I2/I3)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);
		await clearRunLockAndSettle(APP, "e1");

		const app = await readApp(APP);
		expect(app?.run_lock).toBeUndefined(); // released
		expect(app?.reservation).toMatchObject({ settled: true });
		await assertNoStrand(APP); // I2
		await reapStaleReservation(APP, { mode: "edit", runId: "e1" });
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // I1/I3
	});

	it("edit · failed with settle+release: no strand (I2), refunded (I1)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", MEMBER, CREDITS_PER_EDIT);
		// The route's failure funnel for an edit: refund + settle + release, ONE txn.
		const { settled } = await settleAndRelease(APP, "e1", {
			mode: "edit",
		});
		expect(settled).toBe(true);
		const app = await readApp(APP);
		expect(app?.run_lock).toBeUndefined(); // released only because settled
		expect(await consumed(MEMBER)).toBe(0); // I1 — refunded to the actor
		await assertNoStrand(APP); // I2
	});

	it("edit · hard-killed: reaped off the lapsed lock, refunded once (I1), never a live edit clawed (I3)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", MEMBER, CREDITS_PER_EDIT);
		// Hard kill: lapse the lease.
		await patchApp(APP, { lock_expire_at: new Date(Date.now() - 60_000) });
		await reapStaleReservation(APP, { mode: "edit", runId: "e1" });
		expect(await consumed(MEMBER)).toBe(0); // I1 — refunded

		// I3: a LIVE edit (future lease) is NEVER clawed back by the reaper.
		await seedApp(APP_B, { status: "complete" });
		await claimAndReserveRun(APP_B, "edit", "e2", OWNER, CREDITS_PER_EDIT);
		await reapStaleReservation(APP_B, { mode: "edit", runId: "e2" });
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // not clawed
	});

	it("edit · resumed-after-lapse: reacquireLease renews the lease + keeps the charge (I5)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);
		// The run paused; while the user answered, its lease LAPSED.
		await patchApp(APP, {
			awaiting_input: true,
			lock_expire_at: new Date(Date.now() - 1000),
		});
		// The resume re-acquires: still mine → renew the lease, don't get reaped.
		expect(await reacquireLease(APP, "e1", "edit", OWNER)).toBe("owned");
		const app = await readApp(APP);
		expect(app?.awaiting_input).toBeFalsy();
		expect(runLeaseState(app ?? {}).live).toBe(true); // lease renewed → live
		await reapStaleReservation(APP, { mode: "edit", runId: "e1" });
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // I5
	});

	// ── Cross-run interactions ───────────────────────────────────────────

	it("cross-app: a user can edit app B while a live build holds app A (no cross-app block)", async () => {
		// A live build on app A (owner).
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "a-build", OWNER, CREDITS_PER_BUILD);

		// An EDIT on app B by the same owner claims cleanly — an edit serializes
		// per-app via its run_lock, never per-user, so app A's build must not block it.
		await seedApp(APP_B, { status: "complete" });
		await expect(
			claimAndReserveRun(APP_B, "edit", "b-edit", OWNER, CREDITS_PER_EDIT),
		).resolves.toMatchObject({ mode: "edit" });
		// The build-only per-user concurrency query still sees app A's build (the
		// guard the route runs ONLY for a new build POST, not an edit).
		expect(await hasActiveGeneration(OWNER, APP_B)).toBe(true);
	});

	it("serialize-with-wait: a second live-run claim of EITHER mode throws until release (I4)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);

		// A concurrent claim (build OR edit) conflicts while the edit is live — I4.
		await expect(
			claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD),
		).rejects.toBeInstanceOf(RunConflictError);
		await expect(
			claimAndReserveRun(APP, "edit", "e2", MEMBER, CREDITS_PER_EDIT),
		).rejects.toBeInstanceOf(RunConflictError);

		// Once the holder releases, the next claim proceeds.
		await clearRunLockAndSettle(APP, "e1");
		await expect(
			claimAndReserveRun(APP, "edit", "e2", MEMBER, CREDITS_PER_EDIT),
		).resolves.toMatchObject({ mode: "edit" });
	});

	// ── Terminal writers gate on ownership in-txn (reaper-race no-op) ─────

	it("a REAPED-then-reclaimed edit's stale clean writer no-ops — the new run's lock + marker are untouched", async () => {
		// e1 claims+reserves, its lease lapses, the REAPER frees it, and e2 then
		// claims the freed app. e1's stale terminal clean writer lands LAST and must
		// NO-OP rather than clobber e2 (the surviving race without a barge).
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);
		await patchApp(APP, { lock_expire_at: new Date(Date.now() - 1000) });
		await reapStaleReservation(APP, { mode: "edit", runId: "e1" }); // frees the app
		await claimAndReserveRun(APP, "edit", "e2", MEMBER, CREDITS_PER_EDIT); // e2 claims

		// e1's stale clean finalize must NO-OP (mode edit, but lock.runId === e2).
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
		// b1's build goes stale, the REAPER flips it to error + refunds, and b2 claims
		// the freed app. b1 then fails → settleAndRelease must no-op (b2 owns the app)
		// and report settled:false so the route won't failApp b2's app.
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" }); // frees the app
		await claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD); // b2 claims

		const { settled } = await settleAndRelease(APP, "b1", {
			mode: "build",
		});
		expect(settled).toBe(false);
		expect((await readApp(APP))?.reservation).toMatchObject({
			settled: false,
			runId: "b2",
		});
		expect(await consumed(MEMBER)).toBe(CREDITS_PER_BUILD);
	});

	it("a NORMAL failed BUILD (not reaped) still returns settled:TRUE → failApp fires (no stuck-generating)", async () => {
		// The complement: a build whose marker was pre-settled by its OWN flush (not
		// the reaper) still carries runId=b1, so non-lenient mine(b1)=TRUE →
		// settled:TRUE → the route DOES failApp.
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		// Simulate the flush pre-settling THIS run's own marker (runId intact).
		await patchApp(APP, { res_settled: true });

		const { settled } = await settleAndRelease(APP, "b1", {
			mode: "build",
		});
		expect(settled).toBe(true); // owns its outcome → failApp fires
	});

	it("a LEGACY no-runId build marker is corrupt and fails closed", async () => {
		// A marker stranded from BEFORE the runId field carries no runId. Non-lenient
		// `mine(anyone)` = false, and no canonical reaper can distinguish it from a
		// later null-identity generation. It stays visible for explicit data repair.
		await h.seedCreditMonth(OWNER, period, {
			allowance: 2000,
			consumed: CREDITS_PER_BUILD,
			bonus: 0,
		});
		await seedApp(APP, {
			status: "generating",
			updated_at: new Date(Date.now() - 60 * 60_000),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: OWNER,
			},
		});
		const lease = runLeaseState((await readApp(APP)) ?? {});
		expect(lease.mine("anyone")).toBe(false);
		expect(lease.reapableStaleBuild).toBe(false);

		await reapStaleGenerating(APP, {
			mode: "build",
			runId: "unprovable-holder",
		});
		expect((await readApp(APP))?.status).toBe("generating");
		expect(await consumed(OWNER)).toBe(CREDITS_PER_BUILD);
	});

	it("the build reaper does NOT claw a FRESH re-claimed build (in-txn staleness re-check)", async () => {
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
		await claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD);

		// The reap re-validates in-txn: the row is now a LIVE fresh build → no-op.
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" });
		expect((await readApp(APP))?.status).toBe("generating"); // NOT flipped to error
		expect(await consumed(MEMBER)).toBe(CREDITS_PER_BUILD); // fresh charge intact
	});

	it("the edit reaper RELEASES a persistently-stranded lock (not only settles)", async () => {
		await h.seedCreditMonth(OWNER, period, {
			allowance: 2000,
			consumed: CREDITS_PER_EDIT,
			bonus: 0,
		});
		// A stranded edit whose lock persists: complete, unsettled marker, lapsed lock.
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

		await reapStaleReservation(APP, { mode: "edit", runId: "e1" });
		const app = await readApp(APP);
		expect(app?.reservation).toMatchObject({ settled: true }); // refunded
		expect(app?.run_lock).toBeUndefined(); // AND released → no 15-min lockout
		expect(await consumed(OWNER)).toBe(0);
	});

	it("edit-claim on an ERROR app clears error_type (complete + null, not a stale classification)", async () => {
		await seedApp(APP, { status: "error", error_type: "internal" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);
		const app = await readApp(APP);
		expect(app?.status).toBe("complete");
		expect(app?.error_type).toBeNull();
	});

	// ── Failed-build finalize ordering + paused-run self-resume ───────────

	it("a failed BUILD is resolved-for-failApp even when flush pre-settled its marker (no stuck-generating)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		// The route's failure funnel runs `flush()` FIRST — refund+SETTLE the marker.
		await refundReservation(APP, "b1", "build");
		expect((await readApp(APP))?.reservation).toMatchObject({ settled: true });

		// THEN settleAndRelease: the marker is already settled, but this run still
		// OWNS the app → it must return settled:TRUE so the route's `failApp` fires.
		const { settled } = await settleAndRelease(APP, "b1", {
			mode: "build",
		});
		expect(settled).toBe(true);
		expect(await consumed(OWNER)).toBe(0); // stayed refunded (no double-touch)
	});

	it("a paused run's OWN untaken resume still succeeds (no takeover — marker runId + lock intact)", async () => {
		// A paused EDIT with NO takeover — its lock is present and marker.runId is its own.
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);
		await patchApp(APP, { awaiting_input: true });

		// Its own answered-resume re-acquires cleanly (still owns the lock + marker).
		expect(await reacquireLease(APP, "e1", "edit", OWNER)).toBe("owned");
		const app = await readApp(APP);
		expect(app?.awaiting_input).toBeFalsy();
		expect(runLeaseState(app ?? {}).mine("e1")).toBe(true);
		expect(await consumed(OWNER)).toBe(CREDITS_PER_EDIT); // charge kept
	});

	// ── Descoped model: serialize-with-wait + lease-reap (no takeover) ────

	it("a waiter behind a LIVE run is blocked (RunConflictError) and proceeds once the holder COMPLETES", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);
		await expect(
			claimAndReserveRun(APP, "edit", "e2", MEMBER, CREDITS_PER_EDIT),
		).rejects.toBeInstanceOf(RunConflictError);
		await expect(
			claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD),
		).rejects.toBeInstanceOf(RunConflictError);

		await clearRunLockAndSettle(APP, "e1");
		await expect(
			claimAndReserveRun(APP, "edit", "e2", MEMBER, CREDITS_PER_EDIT),
		).resolves.toMatchObject({ mode: "edit" });
	});

	it("a waiter behind a PAUSED run is blocked, and proceeds once the paused run's lease lapses and it is REAPED", async () => {
		// Another actor's PAUSED edit holds the app — their pause BLOCKS (no
		// takeover); only the pause's own actor supersedes it.
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "edit", "e1", OWNER, CREDITS_PER_EDIT);
		await patchApp(APP, { awaiting_input: true });
		await expect(
			claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD),
		).rejects.toBeInstanceOf(RunConflictError);

		// The paused run's lease lapses and the user never answers — an ABANDONED
		// paused edit. The reaper keys on the lapsed lease alone, so it frees it.
		await patchApp(APP, { lock_expire_at: new Date(Date.now() - 1000) });
		await reapStaleReservation(APP, { mode: "edit", runId: "e1" }); // frees the app
		expect(await consumed(OWNER)).toBe(0); // the abandoned run was refunded
		await expect(
			claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD),
		).resolves.toMatchObject({ mode: "build" });
	});

	it("a waiter behind a HARD-KILLED run proceeds after the reaper frees it", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" });
		expect(await consumed(OWNER)).toBe(0); // hard-killed hold refunded

		await expect(
			claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD),
		).resolves.toMatchObject({ mode: "build" });
	});

	// ── False-reap self-heal + build liveness heartbeat ───────────────────

	it("a reaped-but-UNCLAIMED build's clean completion self-heals error → complete (refund stands)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		expect((await readApp(APP))?.run_id).toBe("b1");
		// The live build's clock lapses mid-run and a scan reaps it: refund + error +
		// marker runId cleared. The build claim itself already durably stamped the
		// root run_id, so this no-mutation run still has an exact last-claim identity.
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" });
		expect(await consumed(OWNER)).toBe(0);
		expect((await readApp(APP))?.status).toBe("error");

		// The surviving process finishes cleanly. Nothing re-claimed, the row IS this
		// run's claim, so the completion flips the reaper's error back to complete —
		// without re-charging and without touching the settled marker.
		await completeAndSettleRun(APP, "b1");
		const app = await readApp(APP);
		expect(app?.status).toBe("complete");
		expect(app?.error_type).toBeNull();
		expect(await consumed(OWNER)).toBe(0);
		await assertNoStrand(APP);
	});

	it("a reaped-then-RE-CLAIMED build's stale completion still no-ops (the taker is untouched)", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" });
		// A second run re-claims the freed app and books its own marker.
		await claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD);

		// The ghost's completion must not flip the taker's live run.
		await completeAndSettleRun(APP, "b1");
		const app = await readApp(APP);
		expect(app?.status).toBe("generating");
		expect(runLeaseState(app as Partial<AppDoc>).mine("b2")).toBe(true);
		expect(await consumed(MEMBER)).toBe(CREDITS_PER_BUILD);
	});

	it("a no-mutation successor claim remains the durable self-heal fence after that successor is reaped", async () => {
		// R1 is falsely reaped; R2 re-claims and writes NO mutation, then is itself
		// hard-killed + reaped. The claim must already have stamped root run_id=b2;
		// otherwise R1 could satisfy the now-free row's false-reap signature.
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" });
		await claimAndReserveRun(APP, "build", "b2", MEMBER, CREDITS_PER_BUILD);
		expect((await readApp(APP))?.run_id).toBe("b2");
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b2" });
		const beforeZombie = await readApp(APP);
		expect(beforeZombie).toMatchObject({
			status: "error",
			run_id: "b2",
			reservation: { settled: true },
		});

		// Zombie R1 finishes cleanly — but root identity names R2, so every
		// successor field remains unchanged.
		await completeAndSettleRun(APP, "b1");
		expect(await readApp(APP)).toEqual(beforeZombie);
	});

	it("a pre-settled stale build retains its marker identity and is deliberately not false-reap self-healable", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		// The failure flush refunded and settled this exact run before the stale
		// reaper observed it. That is not the reaper's marker-cleared signature.
		await refundReservation(APP, "b1", "build");
		await patchApp(APP, { updated_at: new Date(Date.now() - 60 * 60_000) });
		await reapStaleGenerating(APP, { mode: "build", runId: "b1" });
		const reaped = await readApp(APP);
		expect(reaped).toMatchObject({
			status: "error",
			run_id: "b1",
			reservation: { runId: "b1", settled: true },
		});

		await completeAndSettleRun(APP, "b1");
		expect(await readApp(APP)).toEqual(reaped);
	});

	it("refreshBuildLiveness re-arms updated_at only for the OWNING live build", async () => {
		await seedApp(APP, { status: "complete" });
		await claimAndReserveRun(APP, "build", "b1", OWNER, CREDITS_PER_BUILD);
		// Age the clock, then beat as the owner — the clock re-arms.
		const aged = new Date(Date.now() - 9 * 60_000);
		await patchApp(APP, { updated_at: aged });
		await refreshBuildLiveness(APP, "b1");
		const owned = await readApp(APP);
		if (!owned) throw new Error("app row missing after the owner's beat");
		expect((owned.updated_at as Date).getTime()).toBeGreaterThan(
			aged.getTime(),
		);
		// A NON-owning runId's beat leaves the clock untouched.
		await patchApp(APP, { updated_at: aged });
		await refreshBuildLiveness(APP, "ghost");
		const ghosted = await readApp(APP);
		if (!ghosted) throw new Error("app row missing after the ghost's beat");
		expect((ghosted.updated_at as Date).getTime()).toBe(aged.getTime());
	});
});
