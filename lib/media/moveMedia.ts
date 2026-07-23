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
// Every copy holds the source + destination content identities in sorted order
// while it re-reads the source pair, and a failed metadata publication performs
// a winner-aware destination cleanup before retrying.

import "server-only";

import {
	createReadyAsset,
	findReadyAssetByProjectAndHash,
	findReadyExtractForProjectAndHash,
	getAssetsInTransaction,
	installCopiedReadyExtract,
	loadAssetsByIds,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import type { MediaAssetExtract } from "@/lib/db/types";
import {
	extractGcsObjectKeyFor,
	extractObjectKeyForAsset,
	gcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { copyAssetObject, getStoredObjectSize } from "@/lib/storage/media";
import { withMediaObjectKeyLocks } from "@/lib/storage/mediaObjectKeyLock";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import {
	cleanupUnpublishedAssetObject,
	cleanupUnpublishedExtractObject,
} from "./assetDeletion";
import { partitionAssetRefs } from "./builtinIconAssets";

/**
 * Max asset copies in flight at once. Each copy is one dedup query + (on a miss)
 * one server-side GCS copy + one Postgres write; bounding the fan-out keeps a
 * media-heavy app's move off a serial round-trip-per-asset critical path without
 * opening an unbounded number of GCS operations. Mirrors `manifest.ts`.
 */
const MEDIA_COPY_CONCURRENCY = 6;

/** Per-asset copy retries (with backoff) before the move aborts. Absorbs a
 *  transient GCS/Postgres blip so it never silently breaks the asset's ref. */
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
 * Built-in `nova-icon:` refs are dropped up front: they carry no `media_assets`
 * row and one shared deployment-bundled copy serves every Project, so they're
 * Project-agnostic and never appear in the returned map. Every required
 * blueprint ref must resolve to a source-Project `ready` row or the move aborts.
 * Historical chat attachments are deliberately softer: a missing, foreign, or
 * unready old attachment remains unavailable in the transcript and does not
 * block the move. Ready historical documents copy their current extraction
 * metadata and ready extract object along with the source bytes.
 *
 * A `ready` asset that CANNOT be copied (its GCS object is missing, or a sustained
 * outage outlasts the per-asset retries) throws {@link MediaCopyFailedError},
 * which aborts the whole move before the flip — far better than completing with a
 * silently-broken, unrecoverable ref. The caller surfaces it as an actionable
 * "couldn't move — a media file couldn't be copied" and nothing has moved.
 */
export async function copyAssetsIntoProject(args: {
	/** Blueprint carriers: every real id must resolve to a ready source asset. */
	requiredAssetIds: readonly string[];
	/** Historical chat attachments: broken old references remain unavailable. */
	historicalAssetIds?: readonly string[];
	fromProjectId: string;
	toProjectId: string;
	actorUserId: string;
}): Promise<Map<string, string>> {
	const { realIds: requiredIds } = partitionAssetRefs(args.requiredAssetIds);
	const { realIds: historicalIds } = partitionAssetRefs(
		args.historicalAssetIds ?? [],
	);
	const allIds = [...new Set([...requiredIds, ...historicalIds])].sort();
	if (allIds.length === 0) return new Map();

	const loaded = await loadAssetsByIds(allIds, args.fromProjectId);
	const byId = new Map<string, MediaAssetRecord>(
		loaded.map((row) => [row.id, row]),
	);
	for (const assetId of requiredIds) {
		const row = byId.get(assetId);
		if (row === undefined || row.status !== "ready") {
			throw new MediaCopyFailedError(assetId, {
				cause: new Error(
					"The required source asset is missing, foreign to the source Project, or not ready.",
				),
			});
		}
	}
	const rows = allIds
		.map((id) => byId.get(id))
		.filter(
			(row): row is MediaAssetRecord =>
				row !== undefined && row.status === "ready",
		);
	const requiredIdSet = new Set(requiredIds);

	const entries = await mapWithConcurrency(
		rows,
		MEDIA_COPY_CONCURRENCY,
		async (row) => {
			try {
				return await copyOneAsset(row, args);
			} catch (error) {
				if (requiredIdSet.has(row.id)) throw error;
				// A historical-only attachment may be deleted after the initial
				// closure scan. Re-read after the failed copy: if its source row no
				// longer resolves as ready in the source Project, preserve the
				// transcript's unavailable reference instead of blocking the move.
				// A still-present row with missing bytes or an operational copy
				// failure remains fatal; silently skipping that would conceal damage.
				const fresh = await loadAssetsByIds([row.id], args.fromProjectId);
				if (
					!fresh.some(
						(asset) => asset.id === row.id && asset.status === "ready",
					)
				) {
					return null;
				}
				throw error;
			}
		},
	);

	return new Map(
		entries.filter((entry): entry is [string, string] => entry !== null),
	);
}

/**
 * Copy one referenced asset into the destination, retrying transient failures.
 * Returns the `[sourceId, destId]` mapping; throws {@link MediaCopyFailedError}
 * if it can't copy after retries (which aborts the whole move BEFORE the flip, so
 * the move never completes with a half-copied, silently-broken media set).
 */
async function copyOneAsset(
	row: MediaAssetRecord,
	args: {
		fromProjectId: string;
		toProjectId: string;
		actorUserId: string;
	},
): Promise<[string, string]> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt++) {
		const destKey = gcsObjectKeyFor(
			args.toProjectId,
			row.contentHash,
			row.extension,
		);
		let baseObjectMayNeedCleanup: string | null = null;
		let extractObjectMayNeedCleanup: ExtractPublicationCleanup | null = null;
		try {
			const mapping = await withMediaObjectKeyLocks(
				[row.gcsObjectKey, destKey],
				async (lockedDb) => {
					/* Relocation reads the exact source row only after BOTH content
					 * identities are held. Extraction publication uses the source
					 * identity too, so the ready metadata and versioned source object
					 * cannot change between this re-read and the GCS copy. */
					const source = await reReadReadySourceAsset(
						row,
						args.fromProjectId,
						lockedDb,
					);
					const sourceExtractPair = await readReadySourceExtractPair(
						source,
						args.toProjectId,
					);

					// Re-check dedup under the destination lock. A browser/MCP upload
					// or another move may have published after the pre-copy scan.
					const existing = await findReadyAssetByProjectAndHash(
						args.toProjectId,
						source.contentHash,
						lockedDb,
					);
					if (existing) {
						// A ready row is not sufficient evidence that its base pair
						// is usable: an earlier failed cleanup or manual storage loss
						// can leave metadata naming a missing object. The destination
						// Project/hash identity is already locked (extensions collapse
						// to that identity), so repair from the equally locked immutable
						// source before returning a mapping. A missing source or copy
						// failure rejects this attempt instead of adopting broken bytes.
						if ((await getStoredObjectSize(existing.gcsObjectKey)) === null) {
							await copyAssetObject(source.gcsObjectKey, existing.gcsObjectKey);
						}
						await copyReadyExtractToExisting(
							sourceExtractPair,
							existing,
							lockedDb,
							(cleanup) => {
								extractObjectMayNeedCleanup = cleanup;
							},
						);
						return [row.id, existing.id] as [string, string];
					}

					baseObjectMayNeedCleanup = destKey;
					await copyAssetObject(source.gcsObjectKey, destKey);
					if (sourceExtractPair !== null) {
						extractObjectMayNeedCleanup = cleanupForExtractPair(
							sourceExtractPair,
							source,
							args.toProjectId,
						);
						await copyAssetObject(
							sourceExtractPair.sourceKey,
							sourceExtractPair.destinationKey,
						);
					}
					const { assetId } = await createReadyAsset(
						{
							owner: args.actorUserId,
							project_id: args.toProjectId,
							contentHash: source.contentHash,
							mimeType: source.mimeType,
							kind: source.kind,
							extension: source.extension,
							sizeBytes: source.sizeBytes,
							gcsObjectKey: destKey,
							originalFilename: source.originalFilename,
							displayName: source.displayName,
							dimensions: source.dimensions,
							durationMs: source.durationMs,
							extract: sourceExtractPair?.extract,
						},
						lockedDb,
					);
					// Both objects now have committed metadata. Do not treat either
					// as an unpublished attempt after releasing the content locks.
					baseObjectMayNeedCleanup = null;
					extractObjectMayNeedCleanup = null;
					return [row.id, assetId] as [string, string];
				},
			);
			baseObjectMayNeedCleanup = null;
			if (extractObjectMayNeedCleanup !== null) {
				// installCopiedReadyExtract can preserve a higher-version claim that
				// raced after the destination snapshot. In that case the lower
				// version we copied is not named by this row. Release the publication
				// lock before the winner-aware cleanup reacquires it; the cleanup
				// retains the object if another ready duplicate does name the version.
				await cleanupFailedMovePublication({
					assetId: row.id,
					baseObjectKey: null,
					extractObject: extractObjectMayNeedCleanup,
				});
				extractObjectMayNeedCleanup = null;
			}
			return mapping;
		} catch (err) {
			lastErr = err;
			await cleanupFailedMovePublication({
				assetId: row.id,
				baseObjectKey: baseObjectMayNeedCleanup,
				extractObject: extractObjectMayNeedCleanup,
			});
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

type LockedMediaDb = NonNullable<Parameters<typeof createReadyAsset>[1]>;

interface ReadySourceExtractPair {
	extract: MediaAssetExtract & { status: "ready" };
	sourceKey: string;
	destinationKey: string;
}

interface ExtractPublicationCleanup {
	gcsObjectKey: string;
	projectId: string;
	contentHash: string;
	version: number;
}

async function reReadReadySourceAsset(
	initial: MediaAssetRecord,
	fromProjectId: string,
	lockedDb: LockedMediaDb,
): Promise<MediaAssetRecord> {
	const assets = await lockedDb
		.transaction()
		.execute((tx) => getAssetsInTransaction(tx, [initial.id]));
	const source = assets.get(initial.id);
	if (
		source === undefined ||
		source.project_id !== fromProjectId ||
		source.status !== "ready"
	) {
		throw new Error(
			`Source asset ${initial.id} is no longer ready in its source Project.`,
		);
	}
	if (
		source.contentHash !== initial.contentHash ||
		source.gcsObjectKey !== initial.gcsObjectKey
	) {
		throw new Error(
			`Ready source asset ${initial.id} changed immutable content identity during relocation.`,
		);
	}
	return source;
}

async function readReadySourceExtractPair(
	source: MediaAssetRecord,
	toProjectId: string,
): Promise<ReadySourceExtractPair | null> {
	if (source.extract?.status !== "ready") return null;
	const sourceKey = extractObjectKeyForAsset(source);
	if (sourceKey === null) return null;
	if ((await getStoredObjectSize(sourceKey)) === null) return null;
	const destinationKey = extractGcsObjectKeyFor(
		toProjectId,
		source.contentHash,
		source.extract.version,
	);
	return {
		extract: source.extract as MediaAssetExtract & { status: "ready" },
		sourceKey,
		destinationKey,
	};
}

async function copyReadyExtractToExisting(
	sourcePair: ReadySourceExtractPair | null,
	destination: MediaAssetRecord,
	lockedDb: LockedMediaDb,
	setObjectForCleanup: (cleanup: ExtractPublicationCleanup | null) => void,
): Promise<void> {
	if (sourcePair === null) return;
	const sourceExtract = sourcePair.extract;
	if (
		destination.extract !== undefined &&
		destination.extract.version > sourceExtract.version
	) {
		return;
	}
	const destinationKey = extractGcsObjectKeyFor(
		destination.project_id,
		destination.contentHash,
		sourceExtract.version,
	);
	const sharedReadyExtract = await findReadyExtractForProjectAndHash(
		destination.project_id,
		destination.contentHash,
		sourceExtract.version,
		lockedDb,
	);
	if (
		sharedReadyExtract !== null &&
		(await getStoredObjectSize(destinationKey)) !== null
	) {
		await installCopiedReadyExtract(
			{
				assetId: destination.id,
				extract: sharedReadyExtract,
			},
			lockedDb,
		);
		return;
	}
	setObjectForCleanup({
		gcsObjectKey: destinationKey,
		projectId: destination.project_id,
		contentHash: destination.contentHash,
		version: sourceExtract.version,
	});
	await copyAssetObject(sourcePair.sourceKey, destinationKey);
	const installed = await installCopiedReadyExtract(
		{
			assetId: destination.id,
			extract: sourceExtract,
		},
		lockedDb,
	);
	if (
		installed.status === "ready" &&
		installed.version === sourceExtract.version
	) {
		setObjectForCleanup(null);
	}
}

function cleanupForExtractPair(
	pair: ReadySourceExtractPair,
	source: MediaAssetRecord,
	destinationProjectId: string,
): ExtractPublicationCleanup {
	return {
		gcsObjectKey: pair.destinationKey,
		projectId: destinationProjectId,
		contentHash: source.contentHash,
		version: pair.extract.version,
	};
}

async function cleanupFailedMovePublication(args: {
	assetId: string;
	baseObjectKey: string | null;
	extractObject: ExtractPublicationCleanup | null;
}): Promise<void> {
	if (args.extractObject !== null) {
		await cleanupUnpublishedExtractObject(args.extractObject).catch(
			(error: unknown) => {
				log.error(
					"[copyAssetsIntoProject] lost extract-publication cleanup failed",
					error,
					{
						assetId: args.assetId,
						gcsObjectKey: args.extractObject?.gcsObjectKey,
					},
				);
			},
		);
	}
	if (args.baseObjectKey !== null) {
		await cleanupUnpublishedAssetObject(args.baseObjectKey).catch(
			(error: unknown) => {
				log.error(
					"[copyAssetsIntoProject] lost base-publication cleanup failed",
					error,
					{ assetId: args.assetId, gcsObjectKey: args.baseObjectKey },
				);
			},
		);
	}
}
