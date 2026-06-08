/**
 * PUT /api/media/upload/bytes?key=<pendingObjectKey> — receive an upload's
 * bytes and write them to storage.
 *
 * Step 2 of the upload flow (initiate → THIS → confirm). After
 * `POST /api/media/upload` reserves the pending row, the browser PUTs the
 * file body here; the route streams it to the pending GCS key. Confirm then
 * validates the stored bytes and promotes them to the content-hash key.
 *
 * This route carries the one large body in the app (video, up to its kind
 * cap), which can exceed Cloud Run's 32 MiB HTTP/1 request limit — the
 * container fronts Next with an h2c nginx so the Cloud Run→container hop is
 * HTTP/2, which has no such limit.
 *
 * Defense in depth: session-gated, and the `key` must sit under the caller's
 * own `pending/<userId>/` namespace, so the route can't be coaxed into
 * writing into another owner's space or outside `pending/`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	ASSET_SIZE_CAPS_BYTES,
	PENDING_OBJECT_PREFIX,
} from "@/lib/domain/multimedia";
import {
	AssetUploadTooLargeError,
	uploadAssetStream,
} from "@/lib/storage/media";

/**
 * The abuse ceiling for a raw byte PUT: the largest any single kind allows
 * (video). The route doesn't know the asset's kind from the key alone, and
 * confirm re-checks the precise per-kind cap against the stored bytes — so
 * this is just the upper bound that keeps the streamed write from running
 * unbounded.
 */
const MAX_UPLOAD_BYTES = Math.max(...Object.values(ASSET_SIZE_CAPS_BYTES));

export async function PUT(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const key = new URL(req.url).searchParams.get("key");
		if (!key) {
			throw new ApiError(
				"The upload is missing its object key — the `key` query param names where the bytes land. The initiate step sets it; don't call this route directly.",
				400,
			);
		}

		// Owner guard: the browser only ever PUTs to its own per-attempt pending
		// key (`pending/<owner>/<assetId>.<ext>`). Reject anything else so this
		// route can't be coaxed into writing outside the caller's namespace.
		if (!key.startsWith(`${PENDING_OBJECT_PREFIX}${session.user.id}/`)) {
			throw new ApiError(
				"You can only upload to your own pending namespace.",
				403,
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
				gcsObjectKey: key,
				body: req.body,
				contentType,
				maxBytes: MAX_UPLOAD_BYTES,
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
