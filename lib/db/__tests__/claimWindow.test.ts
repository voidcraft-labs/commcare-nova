/**
 * The claim's credit-transfer + the build reaper's runId-clear, against a REAL
 * Postgres (the per-test-database harness). Composes `reserveForNewBuild` /
 * `claimAndReserveRun` (apps.ts) with `refundStaleGeneration` via
 * `reapStaleGenerating` — sharing one database, so each reads what the prior wrote.
 *
 * The descoped + atomic model: claim and reserve are ONE transaction, so there is
 * no separate "claim that leaves the marker untouched" — the claim's
 * `debitAndBookReservation` refunds any leftover UNSETTLED hold and books the
 * fresh marker together. The invariants this pins that aren't the focus of the
 * lifecycle matrix:
 *
 *   - the leftover-refund targets the marker's CHARGED ACTOR (`res_user_id`), not
 *     `owner` (the two diverge once a Project co-member runs a shared app);
 *   - a hard-killed leftover nets out (refund + fresh debit → one cost, not two);
 *   - the build reaper CLEARS `res_run_id` so a reaped ghost reads unowned;
 *   - another actor's claim on a PAUSED app THROWS and touches nothing (their
 *     pause blocks; only the pause's own actor supersedes it).
 *
 * (A KEPT settled charge surviving a claim, and a failed run's full refund, are
 * covered by `claimRun.integration.test.ts`.)
 *
 * Runs unconditionally under `npm test`.
 */

import { describe, expect, it } from "vitest";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("claimwindow_");
const PERIOD = getCurrentPeriod();
const APP = "app-1";
const PROJECT_ID = "project-test";

/** An `updated_at` past the build staleness window (a hard-killed build). */
const staleClock = () => new Date(Date.now() - 60 * 60_000);
/** A fresh `updated_at` — a build inside its staleness window (paused-alive). */
const freshClock = () => new Date();

describe("claim credit-transfer + build reaper runId-clear", () => {
	it("reserveForNewBuild refunds a hard-killed leftover before booking the fresh charge (net one cost)", async () => {
		const { reserveForNewBuild } = await import("../apps");
		// A prior hard-killed run left an unsettled 100-credit hold on user-1's own
		// current month; the retry reserves before the reaper fired.
		await h.seedApp({
			id: APP,
			owner: "user-1",
			status: "complete",
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "user-1",
			},
		});
		await h.seedCreditMonth("user-1", PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});

		await reserveForNewBuild(APP, "user-1", 100, "run-2", PROJECT_ID);

		// Leftover 100 refunded, fresh 100 booked → net stays 100.
		expect(await h.readConsumed("user-1", PERIOD)).toBe(100);
		expect(await h.readReservation(APP)).toMatchObject({
			period: PERIOD,
			reserved: 100,
			settled: false,
			userId: "user-1",
			runId: "run-2",
		});
	});

	it("the leftover-refund targets the CHARGED ACTOR of the marker, not the owner (owner != actor)", async () => {
		const { reserveForNewBuild } = await import("../apps");
		// A Project co-member (NOT the owner) ran a build, was charged 100, then
		// hard-killed. The retry's leftover-refund must un-book the ACTOR's hold
		// (`res_user_id`), NOT `owner`.
		await h.seedApp({
			id: APP,
			owner: "owner-1",
			status: "complete",
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "member-2",
			},
		});
		await h.seedCreditMonth("owner-1", PERIOD, {
			allowance: 2000,
			consumed: 0,
			bonus: 0,
		});
		await h.seedCreditMonth("member-2", PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});

		// The owner books fresh; the leftover refunds to the dead member.
		await reserveForNewBuild(APP, "owner-1", 100, "run-2", PROJECT_ID);

		expect(await h.readConsumed("member-2", PERIOD)).toBe(0); // dead member's hold handed back
		expect(await h.readConsumed("owner-1", PERIOD)).toBe(100); // fresh on owner's ledger
	});

	it("the build reaper CLEARS the marker's runId (a reaped ghost reads unowned)", async () => {
		const { reapStaleGenerating } = await import("../apps");
		const { runLeaseState } = await import("../runLiveness");
		// A stale `generating` build with an UNSETTLED runId'd marker is reaped;
		// `refundStaleGeneration` refunds AND clears `res_run_id` so the reaped run's
		// own stale terminal writer can't later read the marker as `mine`.
		await h.seedApp({
			id: APP,
			owner: "user-1",
			status: "generating",
			updated_at: staleClock(),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "user-1",
				runId: "run-dead",
			},
		});
		await h.seedCreditMonth("user-1", PERIOD, {
			allowance: 2000,
			consumed: 100,
			bonus: 0,
		});

		await reapStaleGenerating(APP);

		const marker = await h.readReservation(APP);
		expect(marker).toMatchObject({
			settled: true,
			userId: "user-1",
			reserved: 100,
		});
		expect(marker?.runId).toBeUndefined(); // ← the reaper-race clear
		expect(await h.readConsumed("user-1", PERIOD)).toBe(0); // refunded
		// The runId-cleared marker is owned by NOBODY (non-lenient mine).
		const row = await h.readAppRow(APP);
		expect(
			runLeaseState({
				status: row?.status as "error",
				reservation: marker,
			}).mine("run-dead"),
		).toBe(false);
	});

	it("another actor's claim on a PAUSED app THROWS — their pause blocks (no takeover), touching nothing", async () => {
		const { claimAndReserveRun, RunConflictError } = await import("../apps");
		await h.seedApp({
			id: APP,
			owner: "user-1",
			status: "generating",
			awaiting_input: true,
			// A RECENTLY-paused build (fresh clock): paused-alive, not reapable.
			updated_at: freshClock(),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "user-1",
			},
		});
		await h.seedProjectMember("user-2", PROJECT_ID);

		await expect(
			claimAndReserveRun(APP, "build", "waiter", "user-2", 100, PROJECT_ID),
		).rejects.toBeInstanceOf(RunConflictError);
		// Nothing written — the paused run's marker is untouched.
		expect(await h.readReservation(APP)).toMatchObject({
			period: PERIOD,
			reserved: 100,
			settled: false,
			userId: "user-1",
		});
		expect((await h.readAppRow(APP))?.awaiting_input).toBe(true);
	});
});
