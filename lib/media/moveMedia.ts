// lib/media/moveMedia.ts
//
// The media step of moving an app between Projects (`lib/db/moveAppToProject.ts`).
// Media is Project-scoped — an asset's `project_id` is its only access gate, and
// the export manifest filters a doc's refs to its Project — so an app's media has
// to exist in the DESTINATION Project before the move repoints the blueprint at
// it, or every referenced asset resolves to MEDIA_ASSET_NOT_FOUND there.
//
// The model is copy-and-repoint, NOT re-tenant-in-place: for each referenced
// asset, get-or-create a `ready` copy in the destination Project (deduped by
// `(project, contentHash)`; else a server-side GCS byte copy + a new ready row),
// and return an `oldAssetId -> newAssetId` map the move uses to rewrite the
// blueprint. The source asset + bytes are left untouched, so a sibling app in the
// source Project that shares the asset is unaffected. Content-addressed GCS keys
// make the copy idempotent: a re-run dedups on the existing destination row.

import "server-only";

import {
	createReadyAsset,
	findReadyAssetByProjectAndHash,
	loadAssetsByIds,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import {
	gcsObjectKeyFor,
	isMediaKind,
	type MediaKind,
} from "@/lib/domain/multimedia";
import { copyAssetObject } from "@/lib/storage/media";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { partitionAssetRefs } from "./builtinIconAssets";

/**
 * Max asset copies in flight at once. Each copy is one dedup query + (on a miss)
 * one server-side GCS copy + one Firestore write; bounding the fan-out keeps a
 * media-heavy app's move off a serial round-trip-per-asset critical path without
 * opening an unbounded number of GCS operations. Mirrors `manifest.ts`.
 */
const MEDIA_COPY_CONCURRENCY = 6;

/**
 * Copy every referenced upload-asset into `toProjectId`, returning a map from
 * each source asset id to its destination id — the input the move's blueprint
 * repoint (`remapAssetRefs`) consumes.
 *
 * Built-in `nova-icon:` refs are dropped up front: they carry no Firestore row
 * and one shared deployment-bundled copy serves every Project, so they're
 * Project-agnostic and never appear in the returned map (the repoint leaves them
 * as-is). A referenced row that isn't a `ready` media asset (a still-uploading
 * `pending` upload, a foreign-Project ref `loadAssetsByIds` silently drops) is
 * skipped — it was already broken/pending in the source, and the destination
 * inherits that same state rather than the move papering over it.
 */
export async function copyAssetsIntoProject(args: {
	assetIds: readonly string[];
	fromProjectId: string;
	toProjectId: string;
	actorUserId: string;
}): Promise<Map<string, string>> {
	const { realIds } = partitionAssetRefs(args.assetIds);
	if (realIds.length === 0) return new Map();

	const rows = (await loadAssetsByIds(realIds, args.fromProjectId)).filter(
		(row): row is MediaAssetRecord & { kind: MediaKind } =>
			row.status === "ready" && isMediaKind(row.kind),
	);

	const entries = await mapWithConcurrency(
		rows,
		MEDIA_COPY_CONCURRENCY,
		async (row): Promise<[string, string]> => {
			// Dedup: an identical-bytes asset already in the destination (a prior
			// move, or another app uploaded the same file there) is reused — no copy.
			const existing = await findReadyAssetByProjectAndHash(
				args.toProjectId,
				row.contentHash,
			);
			if (existing) return [row.id, existing.id];

			const destKey = gcsObjectKeyFor(
				args.toProjectId,
				row.contentHash,
				row.extension,
			);
			await copyAssetObject(row.gcsObjectKey, destKey);
			const { assetId } = await createReadyAsset({
				owner: args.actorUserId,
				project_id: args.toProjectId,
				contentHash: row.contentHash,
				mimeType: row.mimeType,
				kind: row.kind,
				extension: row.extension,
				sizeBytes: row.sizeBytes,
				gcsObjectKey: destKey,
				originalFilename: row.originalFilename,
				displayName: row.displayName,
				dimensions: row.dimensions,
				durationMs: row.durationMs,
			});
			return [row.id, assetId];
		},
	);

	return new Map(entries);
}
