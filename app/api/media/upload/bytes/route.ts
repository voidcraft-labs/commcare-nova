/**
 * PUT /api/media/upload/bytes?assetId=<assetId> — receive an upload's bytes
 * and write them to storage.
 *
 * Step 2 of the upload flow (initiate → THIS → confirm). `POST /api/media/upload`
 * reserves a pending row and hands back this URL carrying its `assetId`; the
 * browser PUTs the file body here. The route loads that pending row — so it
 * writes only to a key the caller actually reserved, at that kind's exact size
 * cap, never a client-named path — and streams the body to the row's pending
 * GCS key. Confirm then validates the stored bytes and promotes them.
 *
 * This route carries the one large body in the app (video, up to its kind
 * cap), which can exceed Cloud Run's 32 MiB HTTP/1 request limit — the
 * container fronts Next with an h2c nginx so the Cloud Run→container hop is
 * HTTP/2, which has no such limit.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	loadAssetForOwner,
	MediaAssetOwnershipError,
} from "@/lib/db/mediaAssets";
import { ASSET_SIZE_CAPS_BYTES, asAssetId } from "@/lib/domain/multimedia";
import {
	AssetUploadTooLargeError,
	uploadAssetStream,
} from "@/lib/storage/media";

export async function PUT(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const assetIdParam = new URL(req.url).searchParams.get("assetId");
		if (!assetIdParam) {
			throw new ApiError(
				"The upload is missing its `assetId` — the initiate step sets it; don't call this route directly.",
				400,
			);
		}

		// Load the caller's own pending row. A foreign owner throws (caught as
		// not-found below); a missing or already-finalized row means there's no
		// upload to receive bytes for. Streaming to `asset.gcsObjectKey` (not a
		// client-supplied path) keeps the write scoped to a reserved attempt and
		// caps it at the asset's own kind.
		const asset = await loadAssetForOwner(
			session.user.id,
			asAssetId(assetIdParam),
		).catch((err: unknown) => {
			if (err instanceof MediaAssetOwnershipError) return null;
			throw err;
		});
		if (!asset || asset.status !== "pending") {
			throw new ApiError(
				"We couldn't find a pending upload for this id. Start the upload again.",
				404,
			);
		}

		if (!req.body) {
			throw new ApiError(
				"The upload arrived with no body — attach the file's bytes and try again.",
				400,
			);
		}

		const contentType =
			req.headers.get("content-type") ?? "application/octet-stream";
		try {
			await uploadAssetStream({
				gcsObjectKey: asset.gcsObjectKey,
				body: req.body,
				contentType,
				maxBytes: ASSET_SIZE_CAPS_BYTES[asset.kind],
			});
		} catch (err) {
			if (err instanceof AssetUploadTooLargeError) {
				throw new ApiError(err.message, 413);
			}
			throw err;
		}

		return new NextResponse(null, { status: 200 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Upload failed"),
		);
	}
}
