/**
 * Media asset CRUD against Firestore.
 *
 * Thin wrappers over the typed collection helpers in
 * `lib/db/firestore.ts`. The asset record lives at
 * `mediaAssets/{assetId}` — root collection keyed by the asset's
 * UUID; `owner` gates every read site.
 *
 * `loadAssetForOwner` enforces ownership and throws on a mismatch
 * rather than leaking the row; callers map that throw to a 404.
 *
 * `update()` (not `set({merge:true})`) is the write path — this
 * codebase had a real bug where merge silently preserved a cleared
 * nested field, so the convention here is "update for changes,
 * create for new rows."
 */

import { randomUUID } from "node:crypto";
import {
	FieldPath,
	FieldValue,
	Timestamp,
	type Transaction,
} from "@google-cloud/firestore";
import {
	type AssetId,
	type AssetKind,
	type AssetMimeType,
	asAssetId,
	type MediaAssetStatus,
	pendingGcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { collections, docs } from "./firestore";
import type { MediaAssetDoc, MediaAssetExtract } from "./types";

/**
 * The Firestore-shaped doc plus its id, returned by load helpers
 * for caller convenience. The doc body never carries `id` (lives
 * in the doc ref), so reattaching here saves every caller from
 * threading the id through.
 */
export type MediaAssetRecord = MediaAssetDoc & { id: AssetId };

/**
 * The JSON-safe shape both the confirm route and the library route
 * return for an asset. One serializer, one wire shape — so the
 * client writes a single parser, and Firestore internals
 * (`Timestamp`, `gcsObjectKey`, `owner`) never leak across the
 * wire. `createdAt` is an ISO-8601 string; `owner` and
 * `gcsObjectKey` are intentionally dropped (the caller already
 * knows they own it; the storage key is a server-only detail).
 */
export interface WireMediaAsset {
	id: AssetId;
	contentHash: string;
	mimeType: string;
	kind: AssetKind;
	extension: string;
	sizeBytes: number;
	dimensions?: { width: number; height: number };
	durationMs?: number;
	originalFilename: string;
	displayName?: string;
	status: MediaAssetStatus;
	createdAt: string;
	/**
	 * Document-extract status + the human title/summary (absent on media + on
	 * not-yet-extracted docs). The fields the UI needs to render the extraction
	 * indicator, gate the "What Nova reads" preview, LABEL the asset in the
	 * library, and head the preview dialog — never the extract body (served by
	 * `GET /api/media/[assetId]/extract`) or the internal `failureReason`/`model`
	 * (the UI shows a generic failed state + retry). `title` + `summary` are
	 * best-effort (absent until a successful extract produces them, or on an
	 * older extractor version), so the UI falls back to the filename alone when
	 * they're missing.
	 */
	extract?: {
		status: MediaAssetExtract["status"];
		version: number;
		truncated: boolean;
		charCount: number;
		title?: string;
		summary?: string;
	};
}

/**
 * Project a stored record to its wire shape. Both media routes
 * funnel through this so their response shapes can't drift.
 */
export function toWireMediaAsset(record: MediaAssetRecord): WireMediaAsset {
	return {
		id: record.id,
		contentHash: record.contentHash,
		mimeType: record.mimeType,
		kind: record.kind,
		extension: record.extension,
		sizeBytes: record.sizeBytes,
		dimensions: record.dimensions,
		durationMs: record.durationMs,
		originalFilename: record.originalFilename,
		displayName: record.displayName,
		status: record.status,
		createdAt: record.created_at.toDate().toISOString(),
		// Project the UI-facing extract fields; the Timestamp, failureReason,
		// and model stay server-side. `title` + `summary` ride along so the
		// library can label the asset and the preview header can show them the
		// instant it opens — no second fetch.
		extract: record.extract
			? {
					status: record.extract.status,
					version: record.extract.version,
					truncated: record.extract.truncated,
					charCount: record.extract.charCount,
					title: record.extract.title,
					summary: record.extract.summary,
				}
			: undefined,
	};
}

/**
 * Create a `pending` asset row. Returns the assigned `assetId` plus
 * the GCS object key the caller should write bytes to. The signed PUT
 * URL is minted separately (in `lib/storage/media.ts`) after this row
 * exists, so the row is the durable handle the confirm step looks up.
 *
 * Browser uploads leave `gcsObjectKey` absent and get a per-attempt
 * pending key (`pending/<owner>/<assetId>.<ext>`). Confirm-time
 * validation promotes clean bytes to the content-hash final key. MCP
 * uploads may pass a final `gcsObjectKey` because their bytes are
 * already validated before storage.
 *
 * Failure between this call and the eventual confirm leaves a `pending`
 * row behind. It is harmless: the library list filters pending rows
 * out, and the validator gate rejects any blueprint that references one.
 */
export async function createPendingAsset(args: {
	owner: string;
	/** The Project the asset belongs to (the tenant) — the app's Project for an
	 *  app upload, else the uploader's active Project. Gates every later read. */
	project_id: string;
	contentHash: string;
	mimeType: AssetMimeType;
	kind: AssetKind;
	extension: string;
	sizeBytes: number;
	gcsObjectKey?: string;
	originalFilename: string;
}): Promise<{ assetId: AssetId; gcsObjectKey: string }> {
	const assetId = asAssetId(randomUUID());
	const gcsObjectKey =
		args.gcsObjectKey ??
		pendingGcsObjectKeyFor(args.project_id, assetId, args.extension);
	await docs.mediaAsset(assetId).create({
		owner: args.owner,
		project_id: args.project_id,
		contentHash: args.contentHash,
		mimeType: args.mimeType,
		kind: args.kind,
		extension: args.extension,
		sizeBytes: args.sizeBytes,
		gcsObjectKey,
		originalFilename: args.originalFilename,
		// Seed `displayName` to the upload filename so the library UI
		// always has a non-empty label; the user can rename later
		// without touching the bytes.
		displayName: args.originalFilename,
		status: "pending",
		// `FieldValue.serverTimestamp()` is the canonical "now"
		// across our doc schemas (mirrors `appDocSchema`). Firestore
		// resolves it server-side, so two clients writing at the same
		// wall-clock millisecond get monotonic timestamps anyway.
		created_at: FieldValue.serverTimestamp() as unknown as Timestamp,
		// Born indexed-empty: a freshly uploaded asset is referenced by no app, so
		// the delete reference guard reads `[]` and skips the owner-wide scan from
		// the start. The blueprint writers arrayUnion an app id here when a save
		// first references it. (An ABSENT value — only on rows written before the
		// index shipped — routes the guard to its full-scan fallback.)
		referencingAppIds: [],
	});
	return { assetId, gcsObjectKey };
}

/**
 * Flip a `pending` asset to `ready`, writing the metadata the validator
 * settled: the promoted final `gcsObjectKey`, the authoritative
 * `mimeType` + `extension`, and the kind-specific `dimensions` (image,
 * via sharp) or `durationMs` (audio/video, via music-metadata).
 *
 * `mimeType`/`extension` are written because the validator can REFINE the
 * pending row's create-time guess: a document's browser `Content-Type` is
 * unreliable (a `.md` is often initiated as `text/plain`), so the
 * validator derives the canonical pair from the bytes / filename and that
 * is what must be stored. For media they simply match the create-time
 * values, so the write is a harmless no-op. `sizeBytes` is the one field
 * that can't change — the validator hard-rejects any byte-length mismatch
 * against the claim before this runs.
 */
export async function confirmAssetReady(args: {
	assetId: AssetId;
	gcsObjectKey?: string;
	mimeType?: AssetMimeType;
	extension?: string;
	dimensions?: { width: number; height: number };
	durationMs?: number;
}): Promise<void> {
	const patch: Partial<MediaAssetDoc> & { status: "ready" } = {
		status: "ready",
	};
	if (args.gcsObjectKey !== undefined) {
		patch.gcsObjectKey = args.gcsObjectKey;
	}
	if (args.mimeType !== undefined) {
		patch.mimeType = args.mimeType;
	}
	if (args.extension !== undefined) {
		patch.extension = args.extension;
	}
	// Assign each kind-specific slot only when the validator produced it: an
	// image confirm carries `dimensions` (sharp) and no `durationMs`; an
	// audio/video confirm carries `durationMs` (music-metadata) and no
	// `dimensions`; a document carries neither. This is a first-time set on
	// the `pending → ready` flip, never a clear — a slot the kind doesn't
	// carry is simply absent from the patch.
	if (args.dimensions) {
		patch.dimensions = args.dimensions;
	}
	if (args.durationMs !== undefined) {
		patch.durationMs = args.durationMs;
	}
	await docs.mediaAsset(args.assetId).update(patch);
}

/**
 * Create a `ready` asset row in one shot — the cross-Project move's
 * copy-into-destination path (`lib/media/moveMedia.ts`). The bytes are already
 * validated (they are a server-side GCS copy of an existing `ready` asset), so
 * this skips the pending→confirm dance browser uploads need and writes the final
 * row directly: no lingering `pending` intermediate to strand on a crash. Born
 * with `referencingAppIds: []`; the move's post-commit `syncMediaReferences`
 * arrayUnions the moved app once its repointed blueprint commits. Returns the new
 * `assetId`.
 */
export async function createReadyAsset(args: {
	owner: string;
	project_id: string;
	contentHash: string;
	mimeType: AssetMimeType;
	kind: AssetKind;
	extension: string;
	sizeBytes: number;
	gcsObjectKey: string;
	originalFilename: string;
	displayName?: string;
	dimensions?: { width: number; height: number };
	durationMs?: number;
}): Promise<{ assetId: AssetId }> {
	const assetId = asAssetId(randomUUID());
	await docs.mediaAsset(assetId).create({
		owner: args.owner,
		project_id: args.project_id,
		contentHash: args.contentHash,
		mimeType: args.mimeType,
		kind: args.kind,
		extension: args.extension,
		sizeBytes: args.sizeBytes,
		gcsObjectKey: args.gcsObjectKey,
		originalFilename: args.originalFilename,
		displayName: args.displayName ?? args.originalFilename,
		...(args.dimensions !== undefined && { dimensions: args.dimensions }),
		...(args.durationMs !== undefined && { durationMs: args.durationMs }),
		status: "ready",
		created_at: FieldValue.serverTimestamp() as unknown as Timestamp,
		referencingAppIds: [],
	});
	return { assetId };
}

/**
 * Write the document-extract subobject in one shot, stamping `extractedAt`
 * server-side. The extract is a self-contained nested object, so a plain
 * `update({ extract })` replaces the whole subobject on every state
 * transition (`extracting` → `ready`/`failed`) — no dot-path merge, no stale
 * leftover field. `failureReason` is passed only on the `failed` transition;
 * Firestore's `ignoreUndefinedProperties` drops it on the others. The extract
 * TEXT is written to GCS separately (see `writeTextObject`); this only tracks
 * status + the metadata the UI and chat resolve step read.
 */
export async function setAssetExtractStatus(
	assetId: AssetId,
	extract: Omit<MediaAssetExtract, "extractedAt">,
): Promise<void> {
	await docs.mediaAsset(assetId).update({
		extract: {
			...extract,
			extractedAt: FieldValue.serverTimestamp() as unknown as Timestamp,
		},
	});
}

/**
 * Atomically claim a document's extraction. In ONE transaction, re-read the
 * extract status and write `extracting` only if no LIVE current job already holds
 * it — a job is live iff its status is `extracting`, at `currentVersion`, and
 * younger than `staleMs` (a dead process leaves a stale `extracting` record that
 * is reclaimable). Returns `true` when THIS caller acquired the claim (and should
 * run the model), `false` when a live job already owns it (the caller should wait
 * or report in-flight).
 *
 * This is the lock that stops two concurrent eager extractions from both running
 * the model: the plain read-decide-then-write it backs let both pass the check
 * before either wrote the claim, so both proceeded. The transaction closes that
 * window — the second caller sees the first's `extracting` write and backs off.
 */
export async function claimExtractionIfIdle(
	assetId: AssetId,
	opts: { now: number; staleMs: number; currentVersion: number; model: string },
): Promise<boolean> {
	const ref = docs.mediaAsset(assetId);
	return ref.firestore.runTransaction(async (tx) => {
		const extract = (await tx.get(ref)).data()?.extract;
		const liveJob =
			extract?.status === "extracting" &&
			extract.version === opts.currentVersion &&
			opts.now - extract.extractedAt.toMillis() < opts.staleMs;
		if (liveJob) return false;
		tx.update(ref, {
			extract: {
				status: "extracting",
				version: opts.currentVersion,
				model: opts.model,
				truncated: false,
				charCount: 0,
				extractedAt: FieldValue.serverTimestamp() as unknown as Timestamp,
			},
		});
		return true;
	});
}

/**
 * True when another row owned by the same user points at the same GCS
 * object. Used before deleting bytes: duplicate-ready races and legacy
 * content-hash-keyed rows can share storage, so a row delete must not
 * blindly remove the object out from under a sibling.
 *
 * This closes the common shared-bytes case, not a transactional one: a
 * same-owner delete racing a same-bytes re-upload that promotes to the final
 * key AFTER this check can still leave the new row pointing at deleted bytes
 * (no Firestore↔GCS transaction spans the two layers). The window is narrow
 * and the broken reference is recoverable by re-upload; callers fail closed —
 * a query throw is treated as "shared" so bytes are retained — which keeps the
 * conservative choice the default.
 */
export async function hasOtherAssetForGcsObjectKey(
	gcsObjectKey: string,
	excludeAssetId: AssetId,
): Promise<boolean> {
	const snap = await collections
		.mediaAssets()
		.where("gcsObjectKey", "==", gcsObjectKey)
		.limit(2)
		.get();
	return snap.docs.some((doc) => doc.id !== excludeAssetId);
}

/**
 * Project-and-hash dedup probe. Used at upload-initiate: if the asset's claimed
 * hash already exists in this Project AND the row is `ready`, the route returns
 * the existing assetId and tells the browser to skip the bytes-PUT step.
 *
 * Returns the matching record, or `null` if no row matches. A `pending` row of
 * the same (project, hash) is treated as no match — the caller creates a fresh
 * pending row with its own per-attempt object; confirm collapses to an existing
 * ready sibling when one appears.
 */
export async function findReadyAssetByProjectAndHash(
	projectId: string,
	contentHash: string,
): Promise<MediaAssetRecord | null> {
	const snap = await collections
		.mediaAssets()
		.where("project_id", "==", projectId)
		.where("contentHash", "==", contentHash)
		.where("status", "==", "ready")
		.limit(1)
		.get();
	const first = snap.docs[0];
	if (!first) return null;
	return { ...first.data(), id: asAssetId(first.id) };
}

/**
 * Load one asset by id, WITHOUT authorizing. The caller MUST gate on the
 * returned `project_id` (`userInProject`) before serving bytes or metadata —
 * every read site does, collapsing a non-member to the same 404 as a missing
 * row so ids stay non-enumerable. Returns `null` for a missing row.
 */
export async function loadAssetById(
	assetId: AssetId,
): Promise<MediaAssetRecord | null> {
	const snap = await docs.mediaAsset(assetId).get();
	const data = snap.data();
	if (!data) return null;
	return { ...data, id: asAssetId(snap.id) };
}

/** Firestore caps a `documentId() in [...]` query at 30 values, so the
 *  bulk loader chunks the id list into batches of this size. */
const ID_BATCH_SIZE = 30;

/**
 * Bulk-load a Project's assets among a set of ids — the compile / upload
 * manifest loader's primary call. Resolves every `AssetId` a blueprint
 * references (from `lib/domain/mediaRefs::collectAssetRefs`) into rows in one
 * pass.
 *
 * `project_id` filtering is done in memory after a `documentId() in` query
 * (which needs no composite index): an id in ANOTHER Project OR not existing is
 * silently omitted — never leaked, so a doc that references a foreign-Project
 * asset can't pull its bytes into a compile. `pending` rows are included: the
 * validator's `mediaAssetReady` rule reports them with an actionable "still
 * uploading" message. A foreign-Project reference reads as a manifest miss and
 * surfaces as `mediaAssetExists`'s `MEDIA_ASSET_NOT_FOUND` — the same message a
 * deleted asset produces, keeping the cross-tenant distinction below the surface.
 */
export async function loadAssetsByIds(
	ids: readonly string[],
	projectId: string,
): Promise<MediaAssetRecord[]> {
	const unique = [...new Set(ids)];
	const out: MediaAssetRecord[] = [];
	for (let i = 0; i < unique.length; i += ID_BATCH_SIZE) {
		const chunk = unique.slice(i, i + ID_BATCH_SIZE);
		const snap = await collections
			.mediaAssets()
			.where(FieldPath.documentId(), "in", chunk)
			.get();
		for (const d of snap.docs) {
			const data = d.data();
			if (data.project_id === projectId) {
				out.push({ ...data, id: asAssetId(d.id) });
			}
		}
	}
	return out;
}

/**
 * Read a set of asset rows INSIDE a Firestore transaction — the MCP
 * guarded commit's media re-check. Reading through `tx.getAll` (rather
 * than a plain query) makes the rows part of the transaction's read set,
 * so a concurrent write to any of them (a delete racing the attach)
 * serializes against the blueprint commit instead of slipping between a
 * pre-commit check and the write.
 *
 * Missing rows are simply absent from the returned map — the caller's
 * judgment (`describeMediaExpectationFailures`) owns the missing/foreign
 * distinction, including the privacy rule that both read as "not found".
 */
export async function getAssetsInTransaction(
	tx: Transaction,
	ids: readonly string[],
): Promise<Map<string, MediaAssetRecord>> {
	const unique = [...new Set(ids)];
	const out = new Map<string, MediaAssetRecord>();
	if (unique.length === 0) return out;
	const snaps = await tx.getAll(
		...unique.map((id) => docs.mediaAsset(asAssetId(id))),
	);
	for (const snap of snaps) {
		const data = snap.data();
		if (data) out.set(snap.id, { ...data, id: asAssetId(snap.id) });
	}
	return out;
}

/** Page size for the library list — matches the apps route's `JSON_LIST_PAGE_SIZE`. */
const LIBRARY_PAGE_SIZE = 50;

/**
 * Cursor-paginated list of a Project's `ready` assets, newest
 * first. Optionally filtered to a SET of `kinds` via a server-side
 * query (backed by a composite index) — not an in-memory page
 * filter, so every returned page is full up to the page size
 * regardless of how sparse the filtered kinds are. This matters for
 * the picker's "All" view, which allows only its carrier's kinds
 * (e.g. the chat file manager allows images + documents, never
 * audio/video): filtering server-side keeps a page of irrelevant
 * kinds from burying the few attachable ones behind "Load more".
 *
 * A single kind uses an equality (`==`); several use a disjunction
 * (`in`, ≤30 values). Both reuse the `(project_id, status, kind,
 * created_at, documentId)` composite index; the `in` is executed as
 * a merge of per-kind streams, and the cursor pushes into each, so
 * pagination stays skip/dupe-free (verified against real Firestore).
 *
 * Pagination orders by `(created_at desc, documentId desc)` and the
 * cursor carries BOTH so two assets sharing an identical server
 * timestamp can't straddle a page boundary and get skipped. The
 * cursor is an opaque base64 token; callers round-trip it without
 * interpreting it.
 */
export async function listReadyAssetsForProject(
	projectId: string,
	options: { kinds?: readonly AssetKind[]; cursor?: string } = {},
): Promise<{ assets: MediaAssetRecord[]; nextCursor: string | null }> {
	let query = collections
		.mediaAssets()
		.where("project_id", "==", projectId)
		.where("status", "==", "ready");
	// An empty `kinds` array means "no kind filter" — never `in []`, which
	// Firestore rejects. One kind narrows with an equality; several with a
	// disjunction.
	if (options.kinds && options.kinds.length > 0) {
		query =
			options.kinds.length === 1
				? query.where("kind", "==", options.kinds[0])
				: query.where("kind", "in", [...options.kinds]);
	}
	query = query
		.orderBy("created_at", "desc")
		.orderBy(FieldPath.documentId(), "desc")
		.limit(LIBRARY_PAGE_SIZE);
	if (options.cursor) {
		const { boundary, id } = decodeLibraryCursor(options.cursor);
		query = query.startAfter(boundary, id);
	}
	const snap = await query.get();
	const assets: MediaAssetRecord[] = snap.docs.map((d) => ({
		...d.data(),
		id: asAssetId(d.id),
	}));
	const last = snap.docs[snap.docs.length - 1];
	const nextCursor =
		snap.docs.length === LIBRARY_PAGE_SIZE && last
			? encodeLibraryCursor(last.data().created_at, last.id)
			: null;
	return { assets, nextCursor };
}

/**
 * Encode/decode the opaque library pagination cursor. The cursor
 * pins both the boundary timestamp AND the document id so the
 * `(created_at, documentId)` ordering resumes deterministically
 * across pages even when timestamps tie. Base64 of a small JSON
 * object — opaque to clients, who just echo it back.
 *
 * The timestamp is encoded as its raw `{seconds, nanoseconds}`
 * components, NOT an ISO string. Server timestamps carry
 * sub-millisecond nanoseconds; an ISO round-trip
 * (`Timestamp → Date → ISO → Date → Timestamp`) truncates to
 * millisecond precision, which would shift the boundary earlier and
 * silently skip any asset whose `created_at` shares the boundary's
 * millisecond but not its exact nanos — defeating the very tie-break
 * the compound cursor exists to provide.
 */
export function encodeLibraryCursor(createdAt: Timestamp, id: string): string {
	return Buffer.from(
		JSON.stringify({
			seconds: createdAt.seconds,
			nanoseconds: createdAt.nanoseconds,
			id,
		}),
	).toString("base64url");
}

export function decodeLibraryCursor(cursor: string): {
	boundary: Timestamp;
	id: string;
} {
	try {
		const parsed = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			Number.isInteger(parsed?.seconds) &&
			Number.isInteger(parsed?.nanoseconds) &&
			typeof parsed?.id === "string"
		) {
			// Construct the boundary INSIDE the try: the `Timestamp`
			// constructor validates the seconds range + nanos bounds and
			// throws on a crafted out-of-range value, so any bad cursor
			// — malformed base64, wrong shape, or out-of-range numbers —
			// converges on `MalformedCursorError` (→ 400) rather than a
			// constructor throw escaping as a 500.
			const boundary = new Timestamp(parsed.seconds, parsed.nanoseconds);
			return { boundary, id: parsed.id };
		}
	} catch {
		/* malformed cursor falls through to the throw below */
	}
	throw new MalformedCursorError();
}

