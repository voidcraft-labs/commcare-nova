/**
 * `/api/media/[assetId]/extract` — a document's requirements extract.
 *
 * Documents (pdf/text/docx/xlsx) are condensed ONCE into the structured extract
 * the Solutions Architect actually reads, stored as a GCS sibling object keyed
 * by content hash + extractor version. This route owns producing and serving it:
 *
 *   - `POST` runs the extraction (Gemini), writes the text to GCS, and records
 *     the status/metadata on the asset doc. Triggered eagerly by the file
 *     manager after a document upload (so the extraction indicator can show),
 *     and as the chat resolve step's lazy backstop. Idempotent: a current
 *     ready extract is returned without re-running the model.
 *   - `GET` returns the stored extract text for the "What the AI reads" preview
 *     tab; 404 when no current-version extract exists yet (the client reads the
 *     `extracting`/`failed` status off the asset itself).
 *
 * Owner-gated on every path (a foreign asset reads as 404, never enumerable).
 * Not on a chat run, so it uses the standalone Gemini condenser rather than a
 * `GenerationContext`; the extraction is a cheap Flash call, deliberately not
 * metered against the chat spend cap (the media subsystem has no usage
 * accumulator, and a per-(hash, version) extract runs at most once).
 */

import { type NextRequest, NextResponse } from "next/server";
import {
	CONDENSER_MODEL,
	createGeminiCondenser,
	EXTRACT_MAX_BYTES,
	EXTRACTOR_VERSION,
	extractDocument,
} from "@/lib/agent/documentExtraction";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	loadAssetForOwner,
	MediaAssetOwnershipError,
	setAssetExtractStatus,
} from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	asAssetId,
	extractGcsObjectKeyFor,
	isDocumentKind,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import {
	downloadAssetBytes,
	readTextObject,
	writeTextObject,
} from "@/lib/storage/media";

/** Gemini high-reasoning over a large PDF runs for tens of seconds; give the
 *  extraction the same ceiling the chat run gets rather than the route default. */
export const maxDuration = 300;

/**
 * Load the asset, owner-gated, rejecting anything that can't be extracted: a
 * missing/foreign row (404), a non-document kind (400), or a not-yet-validated
 * upload (409 — the bytes must be `ready` before there's anything to extract).
 */
async function loadExtractableDocument(req: NextRequest, rawAssetId: string) {
	const session = await requireSession(req);
	const assetId = asAssetId(rawAssetId);
	const asset = await loadAssetForOwner(session.user.id, assetId).catch(
		(err: unknown) => {
			// Foreign owner reads as not-found so asset ids can't be enumerated.
			if (err instanceof MediaAssetOwnershipError) return null;
			throw err;
		},
	);
	if (!asset) {
		throw new ApiError(
			"We couldn't find that file — it may have been deleted, or it isn't yours.",
			404,
		);
	}
	// Capture into a const so the type guard narrows a value that survives the
	// return (a guard on `asset.kind` would re-widen on the next property read).
	const kind = asset.kind;
	if (!isDocumentKind(kind)) {
		throw new ApiError(
			`Feature extraction only applies to documents (PDF, text, Word, Excel). This file is ${kind}, which the assistant reads directly.`,
			400,
		);
	}
	if (asset.status !== "ready") {
		throw new ApiError(
			"This document is still uploading — its features can't be extracted until the upload finishes. Try again in a moment.",
			409,
		);
	}
	return { session, assetId, asset, documentKind: kind };
}

/**
 * Produce (or refresh) the document's extract. Marks `extracting` before the
 * model call so a concurrent library read reflects it, runs the extractor,
 * stores the text in GCS, and records `ready`. On failure records `failed` with
 * the reason and surfaces a 502 — the bytes are fine, only the condense failed,
 * so the asset is kept and the chat resolve step's raw-inline fallback covers it.
 */
