/**
 * `addReferencingApp` unit tests — the reverse-index WRITE the delete guard's
 * candidate set depends on.
 *
 * Locks three contracts:
 *   - An empty asset list writes NOTHING (the no-media common case is free).
 *   - Each unique asset id gets one `update({ referencingAppIds: arrayUnion })`
 *     — deduped, append-only.
 *   - Writes are INDEPENDENT (Promise.allSettled): one asset's update rejecting
 *     (a dangling ref → Firestore NOT_FOUND) is logged and SKIPPED, and the
 *     other valid edges still land. A single bad ref must not drop every edge —
 *     that's why this isn't one atomic batch.
 *
 * The Firestore module is mocked at the file boundary; `docs.mediaAsset(id)`
 * returns a stub whose `update` runs through an id-aware spy so a single id can
 * be made to reject. `FieldValue.arrayUnion` is the real sentinel.
 */

import { FieldValue } from "@google-cloud/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addReferencingApp } from "../mediaAssets";

const { updateSpy, mediaAssetMock, warnSpy } = vi.hoisted(() => {
	const update = vi.fn((_id: string, _data: unknown) => Promise.resolve());
	const mediaAsset = vi.fn((id: string) => ({
		update: (data: unknown) => update(id, data),
	}));
	const warn = vi.fn();
	return { updateSpy: update, mediaAssetMock: mediaAsset, warnSpy: warn };
});

vi.mock("../firestore", () => ({
	docs: { mediaAsset: mediaAssetMock },
	// `addReferencingApp` touches neither, but `mediaAssets.ts` imports both at
	// module scope; empty stand-ins keep the module graph resolvable.
	collections: { mediaAssets: vi.fn() },
	getDb: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ log: { warn: warnSpy, error: vi.fn() } }));

beforeEach(() => {
	vi.clearAllMocks();
	updateSpy.mockResolvedValue(undefined);
});

describe("addReferencingApp", () => {
	it("writes nothing for an empty asset list", async () => {
		await addReferencingApp([], "app-1");
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("writes arrayUnion(appId) per UNIQUE asset id — the exact value, not just the key", async () => {
		await addReferencingApp(["a", "b", "a"], "app-1");
		expect(updateSpy).toHaveBeenCalledTimes(2);
		const ids = updateSpy.mock.calls.map((c) => c[0]).sort();
		expect(ids).toEqual(["a", "b"]);
		// Pin the VALUE, not just the key: each update must arrayUnion the correct
		// app id (a wrong/stale id or a literal array would otherwise pass). The
		// real `FieldValue.arrayUnion` sentinel is structurally comparable.
		for (const [, data] of updateSpy.mock.calls) {
			expect(data).toEqual({
				referencingAppIds: FieldValue.arrayUnion("app-1"),
			});
		}
	});

	it("a dangling ref (NOT_FOUND) is logged and skipped; valid edges still land", async () => {
		updateSpy.mockImplementation((id: string) =>
			id === "missing"
				? Promise.reject(new Error("NOT_FOUND"))
				: Promise.resolve(),
		);
		// Must NOT throw — the bad ref can't poison the batch.
		await expect(
			addReferencingApp(["good", "missing"], "app-1"),
		).resolves.toBeUndefined();
		// Both updates were attempted (independent, not short-circuited).
		expect(updateSpy).toHaveBeenCalledTimes(2);
		// The failure was logged, naming the offending asset.
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][1]).toMatchObject({
			assetId: "missing",
			appId: "app-1",
		});
	});
});
