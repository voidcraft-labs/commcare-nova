/**
 * `restoreApp` unit tests.
 *
 * Locks the inverse of the soft-delete contract: `restoreApp` clears
 * exactly the two soft-delete fields (`deleted_at`, `recoverable_until`)
 * as a pair and never touches lifecycle status. A deleted `error` app
 * stays an `error` app after restore; a deleted `complete` app stays
 * `complete`. Soft-delete is the existence axis, lifecycle status is
 * its own — keeping them independent removes the round-trip-loss
 * problem the older status-flip approach had.
 *
 * Mock shape mirrors `softDeleteApp.test.ts` so a regression that
 * breaks one helper's contract surfaces in both files.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMock, setMock, appMock } = vi.hoisted(() => {
	const update = vi.fn();
	const set = vi.fn();
	const app = vi.fn((_appId: string) => ({ update, set }));
	return { updateMock: update, setMock: set, appMock: app };
});

vi.mock("../firestore", () => ({
	docs: { app: appMock },
	collections: { apps: vi.fn() },
	getDb: vi.fn(),
}));

describe("restoreApp", () => {
	beforeEach(() => {
		updateMock.mockReset();
		setMock.mockReset();
		appMock.mockClear();
	});

	it("clears deleted_at and recoverable_until via update() — and nothing else", async () => {
		updateMock.mockResolvedValueOnce(undefined);

		const { restoreApp } = await import("../apps");
		await restoreApp("app-1");

		/* Targeting: the `docs.app` accessor is invoked with the exact
		 * appId. */
		expect(appMock).toHaveBeenCalledWith("app-1");

		/* Single update(), payload shape pinned. The pair-invariant
		 * matters: a row should never be left in a half-restored state
		 * where one field is null and the other is set. */
		expect(updateMock).toHaveBeenCalledTimes(1);
		const [patch] = updateMock.mock.calls[0] ?? [];
		expect(patch).toEqual({
			deleted_at: null,
			recoverable_until: null,
		});

		/* Lifecycle status is intentionally untouched — restore is the
		 * inverse of a marker, not of a lifecycle transition. A
		 * regression that brings back the status-flip code would add
		 * `status: "complete"` to the patch. */
		expect(patch as Record<string, unknown>).not.toHaveProperty("status");
	});

	it("propagates NOT_FOUND rejections from update() on a missing doc", async () => {
		/* Symmetric with `softDeleteApp`: `update()` on a non-existent
		 * row rejects with `5 NOT_FOUND` and the helper must let that
		 * bubble — silently materializing a fresh row would paper over
		 * a real corruption. */
		updateMock.mockRejectedValueOnce(
			new Error("5 NOT_FOUND: No document to update"),
		);

		const { restoreApp } = await import("../apps");
		await expect(restoreApp("missing")).rejects.toThrow(/NOT_FOUND/);
	});

	it("uses update(), not set() — same ghost-row guarantee as soft-delete", async () => {
		/* Symmetric with `softDeleteApp`: `set()` would materialize a
		 * row lacking `owner` / `blueprint` if `restoreApp` ever ran on
		 * a non-existent doc. The contract is `update()` only. */
		updateMock.mockResolvedValueOnce(undefined);

		const { restoreApp } = await import("../apps");
		await restoreApp("app-1");

		expect(updateMock).toHaveBeenCalledTimes(1);
		expect(setMock).not.toHaveBeenCalled();
	});
});
