/**
 * Local-dev only — the browser's signed-PUT target during development.
 *
 * Production mints a real V4 signed URL straight to GCS (see
 * `lib/storage/media.ts::createSignedUploadUrl`), signed by the runtime
 * service account. A developer's Application Default Credentials are a
 * user credential with no private key, so they cannot mint that
 * signature — the browser PUTs the bytes here instead and the server
 * writes them to the dev bucket through its own storage client. This
 * keeps the rest of the upload flow (initiate → PUT → confirm →
 * validate → promote) byte-identical to prod; only the signed-PUT hop
 * is swapped for this same-origin proxy.
 *
 * Hard-gated on `NODE_ENV`: the route 404s outside development, so this
 * surface cannot exist in production. It is still session-gated and
 * scoped to the caller's own pending namespace as defense-in-depth.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { uploadAssetBytes } from "@/lib/storage/media";

export async function PUT(req: NextRequest) {
	try {
		// Prod-safety: this proxy exists only in local development.
		if (process.env.NODE_ENV !== "development") {
			throw new ApiError("Not found", 404);
		}

		const session = await requireSession(req);
		const key = new URL(req.url).searchParams.get("key");
		if (!key) {
			throw new ApiError(
				"The upload is missing its object key — the `key` query param names where the bytes land. The initiate step sets it; don't call this route directly.",
				400,
			);
		}

		// Owner guard: the browser only ever PUTs to its own per-attempt
		// pending key (`pending/<owner>/<assetId>.<ext>`). Reject anything
		// else so this dev route can't be coaxed into writing outside the
		// caller's namespace.
		if (!key.startsWith(`pending/${session.user.id}/`)) {
			throw new ApiError(
				"You can only upload to your own pending namespace.",
				403,
			);
		}

		const contentType =
			req.headers.get("content-type") ?? "application/octet-stream";
		const bytes = Buffer.from(await req.arrayBuffer());
		await uploadAssetBytes({ gcsObjectKey: key, bytes, contentType });

		return new NextResponse(null, { status: 200 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Dev upload failed"),
		);
	}
}
