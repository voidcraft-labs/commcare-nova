/**
 * POST /api/media/upload/[assetId]/confirm — finalize an upload.
 *
 * Called by the browser after the signed-PUT step completes. The
 * server:
 *
 *   1. loads the `pending` row (rejects if foreign owner or missing)
 *   2. downloads the bytes from GCS once
 *   3. runs the validation pipeline against the stored bytes
 *   4. on failure: deletes the GCS object AND the Firestore row,
 *      returns 400 with the rejection message
 *   5. on success: writes validated metadata, flips status to `ready`
 *
 * The validator's hash check catches GCS-side tampering between the
 * PUT and this confirm (the sniffed bytes' sha256 must match the
 * claimed hash the route's gcsObjectKey was derived from). The
 * sharp/ffprobe re-parse catches truncation + corruption — bytes
 * that pass the magic-bytes sniff but don't actually parse as the
 * format they claim.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	confirmAssetReady,
	deleteAsset as deleteAssetRow,
	findReadyAssetByOwnerAndHash,
	loadAssetForOwner,
	MediaAssetOwnershipError,
	toWireMediaAsset,
} from "@/lib/db/mediaAssets";
import { asAssetId, MEDIA_SIZE_CAPS_BYTES } from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { validateMediaBytes } from "@/lib/media/validate";
import {
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

		const asset = await loadAssetForOwner(session.user.id, assetId).catch(
			(err: unknown) => {
				if (err instanceof MediaAssetOwnershipError) {
					return null;
				}
				throw err;
			},
		);
		if (!asset) {
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
		const cap = MEDIA_SIZE_CAPS_BYTES[asset.kind];
		if (storedSize > cap) {
			await Promise.allSettled([
				deleteGcsObject(asset.gcsObjectKey),
				deleteAssetRow(assetId),
			]);
			const capMb = (cap / 1024 / 1024).toFixed(0);
			const actualMb = (storedSize / 1024 / 1024).toFixed(2);
			throw new ApiError(
				`The uploaded file is ${actualMb} MB, but ${asset.kind} uploads are capped at ${capMb} MB. Compress the file and try again.`,
				400,
			);
		}

		const bytes = await downloadAssetBytes(asset.gcsObjectKey);
		const result = await validateMediaBytes({
			bytes,
			claimedMimeType: asset.mimeType,
			claimedSizeBytes: asset.sizeBytes,
			claimedContentHash: asset.contentHash,
			originalFilename: asset.originalFilename,
		});
		if (!result.ok) {
			// Drop the bytes + row so the upload pathway returns to
			// a clean state. A best-effort delete — concurrent calls
			// could race, and a stale orphan is harmless (orphan
			// cleanup handles it).
			await Promise.allSettled([
				deleteGcsObject(asset.gcsObjectKey),
				deleteAssetRow(assetId),
			]);
			throw new ApiError(result.message, 400);
		}

		// Collapse a dedup race. Two concurrent uploads of identical
		// bytes both miss the initiate-time dedup probe (neither is
		// `ready` yet) and create two pending rows pointing at the
		// same GCS object. If a sibling already flipped to `ready`,
		// drop this pending row — WITHOUT deleting the shared GCS
		// object — and return the sibling, so the library never shows
		// the same asset twice. (This closes the common case; a
		// simultaneous double-confirm where neither sees the other
		// yet can still leave two rows — benign, identical bytes —
		// and is the deletion path's job to handle by checking for
		// siblings on the same object key.)
		const sibling = await findReadyAssetByOwnerAndHash(
			session.user.id,
			asset.contentHash,
		);
		if (sibling && sibling.id !== assetId) {
			await deleteAssetRow(assetId);
			return NextResponse.json({ ok: true, asset: toWireMediaAsset(sibling) });
		}

		await confirmAssetReady({
			assetId,
			dimensions: result.validated.dimensions,
			durationMs: result.validated.durationMs,
		});

		return NextResponse.json({
			ok: true,
			// `mimeType` / `extension` / `sizeBytes` are unchanged from
			// the pending row (the validator only succeeds when the
			// sniff matches the canonical claim and the size matches),
			// so the response carries them straight off `asset`; only
			// status + the post-validation dimensions/duration are new.
			asset: toWireMediaAsset({
				...asset,
				status: "ready",
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
