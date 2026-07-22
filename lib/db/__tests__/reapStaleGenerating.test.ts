/**
 * `reapStaleGenerating` delegation + `setAwaitingInput` writes.
 *
 * The reaper delegates the whole reap — refund the stranded hold + flip
 * `generating → error` — to `refundStaleGeneration` (credits.ts), which does both
 * in ONE transaction with the staleness re-validated inside it (its in-txn
 * correctness lives in `claimRun.integration.test.ts`). `reapStaleGenerating`'s
 * remaining contract is thin: delegate, and SWALLOW a transient throw (leaving the
 * row untouched — refund + flip are one atomic commit, so a failure means neither
 * happened and the next scan retries). Here we mock `refundStaleGeneration` and
 * observe only that delegation.
 *
 * `setAwaitingInput` is exercised against the real per-test DB. It locks the
 * app row and re-checks the exact holder before writing: clearing the pause
 * re-arms `updated_at` (the resuming run needs a fresh staleness window), while
 * setting it must NOT bump the clock (the flag, not a fresh timestamp, is what
 * spared the paused row). Replacement/reaper ownership regressions live in
 * `runHolderWrites.integration.test.ts`.
 *
 * Claim + reserve are one atomic `claimAndReserveRun` with no prior-state
 * snapshot (every rejection is a rollback), so the build-claim scenarios — a
 * failed/complete build's window claim, the "never touches the marker"
 * liveness-only write, and the paused-blocks and live-blocks conflicts — are
 * covered against a real database in `claimRun.integration.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "./appStateTestDb";

const { refundStaleGenerationMock } = vi.hoisted(() => ({
	refundStaleGenerationMock: vi.fn(),
}));

// `reapStaleGenerating` (apps.ts) delegates to `refundStaleGeneration`; mock just
// that credits export. apps.ts's other credits imports are unused by the two
// functions under test here.
vi.mock("../credits", () => ({
	refundStaleGeneration: refundStaleGenerationMock,
}));

const h = setupAppStateTestDb("reap_stale_");

describe("reapStaleGenerating", () => {
	beforeEach(() => {
		refundStaleGenerationMock.mockReset();
	});

	it("delegates the reap (refund + flip, one atomic txn) to refundStaleGeneration", async () => {
		refundStaleGenerationMock.mockResolvedValue(undefined);
		const { reapStaleGenerating } = await import("../apps");

		await reapStaleGenerating("app-1", {
			mode: "build",
			runId: "run-1",
		});

		expect(refundStaleGenerationMock).toHaveBeenCalledWith("app-1", {
			mode: "build",
			runId: "run-1",
		});
	});

	it("SWALLOWS a transient throw — the row is untouched, so the next scan retries", async () => {
		refundStaleGenerationMock.mockRejectedValue(new Error("db down"));
		const { reapStaleGenerating } = await import("../apps");

		// A throw must not escape (fire-and-forget at the call sites).
		await expect(
			reapStaleGenerating("app-1", { mode: "build", runId: "run-1" }),
		).resolves.toBeUndefined();
	});
});

describe("setAwaitingInput", () => {
	const APP = "app-await";
	const RUN = "run-await";
	const PERIOD = "2026-07";

	it("clearing (resume) re-arms updated_at so the resuming run gets a fresh staleness window", async () => {
		// The flag — not the timestamp — is what spared the paused row, so clearing
		// it must re-arm the clock. Otherwise the resuming run is born stale and a
		// concurrent list scan could refund its still-live hold before its first
		// mutation advances `updated_at`.
		const stale = new Date(Date.now() - 20 * 60_000);
		await h.seedApp({
			id: APP,
			status: "generating",
			awaiting_input: true,
			updated_at: stale,
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "owner-test",
				runId: RUN,
			},
		});
		const { setAwaitingInput } = await import("../apps");

		await expect(
			setAwaitingInput(APP, RUN, "build", false, "owner-test", "project-test"),
		).resolves.toBe("owned");

		const row = await h.readAppRow(APP);
		if (!row) throw new Error("seeded app row missing");
		expect(row.awaiting_input).toBe(false);
		// updated_at re-armed to ~now (the frozen-during-pause clock restarts).
		expect(Date.now() - (row.updated_at as Date).getTime()).toBeLessThan(
			30_000,
		);
	});

	it("setting (pause) does NOT bump updated_at — the flag, not the clock, protects a pause", async () => {
		const stale = new Date(Date.now() - 20 * 60_000);
		await h.seedApp({
			id: APP,
			status: "generating",
			awaiting_input: false,
			updated_at: stale,
			reservation: {
				period: PERIOD,
				reserved: 100,
				settled: false,
				userId: "owner-test",
				runId: RUN,
			},
		});
		const { setAwaitingInput } = await import("../apps");

		await expect(
			setAwaitingInput(APP, RUN, "build", true, "owner-test", "project-test"),
		).resolves.toBe("owned");

		const row = await h.readAppRow(APP);
		if (!row) throw new Error("seeded app row missing");
		expect(row.awaiting_input).toBe(true);
		// The clock is untouched — still the seeded stale timestamp.
		expect((row.updated_at as Date).getTime()).toBe(stale.getTime());
	});
});
