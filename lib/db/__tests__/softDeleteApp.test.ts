/**
 * `softDeleteApp` unit tests.
 *
 * Locks the Firestore contract of the persistence-layer helper that
 * `delete_app` (MCP tool) and the home-page Server Action sit on top
 * of:
 *
 *   - The write targets the correct document and sets exactly two
 *     fields: `deleted_at` and `recoverable_until`. Lifecycle status
 *     is intentionally untouched — `deleted_at != null` is the sole
 *     soft-delete marker; soft-delete and lifecycle status are
 *     orthogonal axes.
 *   - `update()` is used, not `set()` — so a missing-row write rejects
 *     with NOT_FOUND instead of materializing a ghost row that lacks
 *     the `owner` / `blueprint` fields the Zod converter requires.
 *   - `deleted_at` and `recoverable_until` are both ISO-8601 strings
 *     and the gap between them matches the 30-day retention window.
 *
 * The Firestore module is mocked at the file boundary — only the
 * `docs.app(appId).update(...)` call path matters for this helper, so
 * we stub `collections` and `getDb` alongside to keep the module-level
 * import graph happy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* Hoisted spies — `vi.hoisted` lifts the spy references so the
 * `vi.mock` factory can capture them at hoist time. The factory returns
 * an object whose `docs.app` runs through to the same `update` + `set`
 * spies for every appId — we inspect `appMock.mock.calls` to confirm
 * the targeted id AND assert `setMock` stays untouched (the contract is
 * "soft-delete MUST use update()" — `set()` would materialize a ghost
 * row lacking the `owner`/`blueprint` the converter requires). */
const { updateMock, setMock, appMock } = vi.hoisted(() => {
	const update = vi.fn();
	const set = vi.fn();
	const app = vi.fn((_appId: string) => ({ update, set }));
	return { updateMock: update, setMock: set, appMock: app };
});

vi.mock("../firestore", () => ({
	/* `docs.app(appId)` returns a stub carrying `update` and `set`
	 * spies. `set` is present only so the test can prove the helper
	 * DOESN'T call it — leaving it off would mean a future regression
	 * that switched to `set()` would throw "is not a function" at
	 * runtime rather than producing a clean assertion failure. */
	docs: { app: appMock },
	/* `collections` and `getDb` aren't touched by `softDeleteApp`, but
	 * `apps.ts` imports both at module scope; providing empty stand-ins
	 * lets the module resolve under the mock. */
	collections: { apps: vi.fn() },
	getDb: vi.fn(),
}));

/* 30-day retention window in ms — mirrors the helper's constant. The
 * assertion below allows ~1s of drift between the helper's
 * `new Date()` and the test's re-computation, so the tolerance is
 * generous enough to survive any scheduler noise. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

describe("softDeleteApp", () => {
	beforeEach(() => {
		updateMock.mockReset();
		setMock.mockReset();
		appMock.mockClear();
	});

	it("writes deleted_at + recoverable_until via update() and returns the recovery deadline", async () => {
		updateMock.mockResolvedValueOnce(undefined);

		const { softDeleteApp } = await import("../apps");
		const recoverableUntil = await softDeleteApp("app-1");

		/* Targeting: the `docs.app` accessor is invoked with the exact
		 * appId — a regression that rebuilds the ref under a different
		 * id would silently write to the wrong document. */
		expect(appMock).toHaveBeenCalledWith("app-1");

		/* Single update(), payload shape pinned. */
		expect(updateMock).toHaveBeenCalledTimes(1);
		const [patch] = updateMock.mock.calls[0] ?? [];
		const patchObj = patch as Record<string, unknown>;

		/* The two fields the soft-delete contract sets. */
		expect(typeof patchObj.deleted_at).toBe("string");
		expect(typeof patchObj.recoverable_until).toBe("string");

		/* Lifecycle status is intentionally untouched — soft-delete is
		 * the existence axis, status is the lifecycle axis, and they
		 * are independent. A regression that brings back the old
		 * status-flip behavior would set `status: "deleted"` here. */
		expect(patchObj).not.toHaveProperty("status");

		/* The returned value is the same ISO string written into
		 * `recoverable_until` — callers surface it to users as the
		 * recovery deadline. */
		expect(recoverableUntil).toBe(patchObj.recoverable_until);

		/* Retention window: `recoverable_until` - `deleted_at` must be
		 * ~30 days, to within ~1s of scheduler drift. */
		const delta =
			new Date(recoverableUntil).getTime() -
			new Date(patchObj.deleted_at as string).getTime();
		expect(delta).toBeCloseTo(RETENTION_MS, -3);
	});

	it("propagates NOT_FOUND rejections so callers can surface a missing-row error", async () => {
		/* Firestore's Admin SDK raises a `5 NOT_FOUND` error when
		 * `update()` targets a non-existent document. The helper must
		 * let that reject bubble — a silent ghost-row create would let
		 * later reads through the full schema converter throw on the
		 * missing `owner` / `blueprint` fields. */
		const firestoreNotFound = new Error("5 NOT_FOUND: No document to update");
		updateMock.mockRejectedValueOnce(firestoreNotFound);

		const { softDeleteApp } = await import("../apps");
		await expect(softDeleteApp("missing")).rejects.toThrow(/NOT_FOUND/);
	});

	it("calls update(), not set() — guarantees NOT_FOUND on missing rows", async () => {
		/* The load-bearing semantic difference: `set()` materializes a
		 * new document when one doesn't exist; `update()` rejects with
		 * NOT_FOUND. A ghost row with only the soft-delete fields
		 * would be invalid at every read — the converter requires
		 * `owner` + `blueprint`. Pin the contract explicitly so a
		 * future contributor "fixing" this by switching to `set()`
		 * (which would paper over transient read lag) trips a test
		 * rather than landing silently. */
		updateMock.mockResolvedValueOnce(undefined);

		const { softDeleteApp } = await import("../apps");
		await softDeleteApp("app-1");

		expect(updateMock).toHaveBeenCalledTimes(1);
		expect(setMock).not.toHaveBeenCalled();
	});
});
