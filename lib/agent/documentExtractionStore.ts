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
// The route had the real single-flight (claim `extracting` on the asset row, 202 a
// job already in flight); the backstop had a dumber copy that read the GCS
// object directly and, on a miss, just ran its OWN extraction — never consulting
// the `extracting` status, so it couldn't see the eager job and double-billed
// the model. This module is the un-duplication: both callers now call
// `ensureStoredExtract`, so there is no second path that can bypass the lock.
//
// `extractDocument` (in `documentExtraction.ts`) stays the pure bytes→text core;
// THIS module is the impure half — the asset row's extract status + GCS object + the
// single-flight policy — composed over it.

import {
	type AssetExtractionClaim,
	type AssetExtractionClaimResult,
	type ClaimedExtractPublicationResult,
	claimExtractionIfIdle,
	findReadyExtractForProjectAndHash,
	hasReadyExtractForProjectAndHash,
	installCopiedReadyExtract,
	loadAssetById,
	type MediaAssetRecord,
	publishClaimedAssetExtract,
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
	deleteAsset as deleteGcsObject,
	downloadAssetBytes,
	readTextObject,
	writeTextObject,
} from "@/lib/storage/media";
import { withMediaObjectKeyLock } from "@/lib/storage/mediaObjectKeyLock";
import { delay } from "@/lib/utils/delay";
import {
	type AttachmentCondenser,
	CONDENSER_MODEL,
	EXTRACT_MAX_BYTES,
	extractDocument,
} from "./documentExtraction";
import { normalizeExtractText } from "./extractNormalization";

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
	| {
			status: "ready";
			text: string;
			version: number;
			truncated: boolean;
			charCount: number;
	  }
	| { status: "extracting" }
	| { status: "failed"; reason: string };

/** The minimal status snapshot the single-flight policy reasons over. Kept as
 *  a plain shape (epoch milliseconds) so the policy is a pure function
 *  unit-testable without touching storage. */
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
 * missing, see the caller), a lower-version `extracting` (a prompt/model bump),
 * or a tombstone (`extracting` older than `EXTRACTING_STALE_MS`) — means no live
 * job is producing the current extract, so the caller should ATTEMPT a claim.
 * The transactional claim separately refuses any higher-version state.
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

/** Build the `ready` result from already-fetched extract text. Repairs a
 *  double-escaped extract on the way out (`normalizeExtractText` — a no-op on a
 *  clean one), so an extract stored before that repair existed is fixed for the SA
 *  read path with no re-extraction. `charCount` is the repaired text's own length
 *  (authoritative — the same bytes the SA receives). */
function readyResult(
	text: string,
	truncated: boolean,
	version: number,
): StoredExtractResult {
	const extract = normalizeExtractText(text);
	return {
		status: "ready",
		text: extract,
		version,
		truncated,
		charCount: extract.length,
	};
}

/**
 * Re-read the asset's extract status FRESH from storage, normalized to the
 * pure-policy snapshot. The record handed to `ensureStoredExtract` may be a
 * turn-start batch snapshot that predates an eager job's claim, so the
 * single-flight decision must read current status rather than trust it.
 *
 * Loads id-only — the status read is a single-flight lock concern, not an
 * authorization one (the caller already resolved + authorized the asset).
 * Degrades to `null` on a read failure. That may lead to a claim ATTEMPT, but
 * never to unclaimed model work: only the transactional claim result below can
 * authorize extraction.
 */
async function reloadExtractStatus(
	assetId: AssetId,
): Promise<{ snapshot: ExtractStatusSnapshot; truncated: boolean } | null> {
	const fresh = await loadAssetById(assetId).catch((err: unknown) => {
		log.warn("[extract-store] status reload failed", { assetId, err });
		return null;
	});
	const extract = fresh?.extract;
	if (!extract) return null;
	return {
		snapshot: {
			status: extract.status,
			version: extract.version,
			extractedAtMs: extract.extractedAt,
		},
		truncated: extract.truncated,
	};
}

