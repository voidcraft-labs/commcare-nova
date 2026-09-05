/**
 * `softDeleteApp` — the persistence helper `delete_app` (MCP) and the home-page
 * Server Action sit on, against the real per-test Postgres.
 *
 * Locks the contract:
 *   - The write sets exactly `deleted_at` + `recoverable_until`; lifecycle
 *     `status` is intentionally untouched (`deleted_at != null` is the sole
 *     soft-delete marker; soft-delete and status are orthogonal axes).
 *   - It returns the ISO `recoverable_until`, and the gap to `deleted_at` is the
 *     30-day retention window.
 *   - A write against a missing row THROWS (the Kysely `numUpdatedRows === 0`
 *     guard) so callers surface a missing-row error rather than a silent no-op —
 *     an UPDATE against an absent id touches zero rows and creates nothing, so
 *     the guard turns that into an explicit error.
 */

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("soft_delete_");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const APP = "app-1";

describe("softDeleteApp", () => {
	it("writes deleted_at + recoverable_until and returns the recovery deadline, status untouched", async () => {
		await h.seedApp({ id: APP, status: "complete" });
		const { softDeleteApp } = await import("../apps");

		const recoverableUntil = await softDeleteApp(APP, "owner-test");

		const row = await h.readAppRow(APP);
		if (!row) throw new Error("soft-deleted app row missing");
		expect(row.deleted_at).toBeInstanceOf(Date);
		expect(row.recoverable_until).toBeInstanceOf(Date);
		// Soft-delete is the existence axis — status stays exactly as it was.
		expect(row.status).toBe("complete");
		// The returned value is the same ISO string written to `recoverable_until`.
		expect(recoverableUntil).toBe(
			(row.recoverable_until as Date).toISOString(),
		);
		// The retention window: recoverable_until − deleted_at ≈ 30 days.
		const delta =
			(row.recoverable_until as Date).getTime() -
			(row.deleted_at as Date).getTime();
		expect(delta).toBeCloseTo(RETENTION_MS, -3);
	});

	it("throws on a missing row so callers can surface a missing-row error", async () => {
		const { softDeleteApp } = await import("../apps");
		await expect(
			softDeleteApp("does-not-exist", "owner-test"),
		).rejects.toThrow();
	});
});
