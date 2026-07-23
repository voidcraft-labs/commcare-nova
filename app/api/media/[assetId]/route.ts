/**
 * GET /api/media/[assetId] — stream a media asset's bytes.
 *
 * Project-gated proxy in front of GCS. The bucket has uniform
 * bucket-level access + public-access prevention enforced — the
 * only way the browser sees these bytes is through this route, and
 * the route's Project-membership check is what enforces "your
 * Project's assets, your bytes."
 *
 * 404 on both missing-asset AND non-member so the response
 * shape can't be used to enumerate other Projects' asset ids.
 *
 * `Cache-Control: private, no-store` — authorization follows current Project
 * membership, which can change while a tab stays open. Content-hash identity
 * prevents byte drift but cannot make a previously authorized response safe
 * to reuse after an app/asset moves or membership is revoked.
 */

import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { userInProject } from "@/lib/db/appAccess";
import { loadAssetById } from "@/lib/db/mediaAssets";
import { deleteMediaAssetForActor } from "@/lib/db/mediaDeletion";
import { asAssetId, extractObjectKeyForAsset } from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { purgeAssetStorage } from "@/lib/media/assetDeletion";
import { getStoredObjectSize, streamAsset } from "@/lib/storage/media";

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	try {
		const session = await requireSession(req);
		const { assetId: rawAssetId } = await params;
		const assetId = asAssetId(rawAssetId);

		const asset = await loadAssetById(assetId);
		if (asset?.status !== "ready") {
			throw new ApiError("Media asset not found.", 404);
		}
		// A non-member reads as the same 404 a missing/unready asset does, so
		// ids stay non-enumerable.
		if (!(await userInProject(session.user.id, asset.project_id, "view"))) {
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
				// Reauthorize every load. Byte immutability does not outlive
				// Project membership, app moves, or access revocation.
				"Cache-Control": "private, no-store",
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
		const response = handleApiError(
			err instanceof Error ? err : new ApiError("Media read failed", 500),
		);
		/* A cached denial is just as unsafe as cached bytes: after an app/asset
		 * move it could mask content the newly authorized Project may now read. */
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}
}

/**
 * DELETE /api/media/[assetId] — remove an asset from the owner's library.
 *
 * Project-gated (404 on missing OR non-member, so ids stay non-enumerable).
 * Refuses with a 409 — naming the carriers — if any persisted app (including a
 * recoverable soft-deleted app) still references the asset, so delete cannot
 * corrupt an exact later restore. On success it purges the asset row, the GCS
 * bytes, and the document-extract sibling (keeping shared bytes intact), then
 * returns 204. The deletion mechanics are shared with the SA's
 * `remove_media_asset` tool via `lib/media/assetDeletion`.
 *
 * Conversation attachments are persisted carriers too. The authoritative
 * deletion transaction scans thread history alongside the blueprint.
 */
export async function DELETE(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	try {
		const session = await requireSession(req);
		const { assetId: rawAssetId } = await params;
		const assetId = asAssetId(rawAssetId);

		const asset = await loadAssetById(assetId);
		if (
			!asset ||
			!(await userInProject(session.user.id, asset.project_id, "edit"))
		) {
			throw new ApiError(
				"We couldn't find that file — it may already have been deleted, or it isn't yours.",
				404,
			);
		}

		const deleted = await purgeAssetStorage(asset, {
			alsoDeleteForAsset: (deletedAsset) => [
				extractObjectKeyForAsset(deletedAsset),
			],
			deleteRow: async () => {
				const result = await deleteMediaAssetForActor({
					assetId,
					actorUserId: session.user.id,
					expectedProjectId: asset.project_id,
				});
				if (result.kind === "referenced") {
					throw new ApiError(
						`Can't delete this file — it's still used by ${result.references.join("; ")}. Swap the media or clear the slot in those apps, then delete it.`,
						409,
					);
				}
				return result.kind === "deleted" ? result.asset : false;
			},
		});
		if (!deleted) {
			throw new ApiError(
				"We couldn't find that file — it may already have been deleted, or it isn't yours.",
				404,
			);
		}

		return new Response(null, { status: 204 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Media delete failed", 500),
		);
	}
}
