/**
 * `softDeleteApp` unit tests.
 *
 * Locks the Firestore contract of the persistence-layer helper that
 * `delete_app` sits on top of:
 *
 *   - The write targets the correct document and sets the three
 *     soft-delete fields (`status`, `deleted_at`, `recoverable_until`).
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

/* Hoisted spy — `vi.hoisted` lifts the spy reference so the `vi.mock`
 * factory can capture it at hoist time. The factory returns an object
 * whose `docs.app` runs through to the same spy for every appId — we
 * inspect `appMock.mock.calls` to confirm the targeted id. */
const { updateMock, appMock } = vi.hoisted(() => {
	const update = vi.fn();
	const app = vi.fn((_appId: string) => ({ update }));
	return { updateMock: update, appMock: app };
});

vi.mock("../firestore", () => ({
	/* `docs.app(appId)` returns a stub carrying only `update` — the
	 * helper under test never touches `.get`, `.set`, or `.delete`, so
	 * leaving them off catches any future drift where a caller adds an
	 * unexpected call. */
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
		appMock.mockClear();
	});

	it("writes the three soft-delete fields via update() and returns the recovery deadline", async () => {
		updateMock.mockResolvedValueOnce(undefined);

		const { softDeleteApp } = await import("../apps");
		const recoverableUntil = await softDeleteApp("app-1");

		/* Targeting: the `docs.app` accessor is invoked with the exact
		 * appId — a regression that rebuilds the ref under a different
		 * id would silently write to the wrong document. */
		expect(appMock).toHaveBeenCalledWith("app-1");

		/* Single update(), payload shape + types pinned. */
		expect(updateMock).toHaveBeenCalledTimes(1);
		const [patch] = updateMock.mock.calls[0] ?? [];
		expect(patch).toMatchObject({
			status: "deleted",
		});
		expect(typeof (patch as { deleted_at: unknown }).deleted_at).toBe("string");
		expect(
			typeof (patch as { recoverable_until: unknown }).recoverable_until,
		).toBe("string");

		/* The returned value is the same ISO string written into
		 * `recoverable_until` — callers surface it to users as the
		 * recovery deadline. */
		expect(recoverableUntil).toBe(
			(patch as { recoverable_until: string }).recoverable_until,
		);

		/* Retention window: `recoverable_until` - `deleted_at` must be
		 * ~30 days, to within ~1s of scheduler drift. */
		const delta =
			new Date(recoverableUntil).getTime() -
			new Date((patch as { deleted_at: string }).deleted_at).getTime();
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
});
