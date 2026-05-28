/**
 * GET /api/media/[assetId] — stream a media asset's bytes.
 *
 * Owner-gated proxy in front of GCS. The bucket has uniform
 * bucket-level access + public-access prevention enforced — the
 * only way the browser sees these bytes is through this route, and
 * the route's session check is what enforces "your assets, your
 * bytes."
 *
 * 404 on both missing-asset AND foreign-owner so the response
 * shape can't be used to enumerate other users' asset ids.
 *
 * `Cache-Control: private, immutable, max-age=86400` — the bytes
 * are content-hash addressed so they really are immutable for the
 * lifetime of the asset id. `private` keeps shared proxies from
 * caching them between users.
 */

import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	loadAssetForOwner,
	MediaAssetOwnershipError,
} from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import { streamAsset } from "@/lib/storage/media";

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	try {
		const session = await requireSession(req);
		const { assetId: rawAssetId } = await params;
		const assetId = asAssetId(rawAssetId);

		const asset = await loadAssetForOwner(session.user.id, assetId).catch(
			(err: unknown) => {
				if (err instanceof MediaAssetOwnershipError) return null;
				throw err;
			},
		);
		if (!asset || asset.status !== "ready") {
			throw new ApiError("Media asset not found.", 404);
		}

		const nodeStream = streamAsset(asset.gcsObjectKey);
		// Destroy the underlying GCS read stream if the client aborts
		// mid-transfer (seek, navigate-away, tab close). Without this
		// the socket/file handle stays open per aborted request —
		// which both leaks resources in production and trips the
		// pre-push async-leak gate in tests.
		req.signal.addEventListener("abort", () => nodeStream.destroy());
		const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

		return new Response(webStream, {
			headers: {
				"Content-Type": asset.mimeType,
				"Content-Length": asset.sizeBytes.toString(),
				// Bytes are content-hash addressed → immutable per
				// assetId. The browser can cache for a day without
				// risk of staleness.
				"Cache-Control": "private, immutable, max-age=86400",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Media read failed", 500),
		);
	}
}
