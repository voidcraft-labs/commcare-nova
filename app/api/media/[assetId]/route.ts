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
import { asAssetId, extractObjectKeyForAsset } from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import {
	findAppReferencesToAsset,
	purgeAssetStorage,
} from "@/lib/media/assetDeletion";
import { getStoredObjectSize, streamAsset } from "@/lib/storage/media";

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

		// The response declares Content-Length before any byte streams, so a
		// missing object discovered mid-stream cannot become a 404 — it
		// truncates the body, Cloud Run's front end drops the malformed
		// response as a 503, and that teardown takes the other responses
		// multiplexed on the connection down with it. Resolve the size from
		// storage up front instead: a missing object turns into a clean 404
		// before headers go out, and Content-Length comes from the bytes
		// we'll actually serve, so the response can't disagree with itself
		// even if the row's recorded size drifts from the object.
		const storedSize = await getStoredObjectSize(asset.gcsObjectKey);
		if (storedSize === null) {
			log.error(
				"Media asset row says ready, but its object is missing from storage — returning 404. The row is stale and needs cleanup.",
				undefined,
				{ assetId, gcsObjectKey: asset.gcsObjectKey },
			);
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
				"Content-Length": storedSize.toString(),
				// Bytes are content-hash addressed → immutable per
				// assetId. The browser can cache for a day without
				// risk of staleness.
				"Cache-Control": "private, immutable, max-age=86400",
				"X-Content-Type-Options": "nosniff",
				// Defense-in-depth for the same-origin serving model. `nosniff`
				// plus the server-sniffed canonical `Content-Type` already keep
				// the browser from executing a stored file as active content,
				// and the accepted set excludes SVG/HTML. `sandbox` is the
				// backstop: if a response is ever navigated to directly, it
				// loads into an opaque, script-less origin that can't reach the
				// app's cookies or session — so even a content-type slip or
				// renderer bug can't become a session-stealing XSS on our
				// origin. The directive is document-scoped, so it does NOT
				// affect inline `<img>`/`<audio>`/`<video>` rendering of these
				// bytes (those are subresource loads, not documents).
				"Content-Security-Policy": "sandbox",
			},
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Media read failed", 500),
		);
	}
}

/**
 * DELETE /api/media/[assetId] — remove an asset from the owner's library.
 *
 * Owner-gated (404 on missing OR foreign, so ids stay non-enumerable). Refuses
 * with a 409 — naming the carriers — if any of the owner's live apps still
 * reference the asset, so a delete can't silently orphan a reference the
 * export boundary gate would later reject. On success it purges the Firestore
 * row, the GCS bytes, and the document-extract sibling (keeping shared bytes
 * intact), then returns 204. The deletion mechanics are shared with the SA's
 * `remove_media_asset` tool via `lib/media/assetDeletion`.
 *
 * Chat-attachment references live in thread history, not in an app doc, so they
 * are intentionally NOT a blocker: a deleted attachment degrades to a "couldn't
 * be loaded" placeholder on re-resolve rather than wedging the delete.
 */
export async function DELETE(
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
		if (!asset) {
			throw new ApiError(
				"We couldn't find that file — it may already have been deleted, or it isn't yours.",
				404,
			);
		}

		// Reference guard: refuse if any of the owner's live apps still uses it.
		// `asset.referencingAppIds` is the reverse index — the candidate set the
		// guard re-walks, so it loads 0–2 apps instead of the owner's entire list.
		const references = await findAppReferencesToAsset(
			session.user.id,
			assetId,
			asset.referencingAppIds,
		);
		if (references.length > 0) {
			throw new ApiError(
				`Can't delete this file — it's still used by ${references.join("; ")}. Swap the media or clear the slot in those apps, then delete it.`,
				409,
			);
		}

		await purgeAssetStorage(asset, {
			alsoDelete: [extractObjectKeyForAsset(asset)],
		});

		return new Response(null, { status: 204 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Media delete failed", 500),
		);
	}
}
