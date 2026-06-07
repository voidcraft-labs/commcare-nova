/**
 * `/api/media/[assetId]/extract` — a document's requirements extract.
 *
 * Documents (pdf/text/docx/xlsx) are condensed ONCE into the structured extract
 * the Solutions Architect actually reads, stored as a GCS sibling object keyed
 * by content hash + extractor version. This route is the HTTP face of that:
 *
 *   - `POST` resolves the extract through `ensureStoredExtract` — the shared
 *     single-flight store that BOTH this eager route and the chat resolve step's
 *     lazy backstop go through (so the lock lives in one place). Triggered
 *     eagerly by the file manager after a document upload, so the extraction
 *     indicator can show. Idempotent: a current ready extract returns without
 *     re-running the model; a current job already in flight short-circuits with
 *     202 (`onInflight: "report"`) so this request doesn't hold open behind it.
 *   - `GET` returns the stored extract text for the "What Nova reads" preview
 *     tab; 404 when no current-version extract exists yet (the client reads the
 *     `extracting`/`failed` status off the asset itself).
 *
 * Owner-gated on every path (a foreign asset reads as 404, never enumerable).
 * Not on a chat run, so it passes the standalone Gemini condenser rather than a
 * `GenerationContext` — the Flash call's cost isn't folded into a run's usage
 * accumulator. It IS gated by the same monthly spend cap as the chat route,
 * though: a `POST` from a user already over budget 429s before any model work,
 * so eager extraction can't keep billing past the cap.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
	createGeminiCondenser,
	EXTRACT_MAX_BYTES,
} from "@/lib/agent/documentExtraction";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	loadAssetForOwner,
	MediaAssetOwnershipError,
} from "@/lib/db/mediaAssets";
import { getMonthlyUsage, MONTHLY_SPEND_CAP_USD } from "@/lib/db/usage";
import {
	asAssetId,
	EXTRACTOR_VERSION,
	extractGcsObjectKeyFor,
	isDocumentKind,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { readTextObject } from "@/lib/storage/media";

/** Gemini high-reasoning over a large PDF runs for tens of seconds; give the
 *  extraction the same ceiling the chat run gets rather than the route default.
 *  This also bounds how long a `POST` can run as the claiming caller (the store
 *  treats an `extracting` record older than this as a dead job). */
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
			`Feature extraction only applies to documents (PDF, text, Word, Excel). This file is ${kind}, which Nova reads directly.`,
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
 * Produce (or fetch) the document's extract via the shared store, then map its
 * result to the wire envelope. The store owns the single-flight + persistence;
 * here we only translate: `ready` → 200 with metadata, `extracting` → 202 (a
 * concurrent job owns it — don't hold this request open), `failed` → 502 (the
 * bytes are fine, only the condense failed; the asset is kept so the chat
 * resolve step's inline fallback or a retry can still cover it).
 */
export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	const { assetId: rawAssetId } = await params;
	try {
		const { session, asset, documentKind } = await loadExtractableDocument(
			req,
			rawAssetId,
		);

		// Gate eager extraction by the same monthly spend cap as the chat route — a
		// user over budget shouldn't keep triggering paid model calls. (The
		// content-hash cache already makes a repeat extraction of the same document
		// free; this bounds the distinct-document and failed-retry cost.) Fails
		// CLOSED, exactly like the chat route: if we can't read usage we can't rule
		// out being over budget, so a 503 is safer than risking uncapped spend — a
		// transient read error pauses extraction rather than waving it through.
		try {
			const usage = await getMonthlyUsage(session.user.id);
			if ((usage?.cost_estimate ?? 0) >= MONTHLY_SPEND_CAP_USD) {
				throw new ApiError(
					"You've reached this month's usage limit, so document extraction is paused until it resets. Your file is still saved.",
					429,
				);
			}
		} catch (err) {
			// A deliberate 429 (over cap) propagates untouched; only an unexpected
			// read failure maps to 503.
			if (err instanceof ApiError) throw err;
			throw new ApiError(
				"We couldn't check your usage just now, so extraction is paused for a moment. Try again shortly — your file is still saved.",
				503,
			);
		}

		const result = await ensureStoredExtract({
			asset,
			documentKind,
			condenser: createGeminiCondenser(),
			// Eager fan-out surface: report an in-flight job rather than waiting,
			// so the badge's poll gets a fast 202 instead of a held-open request.
			onInflight: "report",
		});

		if (result.status === "extracting") {
			return NextResponse.json(
				{
					ok: true,
					extract: {
						status: "extracting" as const,
						version: EXTRACTOR_VERSION,
						truncated: false,
						charCount: 0,
					},
				},
				{ status: 202 },
			);
		}

		if (result.status === "failed") {
			throw new ApiError(
				"We couldn't read the features out of this document. The file is saved — you can try extracting again, or paste the key details into the chat.",
				502,
			);
		}

		// Re-read the asset so the response carries the persisted title/summary.
		// `ensureStoredExtract` returns the extract TEXT, not the metadata it wrote
		// to the doc — and the caller (the file-manager / composer badge) needs the
		// title + summary to refresh its staged snapshot the instant extraction
		// finishes, so the chip preview shows them without a re-fetch. A failed
		// re-read just omits them (the snapshot stays as-is, no worse than before).
		const fresh = await loadAssetForOwner(session.user.id, asset.id).catch(
			() => null,
		);
		return NextResponse.json({
			ok: true,
			extract: {
				status: "ready" as const,
				version: EXTRACTOR_VERSION,
				truncated: result.truncated,
				charCount: result.charCount,
				...(fresh?.extract?.title && { title: fresh.extract.title }),
				...(fresh?.extract?.summary && { summary: fresh.extract.summary }),
			},
		});
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
 * Serve the stored extract text for the "What Nova reads" preview tab. 404
 * when no current-version extract exists yet — the client reads the
 * `extracting`/`failed` status off the asset itself and only fetches the body
 * once it's `ready`. CSP `sandbox` + `nosniff` mirror the bytes route's
 * defense-in-depth even though markdown text is inert.
 *
 * `?meta=1` returns the extract's header metadata as JSON ({ status, title,
 * summary }) instead of the body — a cheap asset-doc read, no GCS fetch. The
 * preview uses it to fill its header when the in-band snapshot lacks the
 * title/summary (a message attachment sent before extraction finished froze its
 * ref empty), so the header is correct without re-resolving the whole extract.
 */
export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ assetId: string }> },
) {
	const { assetId: rawAssetId } = await params;
	try {
		const { asset } = await loadExtractableDocument(req, rawAssetId);

		if (new URL(req.url).searchParams.get("meta") === "1") {
			const ready =
				asset.extract?.status === "ready" &&
				asset.extract.version === EXTRACTOR_VERSION;
			return NextResponse.json({
				status: asset.extract?.status ?? null,
				...(ready && asset.extract?.title && { title: asset.extract.title }),
				...(ready &&
					asset.extract?.summary && { summary: asset.extract.summary }),
			});
		}

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
