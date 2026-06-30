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
import { log } from "@/lib/logger";
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

/** Per-asset copy retries (with backoff) before the move aborts. Absorbs a
 *  transient GCS/Firestore blip so it never silently breaks the asset's ref. */
const MAX_COPY_ATTEMPTS = 3;
const COPY_RETRY_DELAY_MS = 250;

/**
 * A referenced asset couldn't be copied into the destination after retries (its
 * GCS object is missing/unreadable, or a sustained outage). The move ABORTS on
 * this — nothing has flipped yet — rather than completing with a silently-broken
 * media ref. Recoverable: retry once the asset/outage is resolved.
 */
export class MediaCopyFailedError extends Error {
	readonly name = "MediaCopyFailedError";
	constructor(
		readonly assetId: string,
		options?: { cause?: unknown },
	) {
		super(`Failed to copy media asset ${assetId} to the destination Project.`, {
			cause: options?.cause,
		});
	}
}

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
 *
 * A `ready` asset that CANNOT be copied (its GCS object is missing, or a sustained
 * outage outlasts the per-asset retries) throws {@link MediaCopyFailedError},
 * which aborts the whole move before the flip — far better than completing with a
 * silently-broken, unrecoverable ref. The caller surfaces it as an actionable
 * "couldn't move — a media file couldn't be copied" and nothing has moved.
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
		(row) => copyOneAsset(row, args),
	);

	return new Map(entries);
}

/**
 * Copy one referenced asset into the destination, retrying transient failures.
 * Returns the `[sourceId, destId]` mapping; throws {@link MediaCopyFailedError}
 * if it can't copy after retries (which aborts the whole move BEFORE the flip, so
 * the move never completes with a half-copied, silently-broken media set).
 */
async function copyOneAsset(
	row: MediaAssetRecord & { kind: MediaKind },
	args: { fromProjectId: string; toProjectId: string; actorUserId: string },
): Promise<[string, string]> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt++) {
		try {
			// Dedup: an identical-bytes asset already in the destination (a prior
			// move, or another app uploaded the file there) is reused — no copy.
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
		} catch (err) {
			lastErr = err;
			if (attempt < MAX_COPY_ATTEMPTS) {
				await new Promise((resolve) =>
					setTimeout(resolve, COPY_RETRY_DELAY_MS * attempt),
				);
			}
		}
	}
	log.error(
		"[copyAssetsIntoProject] failed to copy asset after retries",
		lastErr,
		{
			assetId: row.id,
			fromProjectId: args.fromProjectId,
			toProjectId: args.toProjectId,
		},
	);
	throw new MediaCopyFailedError(row.id, { cause: lastErr });
}
