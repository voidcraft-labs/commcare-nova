/**
 * `restoreApp` — the inverse of the soft-delete contract, against the real
 * per-test Postgres.
 *
 * Clears exactly the two soft-delete fields (`deleted_at`, `recoverable_until`)
 * as a PAIR and never touches lifecycle status: a deleted `error` app stays
 * `error` after restore. Soft-delete is the existence axis, status is its own. A
 * restore against a missing row THROWS (the `numUpdatedRows === 0` guard), so a
 * missing app surfaces as an error rather than a silent no-op.
 */

import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("restore_app_");
const APP = "app-1";

describe("restoreApp", () => {
	it("clears deleted_at and recoverable_until as a pair, leaving status untouched", async () => {
		await h.seedApp({
			id: APP,
			status: "error",
			error_type: "internal",
			deleted_at: new Date("2026-06-01T00:00:00Z"),
			recoverable_until: new Date("2026-07-01T00:00:00Z"),
		});
		const { restoreApp } = await import("../apps");

		await restoreApp(APP, "owner-test");

		const row = await h.readAppRow(APP);
		expect(row?.deleted_at).toBeNull();
		expect(row?.recoverable_until).toBeNull();
		// Restore is the inverse of a MARKER, not a lifecycle transition.
		expect(row?.status).toBe("error");
		expect(row?.error_type).toBe("internal");
	});

	it("throws on a missing row (no silent ghost create)", async () => {
		const { restoreApp } = await import("../apps");
		await expect(restoreApp("does-not-exist", "owner-test")).rejects.toThrow();
	});
});
