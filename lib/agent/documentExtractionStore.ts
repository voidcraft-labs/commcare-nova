// lib/agent/documentExtractionStore.ts
//
// The durable, single-flight STORE for a document's requirements extract — the
// one entry point every caller goes through to turn a document into the stored
// extract the Solutions Architect reads. It owns the lock so the lock lives in
// exactly one place.
//
// Two callers drive extraction, and they used to each carry their OWN copy of
// "produce or fetch the extract":
//   - the eager upload-time route (`POST /api/media/[assetId]/extract`), fired
//     by the file-manager extraction badge, and
//   - the chat resolve step's lazy backstop (`resolveAttachments`).
// The route had the real single-flight (claim `extracting` in Firestore, 202 a
// job already in flight); the backstop had a dumber copy that read the GCS
// object directly and, on a miss, just ran its OWN extraction — never consulting
// the `extracting` status, so it couldn't see the eager job and double-billed
// the model. This module is the un-duplication: both callers now call
// `ensureStoredExtract`, so there is no second path that can bypass the lock.
//
// `extractDocument` (in `documentExtraction.ts`) stays the pure bytes→text core;
// THIS module is the impure half — Firestore status + GCS object + the
// single-flight policy — composed over it.

import {
	claimExtractionIfIdle,
	loadAssetForOwner,
	MediaAssetOwnershipError,
	type MediaAssetRecord,
	setAssetExtractStatus,
} from "@/lib/db/mediaAssets";
import {
	ASSET_SIZE_CAPS_BYTES,
	type AssetId,
	type DocumentKind,
	EXTRACTOR_VERSION,
	extractGcsObjectKeyFor,
	type MediaExtractStatus,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import {
	downloadAssetBytes,
	readTextObject,
	writeTextObject,
} from "@/lib/storage/media";
import {
	type AttachmentCondenser,
	CONDENSER_MODEL,
	EXTRACT_MAX_BYTES,
	extractDocument,
} from "./documentExtraction";

/**
 * An `extracting` record older than this is presumed dead — a job whose process
 * was reclaimed past its deadline before it could record `ready`/`failed`. Past
 * this age the record stops being treated as a live job: a fresh trigger
 * re-claims it, and a waiter stops waiting and takes over rather than blocking
 * forever behind a tombstone. Matches the extract route's `maxDuration` (300s):
 * a job that legitimately ran would have completed or timed out by then.
 */
export const EXTRACTING_STALE_MS = 300_000;

/** How often the chat send-path re-checks an extraction another request owns
 *  while waiting for it (see `onInflight: "wait"`). */
const INFLIGHT_POLL_MS = 1_500;

/**
 * The result of resolving a document's stored extract:
 *   - `ready`      — the extract text, ready for the SA (or the route response).
 *   - `extracting` — a different current job owns it; only returned under
 *     `onInflight: "report"` (the HTTP route 202s its pollers). The `"wait"`
 *     policy never returns this — it polls the job to a terminal state.
 *   - `failed`     — extraction itself failed (the bytes are fine; the condense
 *     step threw). The route maps this to a 502; the chat backstop turns it into
 *     a never-drop placeholder.
 */
export type StoredExtractResult =
	| { status: "ready"; text: string; truncated: boolean; charCount: number }
	| { status: "extracting" }
	| { status: "failed"; reason: string };

/** The minimal status snapshot the single-flight policy reasons over. Kept as a
 *  plain shape (milliseconds, not a Firestore `Timestamp`) so the policy is a
 *  pure function unit-testable without touching Firestore. */
interface ExtractStatusSnapshot {
	status: MediaExtractStatus;
	version: number;
	extractedAtMs: number;
}

/**
 * The single-flight policy, as a pure function: given the current extract status
 * (or `null` when there is none) and the current time, decide whether a
 * DIFFERENT live job already owns this extraction — in which case we must not
 * run our own — or whether the field is ours to claim.
 *
 * Only a CURRENT-version, non-stale `extracting` record counts as a live job.
 * Everything else — never extracted, `failed`, `ready` (the byte object was
 * missing, see the caller), a stale-version `extracting` (a prompt/model bump),
 * or a tombstone (`extracting` older than `EXTRACTING_STALE_MS`) — means no live
 * job is producing the current extract, so the caller should produce it.
 */
export function decideExtractAction(
	snapshot: ExtractStatusSnapshot | null,
	nowMs: number,
): "await-inflight" | "extract-now" {
	if (
		snapshot !== null &&
		snapshot.status === "extracting" &&
		snapshot.version === EXTRACTOR_VERSION &&
		nowMs - snapshot.extractedAtMs < EXTRACTING_STALE_MS
	) {
		return "await-inflight";
	}
	return "extract-now";
}

/** Build the `ready` result from already-fetched extract text. `charCount` is
 *  the text's own length (authoritative — the same bytes the SA receives). */
function readyResult(text: string, truncated: boolean): StoredExtractResult {
	return { status: "ready", text, truncated, charCount: text.length };
}

/**
 * Re-read the asset's extract status FRESH from Firestore, normalized to the
 * pure-policy snapshot. The record handed to `ensureStoredExtract` may be a
 * turn-start batch snapshot that predates an eager job's claim, so the
 * single-flight decision must read current status rather than trust it.
 *
 * Degrades to `null` (→ "no live job" → we extract) on any read failure: a
 * foreign-owner throw can't legitimately happen here (the asset was already
 * loaded owner-gated) and a transient Firestore error must not break the turn —
 * extracting ourselves is the safe fallback.
 */
async function reloadExtractStatus(
	owner: string,
	assetId: AssetId,
): Promise<{ snapshot: ExtractStatusSnapshot; truncated: boolean } | null> {
	const fresh = await loadAssetForOwner(owner, assetId).catch(
		(err: unknown) => {
			if (!(err instanceof MediaAssetOwnershipError)) {
				log.warn("[extract-store] status reload failed", { assetId, err });
			}
			return null;
		},
	);
	const extract = fresh?.extract;
	if (!extract) return null;
	return {
		snapshot: {
			status: extract.status,
			version: extract.version,
			extractedAtMs: extract.extractedAt.toMillis(),
		},
		truncated: extract.truncated,
	};
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a different in-flight job to produce the extract, reusing its result
 * instead of running a second model call. The wait is naturally bounded by the
 * staleness rule: each poll re-reads status, and once the job either finishes
 * (`ready`/`failed`) or its record ages past `EXTRACTING_STALE_MS` (the process
 * died), the loop ends. Returns the extract on success, or `null` to signal the
 * caller should produce it itself (the job failed, went stale, or wrote `ready`
 * but its byte object is gone).
 *
 * This is never slower than extracting from scratch: the in-flight job started
 * when the document was attached — before this send — so it always has a head
 * start. Every read is failure-tolerant; a hiccup just falls through to `null`
 * and the caller's own extraction covers it.
 */
async function waitForInflight(
	owner: string,
	assetId: AssetId,
	key: string,
): Promise<StoredExtractResult | null> {
	let waiting = true;
	while (waiting) {
		await sleep(INFLIGHT_POLL_MS);
		const fresh = await reloadExtractStatus(owner, assetId);
		if (!fresh) return null; // record vanished / unreadable → we take over
		if (
			fresh.snapshot.status === "ready" &&
			fresh.snapshot.version === EXTRACTOR_VERSION
		) {
			const text = await readTextObject(key, EXTRACT_MAX_BYTES).catch(
				() => null,
			);
			// `ready` but the object is missing → treat as a miss and take over.
			return text !== null ? readyResult(text, fresh.truncated) : null;
		}
		if (decideExtractAction(fresh.snapshot, Date.now()) === "extract-now") {
			// Failed, stale (dead process), or version drift → stop waiting.
			waiting = false;
		}
		// Otherwise still a live current job → poll again.
	}
	return null;
}

/**
 * Run the model and persist the result — GCS text first (the source of truth the
 * fast path reads), then the `ready`/`failed` status. The caller has already
 * acquired the lock (`claimExtractionIfIdle` wrote `extracting`); this only runs
 * the model and records the outcome. Status writes are best-effort: the extract
 * TEXT in GCS is what the fast path and the SA actually read, so a status-write
 * hiccup must not fail the turn — it only weakens the UI indicator, which
 * self-heals.
 */
async function runExtraction(opts: {
	asset: MediaAssetRecord;
	documentKind: DocumentKind;
	condenser: AttachmentCondenser;
	key: string;
	onProgress?: (deltaChars: number) => void;
}): Promise<StoredExtractResult> {
	const { asset, documentKind, condenser, key, onProgress } = opts;

	try {
		const bytes = await downloadAssetBytes(
			asset.gcsObjectKey,
			ASSET_SIZE_CAPS_BYTES[asset.kind],
		);
		const { extract, truncated, title, summary } = await extractDocument({
			bytes,
			mimeType: asset.mimeType,
			kind: documentKind,
			filename: asset.originalFilename,
			condenser,
			onProgress,
		});
		// The extract TEXT is the source of truth (GCS); title/summary are small
		// best-effort metadata persisted on the asset doc for a future browse tool.
		await writeTextObject(key, extract);
		await setAssetExtractStatus(asset.id, {
			status: "ready",
			version: EXTRACTOR_VERSION,
			model: CONDENSER_MODEL,
			truncated,
			charCount: extract.length,
			title,
			summary,
		}).catch((err: unknown) =>
			log.warn("[extract-store] ready write failed", {
				assetId: asset.id,
				err,
			}),
		);
		return readyResult(extract, truncated);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		await setAssetExtractStatus(asset.id, {
			status: "failed",
			version: EXTRACTOR_VERSION,
			model: CONDENSER_MODEL,
			truncated: false,
			charCount: 0,
			failureReason: reason,
		}).catch((statusErr: unknown) =>
			log.error("[extract-store] failed-status write failed", {
				assetId: asset.id,
				statusErr,
			}),
		);
		return { status: "failed", reason };
	}
}

/**
 * Resolve a document's stored requirements extract — the single entry point for
 * BOTH the eager route and the chat send-path backstop, so the single-flight
 * lock lives in one place and can't be bypassed.
 *
 * Flow:
 *   1. Read the current-version extract from GCS — the cheap hot path: a
 *      document already extracted (the common case after the eager job ran)
 *      resolves in one read.
 *   2. On a miss, read the status fresh and apply `decideExtractAction`:
 *      - a different CURRENT job owns it → branch on `onInflight`:
 *          • `"wait"`   (chat send-path): poll it to completion and reuse its
 *            result — never a second model call, and never slower than running
 *            our own (the eager job had a head start).
 *          • `"report"` (HTTP route): return `{ status: "extracting" }` so the
 *            caller 202s its pollers instead of holding the request open.
 *      - otherwise (never extracted / failed / stale / version drift) → claim
 *        it and extract.
 *   3. A `"wait"` that comes back empty (the eager job failed or died) falls
 *      through to producing the extract ourselves — the backstop's real job.
 *
 * `condenser` is injected so the route can pass the standalone (unmetered)
 * Gemini backend and the chat path can pass its usage-tracked
 * `GenerationContext`; only the actual `claimAndExtract` path consumes it, so
 * the common reuse/fast paths meter nothing.
 */
export async function ensureStoredExtract(opts: {
	asset: MediaAssetRecord;
	documentKind: DocumentKind;
	condenser: AttachmentCondenser;
	onInflight: "wait" | "report";
	/** Live read-progress (output char deltas) for a signal-grid pulse. Fires ONLY
	 *  when THIS call runs the model (the claim path) — the fast-path/reuse/wait
	 *  paths do no model work, so there are no tokens to report. */
	onProgress?: (deltaChars: number) => void;
}): Promise<StoredExtractResult> {
	const { asset, documentKind, condenser, onInflight, onProgress } = opts;
	const key = extractGcsObjectKeyFor(
		asset.owner,
		asset.contentHash,
		EXTRACTOR_VERSION,
	);

	// 1. Fast path: a finished current-version extract already in storage.
	const stored = await readTextObject(key, EXTRACT_MAX_BYTES);
	if (stored !== null) {
		// `truncated` is authoritative on the asset doc only when its extract
		// status is ready + current-version. The batch snapshot handed in can
		// predate the eager job's ready-write — in that stale window it would
		// understate truncation (dropping the wrapAttachment advisory note and,
		// across turns, differing the cached prefix). Reload the status only in
		// that case to read the true flag; the common fresh-snapshot path stays
		// a single GCS read.
		const truncated =
			asset.extract?.status === "ready" &&
			asset.extract.version === EXTRACTOR_VERSION
				? asset.extract.truncated
				: ((await reloadExtractStatus(asset.owner, asset.id))?.truncated ??
					asset.extract?.truncated ??
					false);
		return readyResult(stored, truncated);
	}

	// 2. Miss → fresh status decides whether to wait on a live job.
	const fresh = await reloadExtractStatus(asset.owner, asset.id);
	if (
		decideExtractAction(fresh?.snapshot ?? null, Date.now()) ===
		"await-inflight"
	) {
		if (onInflight === "report") return { status: "extracting" };
		const waited = await waitForInflight(asset.owner, asset.id, key);
		if (waited) return waited;
		// The live job died without a usable extract → fall through to claim.
	}

	// 3. Claim ATOMICALLY before running the model. The read→decide above is not
	//    atomic with the claim, so two callers can both reach here; the
	//    transaction writes `extracting` only if no live job holds it, so only one
	//    runs the model. A transaction hiccup degrades to claiming (we extract) —
	//    never breaking the turn.
	const claimed = await claimExtractionIfIdle(asset.id, {
		now: Date.now(),
		staleMs: EXTRACTING_STALE_MS,
		currentVersion: EXTRACTOR_VERSION,
		model: CONDENSER_MODEL,
	}).catch(() => true);
	if (!claimed) {
		// A concurrent caller won the claim in that window — behave as in-flight.
		if (onInflight === "report") return { status: "extracting" };
		const waited = await waitForInflight(asset.owner, asset.id, key);
		if (waited) return waited;
		// That winner also died → extract ourselves as the last-resort backstop.
	}

	// We hold the claim (or are the last-resort backstop): run + persist.
	return runExtraction({ asset, documentKind, condenser, key, onProgress });
}
