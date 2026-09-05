// Build reaper identity clearing and another actor's paused-build refusal.
// Credit-transfer variants live in claimRun.postgres.test.ts.

import { describe, expect, it } from "vitest";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("claimwindow_");
const PERIOD = getCurrentPeriod();
const APP = "app-1";
const PROJECT_ID = "project-test";
const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";

/** An `updated_at` past the build staleness window (a hard-killed build). */
const staleClock = () => new Date(Date.now() - 60 * 60_000);
/** A fresh `updated_at` — a build inside its staleness window (paused-alive). */
const freshClock = () => new Date();

describe("claim credit-transfer + build reaper runId-clear", () => {
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
			run_holder_nonce: HOLDER_NONCE,
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

		await reapStaleGenerating(APP, {
			mode: "build",
			runId: "run-dead",
			nonce: HOLDER_NONCE,
		});

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
			run_holder_nonce: HOLDER_NONCE,
			// A RECENTLY-paused build (fresh clock): paused-alive, not reapable.
			updated_at: freshClock(),
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "user-1",
				runId: "paused-run",
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
