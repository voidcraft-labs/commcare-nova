/**
 * POST /api/media/upload — initiate a media upload.
 *
 * Two-step pattern. Step 1 (this route): the browser declares what
 * it wants to upload (filename, MIME, size, sha256 hash) BEFORE
 * pushing bytes. The server:
 *
 *   - validates session + the declared metadata
 *   - checks for a (owner, hash) match in the asset library — on
 *     hit, returns the existing assetId and tells the browser to
 *     skip the bytes-PUT entirely (dedup-skip-the-upload)
 *   - on miss, creates a `pending` Firestore row and a signed PUT
 *     URL the browser uses to push bytes directly to GCS
 *
 * Step 2 lives at `[assetId]/confirm/route.ts` — the browser calls
 * it after the PUT completes, and the server re-validates the
 * stored bytes from GCS before flipping the row to `ready`.
 *
 * Why a separate step for hash claim: SubtleCrypto can compute the
 * sha256 in the browser before initiating, which means the dedup
 * check happens BEFORE bytes leave the client. Saves an entire
 * upload round-trip when the file is already in the user's
 * library.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	createPendingAsset,
	findReadyAssetByOwnerAndHash,
	toWireMediaAsset,
} from "@/lib/db/mediaAssets";
import {
	ALL_MIME_TYPES,
	EXTENSION_FOR_MIME_TYPE,
	gcsObjectKeyFor,
	MEDIA_SIZE_CAPS_BYTES,
	mediaKindForMimeType,
	normalizeMimeType,
} from "@/lib/domain/multimedia";
import { createSignedUploadUrl } from "@/lib/storage/media";

const requestBodySchema = z
	.object({
		filename: z.string().min(1).max(255),
		// Accepted as a free string and normalized below, not
		// `z.enum(ALL_MIME_TYPES)` — a browser's `File.type` can be an
		// alias (`image/apng` for an animated `.png`) or codec-
		// parameterized (`video/mp4; codecs=...`); `normalizeMimeType`
		// reconciles both to a canonical accepted type.
		mimeType: z.string().min(1),
		sizeBytes: z.number().int().positive(),
		contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const body = await req.json().catch(() => null);
		const parsed = requestBodySchema.safeParse(body);
		if (!parsed.success) {
			throw new ApiError(
				"Upload request couldn't be parsed — make sure filename, mimeType, sizeBytes, and contentHash are all present and well-formed.",
				400,
				parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
			);
		}
		const { filename, sizeBytes, contentHash } = parsed.data;

		// Normalize the claimed MIME to its canonical accepted form
		// (handles browser alias spellings); reject if it isn't an
		// accepted media type.
		const mimeType = normalizeMimeType(parsed.data.mimeType);
		if (!mimeType) {
			throw new ApiError(
				`MIME type \`${parsed.data.mimeType}\` isn't one we accept. Accepted types: ${ALL_MIME_TYPES.join(", ")}.`,
				400,
			);
		}

		// Per-kind size cap before any storage round trip. The
		// validator runs the same check again at confirm time against
		// the actual bytes — this is the cheap up-front rejection.
		const kind = mediaKindForMimeType(mimeType);
		if (!kind) {
			throw new ApiError(
				`MIME type \`${mimeType}\` isn't one we accept. Accepted types: ${ALL_MIME_TYPES.join(", ")}.`,
				400,
			);
		}
		const cap = MEDIA_SIZE_CAPS_BYTES[kind];
		if (sizeBytes > cap) {
			const capMb = (cap / 1024 / 1024).toFixed(0);
			const actualMb = (sizeBytes / 1024 / 1024).toFixed(2);
			throw new ApiError(
				`\`${filename}\` is ${actualMb} MB, but ${kind} uploads are capped at ${capMb} MB. Compress the file and try again.`,
				400,
			);
		}

		// Dedup probe — if the owner already has this exact content
		// hash as a `ready` asset, return it and skip the bytes push.
		// The browser sees `deduplicated: true` and attaches the
		// returned asset to its target carrier without a second round
		// trip — so the full wire asset is included, not just the id.
		const existing = await findReadyAssetByOwnerAndHash(
			session.user.id,
			contentHash,
		);
		if (existing) {
			return NextResponse.json({
				assetId: existing.id,
				deduplicated: true,
				asset: toWireMediaAsset(existing),
			});
		}

		// New blob. Reserve the row first (so the confirm step has
		// something to look up), then mint the signed URL.
		const extension = EXTENSION_FOR_MIME_TYPE[mimeType];
		const gcsObjectKey = gcsObjectKeyFor(
			session.user.id,
			contentHash,
			extension,
		);
		const assetId = await createPendingAsset({
			owner: session.user.id,
			contentHash,
			mimeType,
			kind,
			extension,
			sizeBytes,
			gcsObjectKey,
			originalFilename: filename,
		});
		const { url, expiresAtMs } = await createSignedUploadUrl({
			gcsObjectKey,
			contentType: mimeType,
		});

		return NextResponse.json({
			assetId,
			deduplicated: false,
			uploadUrl: url,
			// The signed URL is bound to the NORMALIZED `mimeType`, not
			// the client's raw `File.type` (which may be an alias like
			// `image/apng`). The browser must send this exact value as
			// the PUT `Content-Type`, or GCS rejects the signature.
			uploadContentType: mimeType,
			expiresAtMs,
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Upload initiate failed", 500),
		);
	}
}
