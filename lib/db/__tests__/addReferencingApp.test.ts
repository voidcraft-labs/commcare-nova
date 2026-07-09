/**
 * `addReferencingApp` — the reverse-index WRITE the delete guard's candidate set
 * depends on, against the real per-test Postgres.
 *
 * On Postgres the reverse index is the `media_asset_refs` join table (one row per
 * `(asset, app)` edge, PK `(asset_id, app_id)`, FK `asset_id → media_assets(id)`).
 * Locks three contracts:
 *   - An empty asset list writes NOTHING (the no-media common case is free).
 *   - Each UNIQUE asset id gets one edge, deduped + idempotent (`ON CONFLICT DO
 *     NOTHING` — re-adding a present edge leaves the set unchanged).
 *   - Writes are INDEPENDENT (Promise.allSettled): a dangling ref (no
 *     `media_assets` row → an FK violation) is logged and SKIPPED, and the other
 *     valid edges still land. A single bad ref must not drop every edge — that's
 *     why this isn't one atomic batch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "./appStateTestDb";

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("@/lib/logger", () => ({
	log: { warn: warnSpy, error: vi.fn(), info: vi.fn(), critical: vi.fn() },
}));

const h = setupAppStateTestDb("add_ref_");

/** Seed a `ready` `media_assets` row so a `media_asset_refs` edge can reference it. */
async function seedAsset(id: string): Promise<void> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: "project-1",
			owner: "owner-1",
			content_hash: "a".repeat(64),
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 1024,
			kind: "image",
			gcs_object_key: `projects/project-1/${id}.png`,
			original_filename: `${id}.png`,
			status: "ready",
		})
		.execute();
}

/** The referencing-app ids recorded for an asset. */
async function refsFor(assetId: string): Promise<string[]> {
	const rows = await h
		.db()
		.selectFrom("media_asset_refs")
		.select("app_id")
		.where("asset_id", "=", assetId)
		.execute();
	return rows.map((r) => r.app_id).sort();
}

describe("addReferencingApp", () => {
	beforeEach(() => {
		warnSpy.mockClear();
	});

	it("writes nothing for an empty asset list", async () => {
		const { addReferencingApp } = await import("../mediaAssets");
		await addReferencingApp([], "app-1");
		const all = await h
			.db()
			.selectFrom("media_asset_refs")
			.selectAll()
			.execute();
		expect(all).toHaveLength(0);
	});

	it("writes one edge per UNIQUE asset id and is idempotent on a re-add", async () => {
		const { addReferencingApp } = await import("../mediaAssets");
		await seedAsset("a");
		await seedAsset("b");

		await addReferencingApp(["a", "b", "a"], "app-1");
		expect(await refsFor("a")).toEqual(["app-1"]);
		expect(await refsFor("b")).toEqual(["app-1"]);

		// A re-add of a present edge changes nothing (ON CONFLICT DO NOTHING).
		await addReferencingApp(["a"], "app-1");
		expect(await refsFor("a")).toEqual(["app-1"]);
	});

	it("a dangling ref (no asset row → FK violation) is logged and skipped; valid edges still land", async () => {
		const { addReferencingApp } = await import("../mediaAssets");
		await seedAsset("good");
		warnSpy.mockClear();

		// Must NOT throw — the bad ref can't poison the batch.
		await expect(
			addReferencingApp(["good", "missing"], "app-1"),
		).resolves.toBeUndefined();

		// The valid edge landed; the dangling one did not.
		expect(await refsFor("good")).toEqual(["app-1"]);
		expect(await refsFor("missing")).toEqual([]);
		// The failure was logged, naming the offending asset.
		const warned = warnSpy.mock.calls.find(
			(c) => c[1]?.assetId === "missing" && c[1]?.appId === "app-1",
		);
		expect(warned).toBeDefined();
	});
});
