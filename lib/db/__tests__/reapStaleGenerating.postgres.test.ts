// Database-owned pause and resume writes; wrapper behavior lives in appsWithoutDatabase.test.ts.
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("reap_stale_");
const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";

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
			run_holder_nonce: HOLDER_NONCE,
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
			setAwaitingInput(
				APP,
				RUN,
				HOLDER_NONCE,
				"build",
				false,
				"owner-test",
				"project-test",
			),
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
			run_holder_nonce: HOLDER_NONCE,
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
			setAwaitingInput(
				APP,
				RUN,
				HOLDER_NONCE,
				"build",
				true,
				"owner-test",
				"project-test",
			),
		).resolves.toBe("owned");

		const row = await h.readAppRow(APP);
		if (!row) throw new Error("seeded app row missing");
		expect(row.awaiting_input).toBe(true);
		// The clock is untouched — still the seeded stale timestamp.
		expect((row.updated_at as Date).getTime()).toBe(stale.getTime());
	});
});