/**
 * Wait for a different in-flight job to produce the extract, reusing its result
 * instead of running a second model call. The wait is naturally bounded by the
 * staleness rule: each poll re-reads status, and once the job either finishes
 * (`ready`/`failed`) or its record ages past `EXTRACTING_STALE_MS` (the process
 * died), the loop ends. Returns the extract on success, or `null` so the caller
 * re-evaluates (the job failed, went stale, or wrote `ready` but its byte object
 * is gone). Only a later successful transactional claim may authorize another
 * model call.
 *
 * This is never slower than extracting from scratch: the in-flight job started
 * when the document was attached — before this send — so it always has a head
 * start. Every read is failure-tolerant; a hiccup falls through to `null` and
 * the caller re-runs the fenced decision.
 */
async function waitForInflight(
	assetId: AssetId,
	key: string,
	version = EXTRACTOR_VERSION,
): Promise<StoredExtractResult | null> {
	while (true) {
		await delay(INFLIGHT_POLL_MS);
		const fresh = await reloadExtractStatus(assetId);
		if (!fresh) return null; // record vanished / unreadable → caller decides
		if (
			fresh.snapshot.status === "ready" &&
			fresh.snapshot.version === version
		) {
			const text = await readTextObject(key, EXTRACT_MAX_BYTES).catch(
				() => null,
			);
			// `ready` but the object is missing → caller decides whether it may retry.
			return text !== null ? readyResult(text, fresh.truncated, version) : null;
		}
		const sameLiveJob =
			fresh.snapshot.status === "extracting" &&
			fresh.snapshot.version === version &&
			Date.now() - fresh.snapshot.extractedAtMs < EXTRACTING_STALE_MS;
		if (!sameLiveJob) {
			// Failed, stale (dead process), or version drift → stop waiting.
			return null;
		}
		// Otherwise still a live target-version job → poll again.
	}
}

/**
 * Read a ready result that superseded this exact claim. Project relocation can
 * install a copied ready extract while the model is running; the old job must
 * reuse that published pair rather than overwrite it.
 */
async function readReadyExtract(
	asset: MediaAssetRecord,
	extract: MediaAssetRecord["extract"],
): Promise<StoredExtractResult | null> {
	if (extract?.status !== "ready") return null;
	const key = extractGcsObjectKeyFor(
		asset.project_id,
		asset.contentHash,
		extract.version,
	);
	const text = await readTextObject(key, EXTRACT_MAX_BYTES).catch(() => null);
	return text === null
		? null
		: readyResult(text, extract.truncated, extract.version);
}

async function readReadyContentPair(
	asset: MediaAssetRecord,
	key: string,
	version: number,
	lockedDb: Parameters<typeof findReadyExtractForProjectAndHash>[3],
): Promise<{
	extract: NonNullable<MediaAssetRecord["extract"]>;
	text: string;
} | null> {
	const extract = await findReadyExtractForProjectAndHash(
		asset.project_id,
		asset.contentHash,
		version,
		lockedDb,
	);
	if (extract === null) return null;
	const text = await readTextObject(key, EXTRACT_MAX_BYTES).catch(() => null);
	return text === null ? null : { extract, text };
}

async function resolveSupersedingClaim(
	asset: MediaAssetRecord,
	extract: NonNullable<MediaAssetRecord["extract"]>,
	onInflight: "wait" | "report",
): Promise<StoredExtractResult> {
	const ready = await readReadyExtract(asset, extract);
	if (ready) return ready;
	if (extract.status === "extracting") {
		if (onInflight === "report") return { status: "extracting" };
		const key = extractGcsObjectKeyFor(
			asset.project_id,
			asset.contentHash,
			extract.version,
		);
		return (
			(await waitForInflight(asset.id, key, extract.version)) ?? {
				status: "failed",
				reason: "The newer extraction did not publish a usable result.",
			}
		);
	}
	return {
		status: "failed",
		reason:
			extract.failureReason ??
			"A newer extraction state superseded this request.",
	};
}

