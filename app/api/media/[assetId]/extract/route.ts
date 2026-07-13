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
 *     indicator can show. The response is a STREAM of NDJSON lines: `{type:"progress",
 *     chars}` per output chunk while the model runs (the client pulses the signal
 *     grid with real read progress), then one terminal `{type:"done", extract}`
 *     carrying the final `ExtractMeta` (ready / extracting / failed). Idempotent: a
 *     current ready extract emits `done` immediately with no progress; a job already
 *     in flight emits `done` with status `extracting` (`onInflight: "report"`) so the
 *     caller polls instead of this request holding open behind it. The model call
 *     runs to completion and persists even if the client disconnects mid-stream —
 *     progress writes are best-effort, the extract is not.
 *   - `GET` returns the stored extract text for the "What Nova reads" preview
 *     tab; 404 when no current-version extract exists yet (the client reads the
 *     `extracting`/`failed` status off the asset itself).
 *
 * Project-gated on every path (a non-member reads as 404, never enumerable).
 * Not on a chat run, so it passes the standalone extraction condenser rather than
 * a `GenerationContext` — the summarizer call's cost isn't folded into a run's usage
 * accumulator. It IS gated by the same monthly actual-cost backstop as the chat
 * route, though: a `POST` from a user already over budget 429s before any model
 * work, so eager extraction can't keep billing past the backstop.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
	createExtractionCondenser,
	EXTRACT_MAX_BYTES,
} from "@/lib/agent/documentExtraction";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import { normalizeExtractText } from "@/lib/agent/extractNormalization";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { userInProject } from "@/lib/db/appAccess";
import { ACTUAL_COST_BACKSTOP_USD } from "@/lib/db/creditPolicy";
import { loadAssetById } from "@/lib/db/mediaAssets";
import { getMonthlyUsage } from "@/lib/db/usage";
import {
	asAssetId,
	EXTRACTOR_VERSION,
	extractGcsObjectKeyFor,
	isDocumentKind,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { readTextObject } from "@/lib/storage/media";

/** High-effort reasoning over a large PDF runs for tens of seconds; give the
 *  extraction the same ceiling the chat run gets rather than the route default.
 *  This also bounds how long a `POST` can run as the claiming caller (the store
 *  treats an `extracting` record older than this as a dead job). */
export const maxDuration = 300;

/**
 * Load the asset, Project-gated, rejecting anything that can't be extracted: a
 * missing row or non-member (404), a non-document kind (400), or a
 * not-yet-validated upload (409 — the bytes must be `ready` before there's
 * anything to extract).
 */
async function loadExtractableDocument(req: NextRequest, rawAssetId: string) {
	const session = await requireSession(req);
	const assetId = asAssetId(rawAssetId);
	const asset = await loadAssetById(assetId);
	// A missing row OR a non-member both read as not-found so asset ids can't be
	// enumerated.
	if (
		!asset ||
		!(await userInProject(session.user.id, asset.project_id, "view"))
	) {
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
 * Produce (or fetch) the document's extract via the shared store and STREAM it as
 * NDJSON: `{type:"progress",chars}` per output chunk while the model runs, then one
 * `{type:"done",extract}` carrying the final `ExtractMeta`. Streaming is what lets
 * the client pulse the signal grid with real read progress. The store owns the
 * single-flight + persistence; a `failed` condense and a concurrent `extracting`
 * job both surface as the `done` line's status (the bytes are fine — the asset is
 * kept so a retry or the chat backstop can still cover it). Auth, kind/size, and
 * the spend-cap gate are checked BEFORE the stream opens, so those still reject as
 * normal JSON errors.
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

		// Gate eager extraction by the same monthly actual-cost backstop as the chat route — a
		// user over budget shouldn't keep triggering paid model calls. (The
		// content-hash cache already makes a repeat extraction of the same document
		// free; this bounds the distinct-document and failed-retry cost.) Fails
		// CLOSED, exactly like the chat route: if we can't read usage we can't rule
		// out being over budget, so a 503 is safer than risking uncapped spend — a
		// transient read error pauses extraction rather than waving it through.
		try {
			const usage = await getMonthlyUsage(session.user.id);
			// The larger of the token-math estimate and the gateway-metered
			// actual — same trip condition as the chat route, so the two
			// paid surfaces can't drift apart on when a month is over cap.
			const monthlySpend = Math.max(
				usage?.cost_estimate ?? 0,
				usage?.actual_cost ?? 0,
			);
			if (monthlySpend >= ACTUAL_COST_BACKSTOP_USD) {
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

		// Stream NDJSON: progress lines while the model runs, then one `done` line
		// with the final ExtractMeta. The model call persists inside the store
		// regardless of client connection, so progress writes are best-effort — a
		// thrown enqueue (client gone) must NOT bubble into `onProgress`, or it would
		// abort the textStream loop and mark a fine extraction failed.
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const write = (line: unknown) => {
					try {
						controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
					} catch {
						// Client disconnected — drop the line; extraction still persists.
					}
				};
				try {
					const result = await ensureStoredExtract({
						asset,
						documentKind,
						condenser: createExtractionCondenser(),
						// Eager fan-out surface: report an in-flight job rather than
						// waiting, so a concurrent caller gets a fast `done`/extracting and
						// polls instead of holding open behind the running job.
						onInflight: "report",
						onProgress: (chars) => write({ type: "progress", chars }),
					});
					if (result.status === "ready") {
						// Re-read for the persisted title/summary so the caller can refresh
						// its staged snapshot the instant extraction finishes (no re-fetch).
						const fresh = await loadAssetById(asset.id).catch(() => null);
						write({
							type: "done",
							extract: {
								status: "ready" as const,
								version: EXTRACTOR_VERSION,
								truncated: result.truncated,
								charCount: result.charCount,
								...(fresh?.extract?.title && { title: fresh.extract.title }),
								...(fresh?.extract?.summary && {
									summary: fresh.extract.summary,
								}),
							},
						});
					} else {
						// `extracting` (a concurrent job owns it) / `failed` (condense
						// failed) both ride the terminal line as the ExtractMeta status —
						// the caller polls again on `extracting`, surfaces a retry on `failed`.
						write({
							type: "done",
							extract: {
								status: result.status,
								version: EXTRACTOR_VERSION,
								truncated: false,
								charCount: 0,
							},
						});
					}
				} catch (err) {
					log.error("[media:extract] stream extraction failed", err);
					write({
						type: "done",
						extract: {
							status: "failed" as const,
							version: EXTRACTOR_VERSION,
							truncated: false,
							charCount: 0,
						},
					});
				} finally {
					try {
						controller.close();
					} catch {
						// Already closed (client disconnected) — nothing to do.
					}
				}
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson; charset=utf-8",
				"Cache-Control": "private, no-store",
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
			extractGcsObjectKeyFor(
				asset.project_id,
				asset.contentHash,
				EXTRACTOR_VERSION,
			),
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
		// Repair a double-escaped extract on the way out (`normalizeExtractText` — a
		// no-op on a clean one), so an extract stored before that repair existed
		// renders correctly in the preview without a re-extraction.
		return new NextResponse(normalizeExtractText(text), {
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
