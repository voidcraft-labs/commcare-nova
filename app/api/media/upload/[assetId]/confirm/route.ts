/**
 * POST /api/media/upload/[assetId]/confirm — finalize an upload.
 *
 * Called by the browser after the signed-PUT step completes. The
 * server:
 *
 *   1. loads the `pending` row (rejects if the caller isn't a Project member, or it's missing)
 *   2. downloads the bytes from the pending GCS object once
 *   3. runs the validation pipeline against the stored bytes
 *   4. on failure: freshly locks the row; deletes only if it is still pending,
 *      otherwise returns the concurrently-published ready asset idempotently
 *   5. on success: writes the exact validated bytes to the content-hash final key,
 *      writes validated metadata, flips status to `ready`
 *
 * The validator's hash check catches GCS-side tampering between the
 * PUT and this confirm (the sniffed bytes' sha256 must match the
 * row's claimed content hash). The sharp/music-metadata re-parse
 * catches truncation + corruption — bytes that pass the magic-bytes
 * sniff but don't actually parse as the format they claim.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { userInProject } from "@/lib/db/appAccess";
import {
	canonicalizePendingAssetForActor,
	deletePendingAssetForActor,
	findReadyAssetByProjectAndHash,
	loadAssetById,
	type MediaAssetRecord,
	publishPendingAssetForActor,
	purgeExpiredMediaUploadAliases,
	resolveReadyUploadAliasForActor,
	toWireMediaAsset,
} from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	asAssetId,
	gcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import {
	cleanupReleasedAssetStorage,
	cleanupUnpublishedAssetObject,
} from "@/lib/media/assetDeletion";
import { validateMediaBytes } from "@/lib/media/validate";
import {
	downloadAssetBytes,
	getStoredObjectSize,
	uploadAssetBytes,
} from "@/lib/storage/media";
import { withMediaObjectKeyLock } from "@/lib/storage/mediaObjectKeyLock";

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	try {
		const session = await requireSession(req);
		const { assetId: rawAssetId } = await params;
		const assetId = asAssetId(rawAssetId);

		// Owner-agnostic load, then authorize by Project membership. A missing
		// pending row may still have a durable successful canonicalization:
		// resolve that exact attempt id under the alias's fresh Project edit
		// authority before returning not-found. No hash-only inference is used
		// for a fresh retry.
		const asset = await loadAssetById(assetId);
		if (!asset) {
			const canonical = await resolveReadyUploadAliasForActor({
				attemptAssetId: assetId,
				actorUserId: session.user.id,
			});
			if (canonical) {
				return NextResponse.json({
					ok: true,
					asset: toWireMediaAsset(canonical),
				});
			}
			throw new ApiError(
				"We couldn't find the upload you're trying to confirm. It may have been cleaned up after timing out — try uploading again.",
				404,
			);
		}
		if (!(await userInProject(session.user.id, asset.project_id, "edit"))) {
			throw new ApiError(
				"We couldn't find the upload you're trying to confirm. It may have been cleaned up after timing out — try uploading again.",
				404,
			);
		}
		if (asset.status === "ready") {
			// Idempotent: a duplicate confirm for an already-ready
			// asset returns the row as-is rather than re-validating.
			return NextResponse.json({ ok: true, asset: toWireMediaAsset(asset) });
		}

		// Size-gate from GCS metadata BEFORE pulling the body into
		// memory. The signed PUT URL is bound to the object key +
		// content-type but not the body size, so a client could
		// initiate with a small claimed size and then PUT a huge
		// body. Rejecting on the stored object's actual size here
		// keeps an oversized upload from OOMing the instance at
		// `downloadAssetBytes`. A missing object is not-found unless a
		// concurrent confirm already published this row or canonicalized it to
		// a ready same-Project/hash sibling and cleaned up the pending key.
		const storedSize = await getStoredObjectSize(asset.gcsObjectKey);
		if (storedSize === null) {
			const ready = await loadConcurrentReadyAsset(asset, session.user.id);
			if (ready) {
				return NextResponse.json({
					ok: true,
					asset: toWireMediaAsset(ready),
				});
			}
			throw new ApiError(
				"We couldn't find the uploaded bytes for this asset. The signed-upload step may not have completed — try uploading again.",
				404,
			);
		}
		const cap = ASSET_SIZE_CAPS_BYTES[asset.kind];
		if (storedSize > cap) {
			const ready = await deleteRejectedUpload(asset, session.user.id);
			if (ready) {
				return NextResponse.json({
					ok: true,
					asset: toWireMediaAsset(ready),
				});
			}
			const capMb = (cap / 1024 / 1024).toFixed(0);
			const actualMb = (storedSize / 1024 / 1024).toFixed(2);
			throw new ApiError(
				`The uploaded file is ${actualMb} MB, but ${asset.kind} uploads are capped at ${capMb} MB. Compress the file and try again.`,
				400,
			);
		}

		// The byte cap is enforced inside the read (not just the
		// `getStoredObjectSize` early-exit above): a signed PUT URL stays
		// usable for its TTL, so the stored object could have been
		// overwritten with a larger body since that metadata check.
		let bytes: Buffer;
		try {
			bytes = await downloadAssetBytes(
				asset.gcsObjectKey,
				ASSET_SIZE_CAPS_BYTES[asset.kind],
			);
		} catch (error) {
			if (isStorageNotFound(error)) {
				const ready = await loadConcurrentReadyAsset(asset, session.user.id);
				if (ready) {
					return NextResponse.json({
						ok: true,
						asset: toWireMediaAsset(ready),
					});
				}
				throw new ApiError(
					"We couldn't find the uploaded bytes for this asset. The signed-upload step may not have completed — try uploading again.",
					404,
				);
			}
			throw error;
		}
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: asset.mimeType,
			claimedSizeBytes: asset.sizeBytes,
			claimedContentHash: asset.contentHash,
			originalFilename: asset.originalFilename,
		});
		if (!result.ok) {
			// Drop this attempt's bytes + row so the upload pathway
			// returns to a clean state. The object delete is guarded
			// against legacy/shared rows before touching GCS.
			const ready = await deleteRejectedUpload(asset, session.user.id);
			if (ready) {
				return NextResponse.json({
					ok: true,
					asset: toWireMediaAsset(ready),
				});
			}
			throw new ApiError(result.message, 400);
		}

		// Key the final object off the VALIDATED mimeType/extension, not the
		// pending row's. For media the two agree, but a document's browser
		// MIME is unreliable: a `.md` initiated as `text/plain` lands with a
		// pending extension of `.txt`, while validation derives `.md` from
		// the filename. The validated extension is authoritative for the key
		// (and the row below), so the stored object isn't mis-suffixed.
		const finalGcsObjectKey = gcsObjectKeyFor(
			asset.project_id,
			result.validated.contentHash,
			result.validated.extension,
		);
		let finalObjectMayNeedCleanup = false;
		let publication: {
			asset: MediaAssetRecord;
			releasedPending: MediaAssetRecord | null;
		};
		let uploadAliasCreated = false;
		try {
			publication = await withMediaObjectKeyLock(
				finalGcsObjectKey,
				async (lockedDb) => {
					// Re-check dedup while holding the same key lock every publisher and
					// last-reference cleanup uses. Exactly one simultaneous confirm wins.
					const sibling = await findReadyAssetByProjectAndHash(
						asset.project_id,
						asset.contentHash,
						lockedDb,
					);
					if (sibling?.id === assetId) {
						// A same-id confirm published while this request was validating.
						// Re-enter the authoritative transition helper so this stale
						// request freshly proves edit authority and locks the terminal
						// row. It returns `already_ready` without rewriting bytes.
						const current = await publishPendingAssetForActor(
							{
								assetId,
								actorUserId: session.user.id,
								expectedProjectId: asset.project_id,
								gcsObjectKey: finalGcsObjectKey,
								mimeType: result.validated.mimeType,
								extension: result.validated.extension,
								dimensions: result.validated.dimensions,
								durationMs: result.validated.durationMs,
							},
							lockedDb,
						);
						if (current.kind === "not_found") {
							throw new ApiError(
								"We couldn't find the upload you're trying to confirm. It may have been cleaned up after timing out — try uploading again.",
								404,
							);
						}
						return { asset: current.asset, releasedPending: null };
					}
					if (sibling && sibling.id !== assetId) {
						// Persist the successful attempt -> canonical result in the SAME
						// transaction that deletes the pending row. A lost HTTP response
						// can then replay by the original id without guessing from the hash.
						const canonicalized = await canonicalizePendingAssetForActor(
							{
								attemptAssetId: assetId,
								canonicalAssetId: sibling.id,
								actorUserId: session.user.id,
								expectedProjectId: asset.project_id,
								expectedContentHash: asset.contentHash,
							},
							lockedDb,
						);
						if (canonicalized.kind === "not_found") {
							throw new ApiError(
								"We couldn't find the upload you're trying to confirm. It may have been cleaned up after timing out — try uploading again.",
								404,
							);
						}
						if (
							canonicalized.kind === "already_ready" ||
							canonicalized.kind === "already_canonical"
						) {
							return {
								asset: canonicalized.asset,
								releasedPending: null,
							};
						}
						uploadAliasCreated = true;
						return {
							asset: canonicalized.asset,
							releasedPending:
								canonicalized.releasedPending.gcsObjectKey ===
								canonicalized.asset.gcsObjectKey
									? null
									: canonicalized.releasedPending,
						};
					}
					// From this point the canonical object may exist without ready
					// metadata if the fresh publication transaction loses. Cleanup runs
					// only after this key lock is released and rechecks ALL rows for the key.
					finalObjectMayNeedCleanup = true;
					if (asset.gcsObjectKey !== finalGcsObjectKey) {
						// The pending key remains writable for the signed URL's whole
						// lifetime. Never copy it after validation: it may now hold a
						// different generation. Publish the exact bounded buffer that
						// produced `result.validated` instead.
						await uploadAssetBytes({
							gcsObjectKey: finalGcsObjectKey,
							bytes,
							contentType: result.validated.mimeType,
						});
					}
					const published = await publishPendingAssetForActor(
						{
							assetId,
							actorUserId: session.user.id,
							expectedProjectId: asset.project_id,
							gcsObjectKey: finalGcsObjectKey,
							mimeType: result.validated.mimeType,
							extension: result.validated.extension,
							dimensions: result.validated.dimensions,
							durationMs: result.validated.durationMs,
						},
						lockedDb,
					);
					if (published.kind === "not_found") {
						throw new ApiError(
							"We couldn't find the upload you're trying to confirm. It may have been cleaned up after timing out — try uploading again.",
							404,
						);
					}
					if (published.kind === "already_ready") {
						return { asset: published.asset, releasedPending: null };
					}
					return {
						asset: published.asset,
						releasedPending:
							asset.gcsObjectKey === published.asset.gcsObjectKey
								? null
								: asset,
					};
				},
			);
			finalObjectMayNeedCleanup = false;
		} catch (error) {
			if (finalObjectMayNeedCleanup) {
				await cleanupUnpublishedAssetObject(finalGcsObjectKey).catch(
					(cleanupError: unknown) => {
						log.error(
							"[media:confirm] lost-publication cleanup failed",
							cleanupError,
							{ assetId, gcsObjectKey: finalGcsObjectKey },
						);
					},
				);
			}
			throw error;
		}
		if (publication.releasedPending) {
			await cleanupReleasedAssetStorage(publication.releasedPending).catch(
				(err: unknown) => {
					log.error("[media:confirm] pending-object cleanup failed", err, {
						assetId,
						gcsObjectKey: publication.releasedPending?.gcsObjectKey,
					});
				},
			);
		}
		if (uploadAliasCreated) {
			await purgeExpiredMediaUploadAliases().catch((error: unknown) => {
				log.warn("[media:confirm] expired upload-alias purge failed", {
					assetId,
					error,
				});
			});
		}

		return NextResponse.json({
			ok: true,
			// `sizeBytes` is unchanged (the validator hard-rejects a
			// length mismatch). `mimeType`/`extension` carry the validated
			// values (which may refine the pending row's guess for a
			// document) so the response matches what was stored.
			asset: toWireMediaAsset(publication.asset),
		});
	} catch (err) {
		if (!(err instanceof ApiError)) {
			log.error("[media:confirm] unhandled", err);
		}
		return handleApiError(
			err instanceof Error ? err : new ApiError("Confirm failed", 500),
		);
	}
}

/**
 * Re-read the row after this request loses access to its pending object.
 *
 * A concurrent confirm may publish the same row, or atomically replace it with
 * a durable attempt -> canonical alias before releasing the pending bytes. A
 * lagging metadata/read operation then observes a storage 404 even though the
 * upload succeeded. Resolve only the exact ready row or durable alias under a
 * fresh Project edit check; never infer a result from a coincidental hash match.
 */