function publicationFallback(
	publication: ClaimedExtractPublicationResult,
): StoredExtractResult {
	if (publication.kind === "not_found") {
		return {
			status: "failed",
			reason: "The media asset was deleted while extraction was running.",
		};
	}
	if (publication.kind === "superseded") {
		if (publication.extract?.status === "extracting") {
			return { status: "extracting" };
		}
		return {
			status: "failed",
			reason:
				publication.extract?.failureReason ??
				"The extraction claim was superseded before publication.",
		};
	}
	return {
		status: "failed",
		reason: "The extraction result could not be published.",
	};
}

/**
 * Publish a terminal failure only while this exact claim still owns the slot.
 * Deletion, relocation, and a newer extraction are all valid winners, so a lost
 * claim is observed rather than overwritten.
 */
async function publishFailure(
	asset: MediaAssetRecord,
	claim: AssetExtractionClaim,
	reason: string,
	onInflight: "wait" | "report",
): Promise<StoredExtractResult> {
	try {
		const key = extractGcsObjectKeyFor(
			asset.project_id,
			asset.contentHash,
			claim.version,
		);
		let adoptedText: string | null = null;
		const publication = await withMediaObjectKeyLock(
			asset.gcsObjectKey,
			async (lockedDb) => {
				const shared = await readReadyContentPair(
					asset,
					key,
					claim.version,
					lockedDb,
				);
				const result = await publishClaimedAssetExtract(
					{
						assetId: asset.id,
						claim,
						...(shared !== null && {
							sharedReadyExtract: shared.extract,
						}),
						extract: {
							status: "failed",
							version: claim.version,
							model: claim.model,
							truncated: false,
							charCount: 0,
							failureReason: reason,
						},
					},
					lockedDb,
				);
				if (result.kind === "adopted" && shared !== null) {
					adoptedText = shared.text;
				}
				return result;
			},
		);
		if (publication.kind === "adopted" && adoptedText !== null) {
			return readyResult(
				adoptedText,
				publication.extract.truncated,
				publication.extract.version,
			);
		}
		if (publication.kind === "superseded" && publication.extract !== null) {
			return resolveSupersedingClaim(asset, publication.extract, onInflight);
		}
		return publication.kind === "published"
			? { status: "failed", reason }
			: publicationFallback(publication);
	} catch (statusErr) {
		log.error("[extract-store] failed-status publication failed", statusErr, {
			assetId: asset.id,
		});
		return { status: "failed", reason };
	}
}

/**
 * Run the model, then publish the extract object and matching ready metadata
 * under the asset's canonical extension-independent Project/hash content lock.
 * That is the same lock Project
 * relocation and deletion cleanup use. The exact claim is rechecked under the
 * row lock before GCS is touched, so a deletion winner cannot be followed by an
 * orphan extract recreation.
 *
 * GCS and Postgres cannot commit atomically. If the object callback succeeds
 * but the metadata transaction rejects, the same key-locked section probes for
 * a committed ready sibling and removes the unpublished object when none
 * exists. Query uncertainty fails closed by retaining bytes.
 */
