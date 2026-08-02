/**
 * Local-dev only: the browser's signed-PUT target during development.
 *
 * Production mints a real V4 signed URL straight to GCS (see
 * `lib/storage/media.ts::createSignedUploadUrl`), signed by the runtime
 * service account. A developer's Application Default Credentials are a
 * user credential with no private key, so they cannot mint that
 * signature: the browser PUTs the bytes here instead and the server
 * writes them to the dev bucket through its own storage client. This
 * keeps the rest of the upload flow (initiate → PUT → confirm →
 * validate → promote) byte-identical to prod; only the signed-PUT hop
 * is swapped for this same-origin proxy.
 *
 * Hard-gated on `NODE_ENV`: the route 404s outside development, so this
 * surface cannot exist in production. It is still session-gated and
 * scoped to Projects the caller can edit as defense-in-depth.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { authorizePendingFormAttachmentUpload } from "@/lib/db/formAttachments";
import { STAGED_CAPTURE_PREFIX } from "@/lib/domain/captureFormats";
import { PENDING_OBJECT_PREFIX } from "@/lib/domain/multimedia";
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
				"The upload is missing its object key, the `key` query param names where the bytes land. The initiate step sets it; don't call this route directly.",
				400,
			);
		}

		// Tenant guard: the initiate step mints keys shaped
		// `pending/<projectId>/<assetId>.<ext>` (`pendingGcsObjectKeyFor`), and
		// the Project segment is the tenant the bytes land in. Re-gate `edit`
		// membership on that Project: the same check initiate ran before
		// handing out this URL, so the dev route can't be coaxed into writing
		// into a Project the caller can't edit. (Prod needs no equivalent: a V4
		// signature only exists for keys the server itself minted.)
		const segments = key.split("/");
		const [prefix, projectId, objectName] = segments;
		const objectPrefix = `${prefix}/`;
		if (
			segments.length !== 3 ||
			(objectPrefix !== PENDING_OBJECT_PREFIX &&
				objectPrefix !== STAGED_CAPTURE_PREFIX) ||
			!projectId ||
			!objectName
		) {
			throw new ApiError(
				`The object key \`${key}\` doesn't look like an upload-attempt key, the initiate step mints \`${PENDING_OBJECT_PREFIX}<projectId>/<assetId>.<ext>\` or \`${STAGED_CAPTURE_PREFIX}<projectId>/<attachmentId>.<ext>\`. Don't call this route directly.`,
				400,
			);
		}
		const contentType =
			req.headers.get("content-type") ?? "application/octet-stream";
		const bytes = Buffer.from(await req.arrayBuffer());
		let max: number | null = null;
		if (objectPrefix === STAGED_CAPTURE_PREFIX) {
			const pending = await authorizePendingFormAttachmentUpload({
				objectKey: key,
				actorUserId: session.user.id,
			});
			if (pending === null || pending.contentType !== contentType) {
				throw new ApiError("Upload attempt not found", 404);
			}
			max = pending.maxBytes;
		} else {
			try {
				await resolveProjectAccess(session.user.id, projectId, "edit");
			} catch (err) {
				if (err instanceof AppAccessError) {
					throw new ApiError(
						"This upload targets a Project you can't edit, the pending key's Project segment must name a Project you hold edit access in.",
						403,
					);
				}
				throw err;
			}
		}

		// Enforce the per-kind byte cap that prod binds onto the signed PUT via
		// `x-goog-content-length-range`. The proxy writes the bytes itself, so
		// there's no GCS-side range check: this keeps dev byte-identical to the
		// prod boundary rejection of an oversized write. The legit producer
		// (`createSignedUploadUrl`) always appends `&max=<positive int>`. Handle
		// the edges explicitly: ABSENT → no cap (skip, don't 413 on the
		// `Number(null)===0` trap); PRESENT-but-not-a-positive-number → 400
		// (don't silently fail open on `?max=` or `?max=abc`); valid → enforce.
		const maxParam = new URL(req.url).searchParams.get("max");
		if (objectPrefix !== STAGED_CAPTURE_PREFIX && maxParam !== null) {
			const parsedMax = Number(maxParam);
			if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
				throw new ApiError(
					"dev-put: `max` must be a positive byte count.",
					400,
				);
			}
			max = parsedMax;
		}
		if (
			max !== null &&
			(objectPrefix === STAGED_CAPTURE_PREFIX
				? bytes.length !== max
				: bytes.length > max)
		) {
			throw new ApiError(
				objectPrefix === STAGED_CAPTURE_PREFIX
					? `Upload is ${bytes.length} bytes, but this capture attempt declared exactly ${max} bytes.`
					: `Upload is ${bytes.length} bytes, over the ${max}-byte cap for this attempt.`,
				413,
			);
		}

		try {
			await uploadAssetBytes({
				gcsObjectKey: key,
				bytes,
				contentType,
				ifAbsent: true,
			});
		} catch (err) {
			if ((err as { code?: number } | null)?.code === 412) {
				throw new ApiError(
					"This upload attempt was already used. Attach the file again.",
					412,
				);
			}
			throw err;
		}

		return new NextResponse(null, { status: 200 });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Dev upload failed"),
		);
	}
}
