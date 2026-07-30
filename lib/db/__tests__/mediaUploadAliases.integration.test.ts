/**
 * Real-Postgres contract for durable browser-confirm canonicalization.
 *
 * A pending attempt that deduplicates to another ready row is deleted, so the
 * alias is the only state a lost-response retry can address. These tests prove
 * the alias is committed with that delete, remains tenant/authority gated, and
 * expires through a bounded deterministic purge.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { MediaAssetId } from "@/lib/domain";
import {
	canonicalizePendingAssetForActor,
	findReadyAssetByProjectAndHash,
	purgeExpiredMediaUploadAliases,
	resolveReadyUploadAliasForActor,
} from "../mediaAssets";
import { setupAppStateTestDb } from "./appStateTestDb";

const PROJECT = "upload-alias-project";
const ACTOR = "upload-alias-editor";
const VIEWER = "upload-alias-viewer";
const HASH = "c".repeat(64);
const READY_ASSET = testMediaAssetId("60000000-0000-4000-8000-000000000001");
const PENDING_ASSET = testMediaAssetId("60000000-0000-4000-8000-000000000002");
const EXPIRED_OLDEST = testMediaAssetId("attempt-expired-oldest");
const EXPIRED_NEWER = testMediaAssetId("attempt-expired-newer");
const ACTIVE_ATTEMPT = testMediaAssetId("attempt-active");
const h = setupAppStateTestDb("media_upload_alias_");

async function seedAsset(args: {
	id: MediaAssetId;
	status: "pending" | "ready";
	createdAt?: Date;
}): Promise<void> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: args.id,
			project_id: PROJECT,
			owner: ACTOR,
			content_hash: HASH,
			mime_type: "image/png",
			extension: ".png",
			size_bytes: 10,
			dimensions:
				args.status === "ready"
					? JSON.stringify({ width: 1, height: 1 })
					: null,
			duration_ms: null,
			kind: "image",
			gcs_object_key:
				args.status === "ready"
					? `projects/${PROJECT}/${HASH}.png`
					: `pending/${PROJECT}/${args.id}.png`,
			original_filename: "logo.png",
			display_name: "Logo",
			status: args.status,
			extract: null,
			...(args.createdAt && { created_at: args.createdAt }),
		})
		.execute();
}

describe("durable media upload aliases", () => {
	it("replays the exact canonical result after the successful response and pending row are lost", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await h.seedProjectMember(VIEWER, PROJECT, "viewer");
		await seedAsset({
			id: READY_ASSET,
			status: "ready",
		});
		await seedAsset({
			id: PENDING_ASSET,
			status: "pending",
		});

		const result = await canonicalizePendingAssetForActor(
			{
				attemptAssetId: PENDING_ASSET,
				canonicalAssetId: READY_ASSET,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
				expectedContentHash: HASH,
			},
			h.db(),
		);
		expect(result).toMatchObject({
			kind: "canonicalized",
			asset: { id: "60000000-0000-4000-8000-000000000001", status: "ready" },
			releasedPending: {
				id: "60000000-0000-4000-8000-000000000002",
				status: "pending",
			},
		});
		expect(
			await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("id", "=", PENDING_ASSET)
				.executeTakeFirst(),
		).toBeUndefined();

		const alias = await h
			.db()
			.selectFrom("media_upload_aliases")
			.selectAll()
			.where("attempt_asset_id", "=", PENDING_ASSET)
			.executeTakeFirstOrThrow();
		expect(alias).toMatchObject({
			project_id: PROJECT,
			content_hash: HASH,
			canonical_asset_id: "60000000-0000-4000-8000-000000000001",
		});
		expect(alias.expires_at.getTime() - alias.created_at.getTime()).toBe(
			24 * 60 * 60 * 1_000,
		);

		// Model a dropped 200 response: the next request has only the original id.
		await expect(
			resolveReadyUploadAliasForActor({
				attemptAssetId: PENDING_ASSET,
				actorUserId: ACTOR,
			}),
		).resolves.toMatchObject({
			id: "60000000-0000-4000-8000-000000000001",
			status: "ready",
		});
		await expect(
			canonicalizePendingAssetForActor(
				{
					attemptAssetId: PENDING_ASSET,
					canonicalAssetId: READY_ASSET,
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
					expectedContentHash: HASH,
				},
				h.db(),
			),
		).resolves.toMatchObject({
			kind: "already_canonical",
			asset: { id: "60000000-0000-4000-8000-000000000001" },
		});

		// A Project viewer cannot spend the write-capable confirm endpoint.
		await expect(
			resolveReadyUploadAliasForActor({
				attemptAssetId: PENDING_ASSET,
				actorUserId: VIEWER,
			}),
		).resolves.toBeNull();
	});

	it("keeps rejected authority non-mutating", async () => {
		await h.seedProjectMember(VIEWER, PROJECT, "viewer");
		await seedAsset({
			id: READY_ASSET,
			status: "ready",
		});
		await seedAsset({
			id: PENDING_ASSET,
			status: "pending",
		});

		await expect(
			canonicalizePendingAssetForActor(
				{
					attemptAssetId: PENDING_ASSET,
					canonicalAssetId: READY_ASSET,
					actorUserId: VIEWER,
					expectedProjectId: PROJECT,
					expectedContentHash: HASH,
				},
				h.db(),
			),
		).resolves.toEqual({ kind: "not_found" });
		await expect(
			h
				.db()
				.selectFrom("media_assets")
				.select("status")
				.where("id", "=", PENDING_ASSET)
				.executeTakeFirst(),
		).resolves.toEqual({ status: "pending" });
		await expect(
			h
				.db()
				.selectFrom("media_upload_aliases")
				.select("attempt_asset_id")
				.execute(),
		).resolves.toEqual([]);
	});

	it("converges simultaneous canonicalization attempts on one durable result", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await seedAsset({
			id: READY_ASSET,
			status: "ready",
		});
		await seedAsset({
			id: PENDING_ASSET,
			status: "pending",
		});

		const canonicalize = () =>
			canonicalizePendingAssetForActor(
				{
					attemptAssetId: PENDING_ASSET,
					canonicalAssetId: READY_ASSET,
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
					expectedContentHash: HASH,
				},
				h.db(),
			);
		const outcomes = await Promise.all([canonicalize(), canonicalize()]);

		expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
			"already_canonical",
			"canonicalized",
		]);
		await expect(
			h
				.db()
				.selectFrom("media_upload_aliases")
				.select(["attempt_asset_id", "canonical_asset_id"])
				.execute(),
		).resolves.toEqual([
			{
				attempt_asset_id: "60000000-0000-4000-8000-000000000002",
				canonical_asset_id: "60000000-0000-4000-8000-000000000001",
			},
		]);
		await expect(
			resolveReadyUploadAliasForActor({
				attemptAssetId: PENDING_ASSET,
				actorUserId: ACTOR,
			}),
		).resolves.toMatchObject({
			id: "60000000-0000-4000-8000-000000000001",
			status: "ready",
		});
	});

	it("ignores expired aliases and purges only the bounded oldest batch", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await seedAsset({
			id: READY_ASSET,
			status: "ready",
		});
		const now = Date.now();
		await h
			.db()
			.insertInto("media_upload_aliases")
			.values([
				{
					attempt_asset_id: EXPIRED_OLDEST,
					project_id: PROJECT,
					content_hash: HASH,
					canonical_asset_id: READY_ASSET,
					created_at: new Date(now - 3 * 86_400_000),
					expires_at: new Date(now - 2 * 86_400_000),
				},
				{
					attempt_asset_id: EXPIRED_NEWER,
					project_id: PROJECT,
					content_hash: HASH,
					canonical_asset_id: READY_ASSET,
					created_at: new Date(now - 2 * 86_400_000),
					expires_at: new Date(now - 86_400_000),
				},
				{
					attempt_asset_id: ACTIVE_ATTEMPT,
					project_id: PROJECT,
					content_hash: HASH,
					canonical_asset_id: READY_ASSET,
					created_at: new Date(now),
					expires_at: new Date(now + 86_400_000),
				},
			])
			.execute();

		await expect(
			resolveReadyUploadAliasForActor({
				attemptAssetId: EXPIRED_NEWER,
				actorUserId: ACTOR,
			}),
		).resolves.toBeNull();
		await expect(purgeExpiredMediaUploadAliases(1)).resolves.toBe(1);
		await expect(
			h
				.db()
				.selectFrom("media_upload_aliases")
				.select("attempt_asset_id")
				.orderBy("attempt_asset_id")
				.execute(),
		).resolves.toEqual([
			{ attempt_asset_id: ACTIVE_ATTEMPT },
			{ attempt_asset_id: EXPIRED_NEWER },
		]);
		await expect(purgeExpiredMediaUploadAliases()).resolves.toBe(1);
		await expect(
			h
				.db()
				.selectFrom("media_upload_aliases")
				.select("attempt_asset_id")
				.execute(),
		).resolves.toEqual([{ attempt_asset_id: ACTIVE_ATTEMPT }]);
	});

	it("chooses the oldest ready row with an id tie-break deterministically", async () => {
		await seedAsset({
			id: testMediaAssetId("60000000-0000-4000-8000-000000000003"),
			status: "ready",
			createdAt: new Date("2026-07-22T12:00:00.000Z"),
		});
		await seedAsset({
			id: testMediaAssetId("60000000-0000-4000-8000-000000000005"),
			status: "ready",
			createdAt: new Date("2026-07-21T12:00:00.000Z"),
		});
		await seedAsset({
			id: testMediaAssetId("60000000-0000-4000-8000-000000000004"),
			status: "ready",
			createdAt: new Date("2026-07-21T12:00:00.000Z"),
		});

		await expect(
			findReadyAssetByProjectAndHash(PROJECT, HASH, h.db()),
		).resolves.toMatchObject({ id: "60000000-0000-4000-8000-000000000004" });
	});
});
