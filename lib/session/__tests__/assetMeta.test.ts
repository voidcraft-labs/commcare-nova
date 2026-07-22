/**
 * The session's asset-metadata registry — the state model behind the
 * browser attach budget check. What must hold:
 *
 *   1. Observed rows merge in keyed by id; later observations overwrite
 *      (a re-uploaded asset's fresh status wins).
 *   2. The merge is idempotent — re-recording identical rows writes
 *      nothing, so re-fetched library pages don't churn subscribers.
 *   3. `reset()` empties the registry with the rest of the session.
 */

import { describe, expect, it } from "vitest";
import { createBuilderSessionStore } from "../store";

const IMG = { kind: "image", status: "ready", sizeBytes: 1024 } as const;

describe("asset metadata registry", () => {
	it("merges observed rows keyed by id, later observations overwriting", () => {
		const store = createBuilderSessionStore();
		store.getState().recordAssetMeta([
			{ id: "a", ...IMG },
			{ id: "b", kind: "audio", status: "ready", sizeBytes: 2048 },
		]);
		store
			.getState()
			.recordAssetMeta([
				{ id: "a", kind: "image", status: "ready", sizeBytes: 4096 },
			]);

		const meta = store.getState().assetMeta;
		expect(meta.a).toEqual({ kind: "image", status: "ready", sizeBytes: 4096 });
		expect(meta.b).toEqual({ kind: "audio", status: "ready", sizeBytes: 2048 });
	});

	it("skips the write when every incoming row is already recorded verbatim", () => {
		const store = createBuilderSessionStore();
		store.getState().recordAssetMeta([{ id: "a", ...IMG }]);
		const before = store.getState().assetMeta;

		store.getState().recordAssetMeta([{ id: "a", ...IMG }]);
		expect(store.getState().assetMeta).toBe(before);

		store.getState().recordAssetMeta([]);
		expect(store.getState().assetMeta).toBe(before);
	});

	it("reset() empties the registry", () => {
		const store = createBuilderSessionStore();
		store.getState().recordAssetMeta([{ id: "a", ...IMG }]);
		store.getState().reset();
		expect(store.getState().assetMeta).toEqual({});
	});

	it("Project-scope reset forgets source-Project rows", () => {
		const store = createBuilderSessionStore();
		store.getState().recordAssetMeta([{ id: "a", ...IMG }]);
		store.getState().resetProjectScope();
		expect(store.getState().assetMeta).toEqual({});
	});
});