export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	const { assetId: rawAssetId } = await params;
	try {
		const { assetId, asset, documentKind } = await loadExtractableDocument(
			req,
			rawAssetId,
		);

		// Idempotent: a current-version ready extract needs no re-run. A stale
		// version (a prompt/model bump) or a prior `failed`/`extracting` falls
		// through and re-extracts.
		if (
			asset.extract?.status === "ready" &&
			asset.extract.version === EXTRACTOR_VERSION
		) {
			return NextResponse.json({
				ok: true,
				extract: {
					status: "ready" as const,
					version: asset.extract.version,
					truncated: asset.extract.truncated,
					charCount: asset.extract.charCount,
				},
			});
		}

		await setAssetExtractStatus(assetId, {
			status: "extracting",
			version: EXTRACTOR_VERSION,
			model: CONDENSER_MODEL,
			truncated: false,
			charCount: 0,
		});

		try {
			const bytes = await downloadAssetBytes(
				asset.gcsObjectKey,
				ASSET_SIZE_CAPS_BYTES[asset.kind],
			);
			const { text, truncated } = await extractDocument({
				bytes,
				mimeType: asset.mimeType,
				kind: documentKind,
				filename: asset.originalFilename,
				condenser: createGeminiCondenser(),
			});
			await writeTextObject(
				extractGcsObjectKeyFor(
					asset.owner,
					asset.contentHash,
					EXTRACTOR_VERSION,
				),
				text,
			);
			await setAssetExtractStatus(assetId, {
				status: "ready",
				version: EXTRACTOR_VERSION,
				model: CONDENSER_MODEL,
				truncated,
				charCount: text.length,
			});
			return NextResponse.json({
				ok: true,
				extract: {
					status: "ready" as const,
					version: EXTRACTOR_VERSION,
					truncated,
					charCount: text.length,
				},
			});
		} catch (extractErr) {
			const failureReason =
				extractErr instanceof Error ? extractErr.message : String(extractErr);
			await setAssetExtractStatus(assetId, {
				status: "failed",
				version: EXTRACTOR_VERSION,
				model: CONDENSER_MODEL,
				truncated: false,
				charCount: 0,
				failureReason,
			}).catch((statusErr: unknown) => {
				log.error("[media:extract] failed-status write failed", {
					assetId,
					statusErr,
				});
			});
			throw new ApiError(
				"We couldn't read the features out of this document. The file is saved — you can try extracting again, or paste the key details into the chat.",
				502,
			);
		}
	} catch (err) {
		if (!(err instanceof ApiError)) {
			log.error("[media:extract] unhandled POST", err);
		}
		return handleApiError(
			err instanceof Error ? err : new ApiError("Extraction failed", 500),
		);
	}
}

/**
 * Serve the stored extract text for the "What the AI reads" preview tab. 404
 * when no current-version extract exists yet — the client reads the
 * `extracting`/`failed` status off the asset itself and only fetches the body
 * once it's `ready`. CSP `sandbox` + `nosniff` mirror the bytes route's
 * defense-in-depth even though markdown text is inert.
 */
export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	const { assetId: rawAssetId } = await params;
	try {
		const { asset } = await loadExtractableDocument(req, rawAssetId);
		if (
			asset.extract?.status !== "ready" ||
			asset.extract.version !== EXTRACTOR_VERSION
		) {
			throw new ApiError(
				"This document hasn't been extracted yet (or its extract is being refreshed). Check back once extraction finishes.",
				404,
			);
		}
		const text = await readTextObject(
			extractGcsObjectKeyFor(asset.owner, asset.contentHash, EXTRACTOR_VERSION),
			EXTRACT_MAX_BYTES,
		);
		if (text === null) {
			// The doc says ready but the object is gone — treat as not-found so the
			// client can re-trigger a POST rather than 500.
			throw new ApiError(
				"This document's extract is missing — try extracting it again.",
				404,
			);
		}
		return new NextResponse(text, {
			headers: {
				"Content-Type": "text/markdown; charset=utf-8",
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "sandbox",
			},
		});
	} catch (err) {
		if (!(err instanceof ApiError)) {
			log.error("[media:extract] unhandled GET", err);
		}
		return handleApiError(
			err instanceof Error ? err : new ApiError("Extract read failed", 500),
		);
	}
}
