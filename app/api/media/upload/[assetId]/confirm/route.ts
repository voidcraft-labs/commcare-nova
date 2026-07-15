/**
 * POST /api/media/upload/[assetId]/confirm — finalize an upload.
 *
 * Called by the browser after the signed-PUT step completes. The
 * server:
 *
 *   1. loads the `pending` row (rejects if the caller isn't a Project member, or it's missing)
 *   2. downloads the bytes from the pending GCS object once
 *   3. runs the validation pipeline against the stored bytes
 *   4. on failure: deletes the pending GCS object AND the Postgres row,
 *      returns 400 with the rejection message
 *   5. on success: promotes the bytes to the content-hash final key,
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
	confirmAssetReady,
	deleteAsset as deleteAssetRow,
	findReadyAssetByProjectAndHash,
	hasOtherAssetForGcsObjectKey,
	loadAssetById,
	type MediaAssetRecord,
	toWireMediaAsset,
} from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	asAssetId,
	gcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { validateMediaBytes } from "@/lib/media/validate";
import {
	copyAssetObject,
	deleteAsset as deleteGcsObject,
	downloadAssetBytes,
	getStoredObjectSize,
} from "@/lib/storage/media";

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	try {
		const session = await requireSession(req);
		const { assetId: rawAssetId } = await params;
		const assetId = asAssetId(rawAssetId);

		// Owner-agnostic load, then authorize by Project membership. A
		// non-member reads as the same 404 a missing row does, so asset ids
		// stay non-enumerable.
		const asset = await loadAssetById(assetId);
		if (
			!asset ||
			!(await userInProject(session.user.id, asset.project_id, "edit"))
		) {
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
		// `downloadAssetBytes`. Missing object → the upload never
		// landed; treat as not-found.
		const storedSize = await getStoredObjectSize(asset.gcsObjectKey);
		if (storedSize === null) {
			throw new ApiError(
				"We couldn't find the uploaded bytes for this asset. The signed-upload step may not have completed — try uploading again.",
				404,
			);
		}
		const cap = ASSET_SIZE_CAPS_BYTES[asset.kind];
		if (storedSize > cap) {
			await deleteRejectedUpload(asset);
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
		const bytes = await downloadAssetBytes(
			asset.gcsObjectKey,
			ASSET_SIZE_CAPS_BYTES[asset.kind],
		);
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
			await deleteRejectedUpload(asset);
			throw new ApiError(result.message, 400);
		}

		// Collapse a dedup race. Two concurrent uploads of identical
		// bytes both miss the initiate-time dedup probe (neither is
		// `ready` yet). If a sibling already flipped to `ready`, drop
		// this pending row and return the sibling, so the library never
		// shows the same asset twice. Simultaneous double-confirm can
		// still leave two ready rows, but both point at identical final
		// bytes and the deletion path checks for shared object keys.
		const sibling = await findReadyAssetByProjectAndHash(
			asset.project_id,
			asset.contentHash,
		);
		if (sibling && sibling.id !== assetId) {
			await deleteRejectedUpload(asset);
			return NextResponse.json({ ok: true, asset: toWireMediaAsset(sibling) });
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
		let pendingObjectToDelete: string | null = null;
		if (asset.gcsObjectKey !== finalGcsObjectKey) {
			await copyAssetObject(asset.gcsObjectKey, finalGcsObjectKey);
			pendingObjectToDelete = asset.gcsObjectKey;
		}

		await confirmAssetReady({
			assetId,
			gcsObjectKey: finalGcsObjectKey,
			// The validator may refine mimeType/extension from the pending
			// row's create-time guess (see above) — write the authoritative
			// values so the row matches the stored bytes.
			mimeType: result.validated.mimeType,
			extension: result.validated.extension,
			dimensions: result.validated.dimensions,
			durationMs: result.validated.durationMs,
		});
		if (pendingObjectToDelete) {
			await deleteGcsObject(pendingObjectToDelete).catch((err: unknown) => {
				log.error("[media:confirm] pending-object cleanup failed", err, {
					assetId,
					gcsObjectKey: pendingObjectToDelete,
				});
			});
		}

		return NextResponse.json({
			ok: true,
			// `sizeBytes` is unchanged (the validator hard-rejects a
			// length mismatch). `mimeType`/`extension` carry the validated
			// values (which may refine the pending row's guess for a
			// document) so the response matches what was stored.
			asset: toWireMediaAsset({
				...asset,
				status: "ready",
				gcsObjectKey: finalGcsObjectKey,
				mimeType: result.validated.mimeType,
				extension: result.validated.extension,
				dimensions: result.validated.dimensions,
				durationMs: result.validated.durationMs,
			}),
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
 * Delete a rejected upload attempt without risking a shared ready object.
 *
 * New browser uploads use per-attempt pending keys, but legacy rows and
 * simultaneous duplicate-ready races can share an object. If another row
 * points at the same key, remove only this Postgres row and leave bytes
 * intact for the sibling.
 */
async function deleteRejectedUpload(asset: MediaAssetRecord): Promise<void> {
	const shared = await hasOtherAssetForGcsObjectKey(
		asset.gcsObjectKey,
		asset.id,
	).catch((err: unknown) => {
		log.error("[media:confirm] shared-object check failed", err, {
			assetId: asset.id,
			gcsObjectKey: asset.gcsObjectKey,
		});
		// Fail closed on bytes deletion: if we cannot prove the object is
		// unshared, leave it behind and delete only the invalid row.
		return true;
	});
	const deletions: Promise<unknown>[] = [deleteAssetRow(asset.id)];
	if (!shared) deletions.push(deleteGcsObject(asset.gcsObjectKey));
	await Promise.allSettled(deletions);
}