/**
 * Thrown when the library cursor can't be decoded. A client error
 * (the caller sent a token we didn't mint), so the library route
 * maps it to a 400 — distinct from the generic 500 a plain `Error`
 * would collapse to.
 */
export class MalformedCursorError extends Error {
	constructor() {
		super(
			"Couldn't read the media-library page cursor — it should be the opaque token the previous page returned. Drop the cursor to start from the first page.",
		);
		this.name = "MalformedCursorError";
	}
}

/**
 * Reverse-index maintenance: record that `appId`'s persisted blueprint
 * references each of `assetIds`. Called by the blueprint writers on every save
 * (`syncMediaReferences`), so the delete reference guard can read an asset's
 * candidate referencing-app set instead of scanning every app the owner has.
 *
 * Append-only by design: `arrayUnion` is idempotent at the VALUE level (re-adding
 * a present app id leaves the set unchanged) and never removes an app that
 * stopped referencing the asset — the guard re-walks each candidate to confirm +
 * prune-by-omission, so a stale entry costs one extra app load, never a wrong
 * block. It is still a real write each save (the accepted cost of the append-only
 * design); an empty `assetIds` (the overwhelming common case — no media) does
 * nothing.
 *
 * Each asset is written INDEPENDENTLY (settled, not one atomic batch): a saved
 * blueprint can carry a dangling asset id — a ref to a recovered or purged asset
 * with no `mediaAssets` row — and `update()` on a missing doc rejects NOT_FOUND.
 * In an atomic batch that one bad ref would drop EVERY edge in the save; settled
 * independently, the bogus id skips itself and every valid edge still lands. The
 * write is `update` (not `set({merge:true})`) ON PURPOSE: a missing id must fail,
 * not materialize a schema-invalid ghost asset row (no owner/contentHash) that
 * the converter's `schema.parse` would throw on at the next read.
 */
export async function addReferencingApp(
	assetIds: readonly string[],
	appId: string,
): Promise<void> {
	const unique = [...new Set(assetIds)];
	if (unique.length === 0) return;
	const results = await Promise.allSettled(
		unique.map((assetId) =>
			docs.mediaAsset(assetId).update({
				referencingAppIds: FieldValue.arrayUnion(appId),
			}),
		),
	);
	results.forEach((r, i) => {
		// A rejection is almost always a dangling ref (no asset row). The valid
		// edges still landed; log the orphan so it's diagnosable, don't throw.
		if (r.status === "rejected") {
			log.warn("[addReferencingApp] couldn't index a referenced asset", {
				assetId: unique[i],
				appId,
				err: r.reason,
			});
		}
	});
}

/**
 * Hard-delete an asset row. Caller is responsible for the GCS
 * object cleanup AND for ensuring no live blueprint references
 * the asset — the deletion MCP tool refuses to call this if any
 * reference is found.
 */
export async function deleteAsset(assetId: AssetId): Promise<void> {
	await docs.mediaAsset(assetId).delete();
}
