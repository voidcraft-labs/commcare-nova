/**
 * Exact Project-scoped media-reference projection helpers against Postgres.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { MediaAssetId } from "@/lib/domain";
import {
	deleteMediaReferenceEdges,
	insertMediaReferenceEdges,
	lockAndValidateMediaReferences,
	MediaReferenceProjectionError,
} from "../mediaAssets";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("exact_media_refs_");
const PROJECT = "project-1";
const ASSET_A = testMediaAssetId("asset-a");
const ASSET_B = testMediaAssetId("asset-b");
const MISSING = testMediaAssetId("asset-missing");

async function seedAsset(id: MediaAssetId, kind = "image"): Promise<void> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: "owner-1",
			content_hash: id.padEnd(64, "a").slice(0, 64),
			mime_type: kind === "image" ? "image/png" : "audio/mpeg",
			extension: kind === "image" ? ".png" : ".mp3",
			size_bytes: 1024,
			kind,
			gcs_object_key: `projects/${PROJECT}/${id}`,
			original_filename: `${id}`,
			status: "ready",
		})
		.execute();
}

describe("exact media reference projection", () => {
	it("replaces the complete set, including removal to empty", async () => {
		const appId = await h.seedApp({ id: "app-exact", project_id: PROJECT });
		await seedAsset(ASSET_A);
		await seedAsset(ASSET_B);

		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				const ids = await lockAndValidateMediaReferences(tx, PROJECT, [
					{ assetId: ASSET_A, expectedKind: "image" },
					{ assetId: ASSET_B, expectedKind: "image" },
					{ assetId: ASSET_A, expectedKind: "image" },
				]);
				await deleteMediaReferenceEdges(tx, appId);
				await insertMediaReferenceEdges(tx, {
					projectId: PROJECT,
					appId,
					assetIds: ids,
				});
			});
		expect(
			await h
				.db()
				.selectFrom("media_asset_refs")
				.select(["project_id", "app_id", "asset_id"])
				.where("app_id", "=", appId)
				.orderBy("asset_id")
				.execute(),
		).toEqual(
			[ASSET_A, ASSET_B].sort().map((assetId) => ({
				project_id: PROJECT,
				app_id: appId,
				asset_id: assetId,
			})),
		);

		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				await deleteMediaReferenceEdges(tx, appId);
				await insertMediaReferenceEdges(tx, {
					projectId: PROJECT,
					appId,
					assetIds: [],
				});
			});
		expect(
			await h
				.db()
				.selectFrom("media_asset_refs")
				.selectAll()
				.where("app_id", "=", appId)
				.execute(),
		).toEqual([]);
	});

	it("fails the transaction for missing or wrong-kind assets", async () => {
		await seedAsset(ASSET_A);
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					lockAndValidateMediaReferences(tx, PROJECT, [
						{ assetId: MISSING, expectedKind: "image" },
					]),
				),
		).rejects.toBeInstanceOf(MediaReferenceProjectionError);
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					lockAndValidateMediaReferences(tx, PROJECT, [
						{ assetId: ASSET_A, expectedKind: "audio" },
					]),
				),
		).rejects.toBeInstanceOf(MediaReferenceProjectionError);
	});
});