async function loadConcurrentReadyAsset(
	attempt: MediaAssetRecord,
	actorUserId: string,
): Promise<MediaAssetRecord | null> {
	const current = await loadAssetById(attempt.id);
	if (current?.status === "ready") {
		return authorizeReadyCandidate(current, attempt, actorUserId);
	}
	return resolveReadyUploadAliasForActor({
		attemptAssetId: attempt.id,
		actorUserId,
	});
}

async function authorizeReadyCandidate(
	candidate: MediaAssetRecord | null,
	attempt: MediaAssetRecord,
	actorUserId: string,
): Promise<MediaAssetRecord | null> {
	if (
		candidate?.status !== "ready" ||
		candidate.project_id !== attempt.project_id ||
		candidate.contentHash !== attempt.contentHash
	) {
		return null;
	}
	return (await userInProject(actorUserId, candidate.project_id, "edit"))
		? candidate
		: null;
}

function isStorageNotFound(error: unknown): boolean {
	return (error as { code?: number } | null)?.code === 404;
}

/**
 * Delete a rejected upload attempt without risking a shared ready object.
 *
 * New browser uploads use per-attempt pending keys, but legacy rows and
 * simultaneous duplicate-ready races can share an object. If another row
 * points at the same key, remove only this Postgres row and leave bytes
 * intact for the sibling.
 */
async function deleteRejectedUpload(
	asset: MediaAssetRecord,
	actorUserId: string,
): Promise<MediaAssetRecord | null> {
	const result = await deletePendingAssetForActor({
		assetId: asset.id,
		actorUserId,
		expectedProjectId: asset.project_id,
	});
	if (result.kind === "not_found") {
		throw new ApiError(
			"We couldn't find the upload you're trying to confirm. It may have been cleaned up after timing out — try uploading again.",
			404,
		);
	}
	if (result.kind === "already_ready") return result.asset;
	await cleanupReleasedAssetStorage(result.asset).catch((err: unknown) => {
		log.error("[media:confirm] rejected-object cleanup failed", err, {
			assetId: asset.id,
			gcsObjectKey: result.asset.gcsObjectKey,
		});
	});
	return null;
}