async function runExtraction(opts: {
	asset: MediaAssetRecord;
	documentKind: DocumentKind;
	condenser: AttachmentCondenser;
	key: string;
	claim: AssetExtractionClaim;
	onInflight: "wait" | "report";
	onProgress?: (deltaChars: number) => void;
}): Promise<StoredExtractResult> {
	const { asset, documentKind, condenser, key, claim, onInflight, onProgress } =
		opts;

	let extracted: Awaited<ReturnType<typeof extractDocument>>;
	try {
		const bytes = await downloadAssetBytes(
			asset.gcsObjectKey,
			ASSET_SIZE_CAPS_BYTES[asset.kind],
		);
		extracted = await extractDocument({
			bytes,
			mimeType: asset.mimeType,
			kind: documentKind,
			filename: asset.originalFilename,
			condenser,
			onProgress,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return publishFailure(asset, claim, reason, onInflight);
	}

	const { extract, truncated, title, summary } = extracted;
	try {
		let adoptedText: string | null = null;
		const publication = await withMediaObjectKeyLock(
			asset.gcsObjectKey,
			async (lockedDb) => {
				try {
					const shared = await readReadyContentPair(
						asset,
						key,
						claim.version,
						lockedDb,
					);
					const result = await publishClaimedAssetExtract(
						{
							assetId: asset.id,
							claim,
							...(shared !== null && {
								sharedReadyExtract: shared.extract,
							}),
							extract: {
								status: "ready",
								version: claim.version,
								model: claim.model,
								truncated,
								charCount: extract.length,
								title,
								summary,
							},
							...(shared === null && {
								publishReadyObject: () => writeTextObject(key, extract),
							}),
						},
						lockedDb,
					);
					if (result.kind === "adopted" && shared !== null) {
						adoptedText = shared.text;
					}
					return result;
				} catch (publicationError) {
					// A rejected transaction may have written the object before its
					// metadata failed. Retain it only if a committed ready sibling
					// now names the same Project/hash/version pair.
					let retainedByReadySibling = true;
					try {
						retainedByReadySibling = await hasReadyExtractForProjectAndHash(
							asset.project_id,
							asset.contentHash,
							claim.version,
							lockedDb,
						);
					} catch (probeError) {
						log.error(
							"[extract-store] failed-publication shared-extract probe failed",
							probeError,
							{ assetId: asset.id, key },
						);
					}
					if (!retainedByReadySibling) {
						await deleteGcsObject(key).catch((cleanupError: unknown) =>
							log.error(
								"[extract-store] unpublished extract cleanup failed",
								cleanupError,
								{ assetId: asset.id, key },
							),
						);
					}
					throw publicationError;
				}
			},
		);
		if (publication.kind === "published") {
			return readyResult(extract, truncated, claim.version);
		}
		if (publication.kind === "adopted" && adoptedText !== null) {
			return readyResult(
				adoptedText,
				publication.extract.truncated,
				publication.extract.version,
			);
		}
		return publication.kind === "superseded" && publication.extract !== null
			? resolveSupersedingClaim(asset, publication.extract, onInflight)
			: publicationFallback(publication);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return publishFailure(asset, claim, reason, onInflight);
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
 * extraction backend and the chat path can pass its usage-tracked
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
		asset.project_id,
		asset.contentHash,
		EXTRACTOR_VERSION,
	);

	// 1. Fast path: a finished current-version extract already has BOTH its
	//    object and committed ready metadata. An object alone may be residue from
	//    a metadata transaction whose cleanup failed; it is never authoritative.
	const stored = await readTextObject(key, EXTRACT_MAX_BYTES);
	let fresh:
		| { snapshot: ExtractStatusSnapshot; truncated: boolean }
		| null
		| undefined;
	if (stored !== null) {
		// The batch snapshot handed in can predate an eager job's ready commit, so
		// reload only when it is not already a current ready pair. The common
		// fresh-snapshot path stays one GCS read.
		if (
			asset.extract?.status === "ready" &&
			asset.extract.version === EXTRACTOR_VERSION
		) {
			return readyResult(
				stored,
				asset.extract.truncated,
				asset.extract.version,
			);
		}
		fresh = await reloadExtractStatus(asset.id);
		if (
			fresh?.snapshot.status === "ready" &&
			fresh.snapshot.version === EXTRACTOR_VERSION
		) {
			return readyResult(stored, fresh.truncated, fresh.snapshot.version);
		}

		// Duplicate/cross-extension rows share one Project/hash/version object.
		// If another row already committed that pair, adopt its exact metadata
		// under the content lock instead of independently re-extracting and
		// overwriting the shared object.
		const adopted = await withMediaObjectKeyLock(
			asset.gcsObjectKey,
			async (lockedDb) => {
				const shared = await readReadyContentPair(
					asset,
					key,
					EXTRACTOR_VERSION,
					lockedDb,
				);
				if (shared === null) return null;
				const installed = await installCopiedReadyExtract(
					{ assetId: asset.id, extract: shared.extract },
					lockedDb,
				);
				return installed.status === "ready" &&
					installed.version === EXTRACTOR_VERSION
					? readyResult(shared.text, installed.truncated, installed.version)
					: null;
			},
		).catch((err: unknown) => {
			log.warn("[extract-store] ready sibling adoption failed", {
				assetId: asset.id,
				err,
			});
			return null;
		});
		if (adopted !== null) return adopted;
		// The adoption attempt may have waited behind another publisher; reload
		// before making the next single-flight decision.
		fresh = await reloadExtractStatus(asset.id);
	}

	// 2. Miss → fresh status decides whether to wait on a live job.
	fresh ??= await reloadExtractStatus(asset.id);
	if (
		decideExtractAction(fresh?.snapshot ?? null, Date.now()) ===
		"await-inflight"
	) {
		if (onInflight === "report") return { status: "extracting" };
		const waited = await waitForInflight(asset.id, key);
		if (waited) return waited;
		// The live job died without a usable extract → fall through to claim.
	}

	// 3. Claim ATOMICALLY before running the model. The read→decide above is not
	//    atomic with the claim, so two callers can both reach here; the
	//    transaction writes `extracting` only if no live job holds it, so only one
	//    runs the model. A claim failure is terminal for this attempt: running the
	//    model without a durable fencing token could overwrite a newer result or
	//    recreate an object after deletion.
	const tryClaim = () =>
		claimExtractionIfIdle(asset.id, {
			now: Date.now(),
			staleMs: EXTRACTING_STALE_MS,
			currentVersion: EXTRACTOR_VERSION,
			model: CONDENSER_MODEL,
		});
	let claimed: AssetExtractionClaimResult;
	try {
		claimed = await tryClaim();
	} catch (err) {
		log.error("[extract-store] extraction claim failed", err, {
			assetId: asset.id,
		});
		return {
			status: "failed",
			reason: "Nova could not safely claim this document extraction.",
		};
	}
	if (claimed.kind === "not_found") {
		return {
			status: "failed",
			reason: "The media asset was deleted before extraction could start.",
		};
	}
	if (claimed.kind === "superseded") {
		return resolveSupersedingClaim(asset, claimed.extract, onInflight);
	}
	if (claimed.kind === "in_flight") {
		// A concurrent caller won the claim in that window — behave as in-flight.
		if (onInflight === "report") return { status: "extracting" };
		const waited = await waitForInflight(asset.id, key);
		if (waited) return waited;
		// That winner failed or died. Re-claim atomically; never run the model as
		// an unclaimed "last-resort" backstop.
		try {
			claimed = await tryClaim();
		} catch (err) {
			log.error("[extract-store] extraction reclaim failed", err, {
				assetId: asset.id,
			});
			return {
				status: "failed",
				reason: "Nova could not safely reclaim this document extraction.",
			};
		}
		if (claimed.kind === "not_found") {
			return {
				status: "failed",
				reason: "The media asset was deleted before extraction could restart.",
			};
		}
		if (claimed.kind === "superseded") {
			return resolveSupersedingClaim(asset, claimed.extract, onInflight);
		}
		if (claimed.kind === "in_flight") {
			return (
				(await waitForInflight(asset.id, key)) ?? {
					status: "failed",
					reason: "The replacement extraction did not publish a usable result.",
				}
			);
		}
	}

	return runExtraction({
		asset,
		documentKind,
		condenser,
		key,
		claim: claimed.claim,
		onInflight,
		onProgress,
	});
}
