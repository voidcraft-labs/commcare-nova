/**
 * Media asset CRUD against Postgres.
 *
 * The asset row lives in `media_assets` (keyed by the asset's UUID); the
 * referencing-apps reverse index lives in the `media_asset_refs` join table
 * (one row per `(asset, app)` candidate edge). `project_id` is the tenant and
 * the only access gate — every read SITE authorizes Project membership on the
 * returned `project_id` before serving bytes or metadata.
 *
 * The record builders `Number(...)` the `bigint` columns (`size_bytes`,
 * `duration_ms`) that pg returns as strings, and parse the `extract` jsonb
 * through `mediaAssetExtractSchema` (tolerating a null column).
 */

import { randomUUID } from "node:crypto";
import type { Selectable, Transaction } from "kysely";
import {
	type AssetId,
	type AssetKind,
	type AssetMimeType,
	asAssetId,
	type MediaAssetStatus,
	pendingGcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import {
	type AppDatabase,
	getAppDb,
	type MediaAssetsTable,
	withAppTx,
} from "./pg";
import {
	type MediaAssetDoc,
	type MediaAssetExtract,
	mediaAssetExtractSchema,
} from "./types";

/**
 * The record shape plus its id, returned by load helpers for caller
 * convenience. The row body never carries `id` (it is the primary key), so
 * reattaching here saves every caller from threading the id through.
 */
export type MediaAssetRecord = MediaAssetDoc & { id: AssetId };

/** Assemble a `media_assets` row into the in-memory `MediaAssetRecord`. */
function toRecord(row: Selectable<MediaAssetsTable>): MediaAssetRecord {
	return {
		id: asAssetId(row.id),
		project_id: row.project_id,
		owner: row.owner,
		contentHash: row.content_hash,
		mimeType: row.mime_type as AssetMimeType,
		extension: row.extension,
		sizeBytes: Number(row.size_bytes),
		...(row.dimensions !== null && { dimensions: row.dimensions }),
		...(row.duration_ms !== null && { durationMs: Number(row.duration_ms) }),
		kind: row.kind as AssetKind,
		gcsObjectKey: row.gcs_object_key,
		originalFilename: row.original_filename,
		...(row.display_name !== null && { displayName: row.display_name }),
		status: row.status as MediaAssetStatus,
		...(row.extract !== null && {
			extract: mediaAssetExtractSchema.parse(row.extract),
		}),
		created_at: row.created_at,
	};
}

/**
 * The JSON-safe shape both the confirm route and the library route return for
 * an asset. One serializer, one wire shape — so the client writes a single
 * parser, and storage internals (`gcsObjectKey`, `owner`) never leak across the
 * wire. `createdAt` is an ISO-8601 string; `owner` and `gcsObjectKey` are
 * intentionally dropped (the caller already knows they can access it; the
 * storage key is a server-only detail).
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
 * Project a stored record to its wire shape. Both media routes funnel through
 * this so their response shapes can't drift. `created_at` is a `Date`, so it
 * serializes via `.toISOString()`.
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
		createdAt: record.created_at.toISOString(),
		// Project the UI-facing extract fields; failureReason and model stay
		// server-side. `title` + `summary` ride along so the library can label the
		// asset and the preview header can show them the instant it opens — no
		// second fetch.
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
 * Create a `pending` asset row. Returns the assigned `assetId` plus the GCS
 * object key the caller should write bytes to. The signed PUT URL is minted
 * separately (in `lib/storage/media.ts`) after this row exists, so the row is
 * the durable handle the confirm step looks up.
 *
 * Browser uploads leave `gcsObjectKey` absent and get a per-attempt pending key
 * (`pending/<project_id>/<assetId>.<ext>`). Confirm-time validation promotes
 * clean bytes to the content-hash final key. MCP uploads may pass a final
 * `gcsObjectKey` because their bytes are already validated before storage.
 *
 * Failure between this call and the eventual confirm leaves a `pending` row
 * behind. It is harmless: the library list filters pending rows out, and the
 * validator gate rejects any blueprint that references one. The row is born
 * referenced by no app (no `media_asset_refs` rows), so the deletion guard
 * reads an empty candidate set from the start.
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
	const db = await getAppDb();
	await db
		.insertInto("media_assets")
		.values({
			id: assetId,
			owner: args.owner,
			project_id: args.project_id,
			content_hash: args.contentHash,
			mime_type: args.mimeType,
			kind: args.kind,
			extension: args.extension,
			size_bytes: args.sizeBytes,
			gcs_object_key: gcsObjectKey,
			original_filename: args.originalFilename,
			// Seed `display_name` to the upload filename so the library UI always has
			// a non-empty label; the user can rename later without touching the bytes.
			display_name: args.originalFilename,
			status: "pending",
			created_at: new Date(),
		})
		.execute();
	return { assetId, gcsObjectKey };
}

/**
 * Flip a `pending` asset to `ready`, writing the metadata the validator
 * settled: the promoted final `gcsObjectKey`, the authoritative `mimeType` +
 * `extension`, and the kind-specific `dimensions` (image, via sharp) or
 * `durationMs` (audio/video, via music-metadata).
 *
 * `mimeType`/`extension` are written because the validator can REFINE the
 * pending row's create-time guess: a document's browser `Content-Type` is
 * unreliable (a `.md` is often initiated as `text/plain`), so the validator
 * derives the canonical pair from the bytes / filename and that is what must be
 * stored. For media they simply match the create-time values, so the write is a
 * harmless no-op. `sizeBytes` is the one field that can't change — the validator
 * hard-rejects any byte-length mismatch against the claim before this runs.
 */
export async function confirmAssetReady(args: {
	assetId: AssetId;
	gcsObjectKey?: string;
	mimeType?: AssetMimeType;
	extension?: string;
	dimensions?: { width: number; height: number };
	durationMs?: number;
}): Promise<void> {
	const db = await getAppDb();
	await db
		.updateTable("media_assets")
		.set({
			status: "ready",
			...(args.gcsObjectKey !== undefined && {
				gcs_object_key: args.gcsObjectKey,
			}),
			...(args.mimeType !== undefined && { mime_type: args.mimeType }),
			...(args.extension !== undefined && { extension: args.extension }),
			// Assign each kind-specific slot only when the validator produced it: an
			// image confirm carries `dimensions` (sharp) and no `durationMs`; an
			// audio/video confirm carries `durationMs` (music-metadata) and no
			// `dimensions`; a document carries neither. This is a first-time set on
			// the `pending → ready` flip, never a clear — a slot the kind doesn't
			// carry is simply absent from the patch.
			...(args.dimensions && { dimensions: JSON.stringify(args.dimensions) }),
			...(args.durationMs !== undefined && { duration_ms: args.durationMs }),
		})
		.where("id", "=", args.assetId)
		.execute();
}

/**
 * Create a `ready` asset row in one shot — the cross-Project move's
 * copy-into-destination path (`lib/media/moveMedia.ts`). The bytes are already
 * validated (they are a server-side GCS copy of an existing `ready` asset), so
 * this skips the pending→confirm dance browser uploads need and writes the
 * final row directly: no lingering `pending` intermediate to strand on a crash.
 * The caller passes `referencingAppIds` (the moving app) so the copy is born
 * already reverse-indexed — if the process dies after the flip commits but
 * before the post-commit `syncMediaReferences`, the copy still reads as
 * referenced and the deletion guard protects it (an empty ref set would let a
 * co-member delete a live-referenced copy). The row + its ref edges commit in
 * one transaction. Returns the new `assetId`.
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
	referencingAppIds?: readonly string[];
}): Promise<{ assetId: AssetId }> {
	const assetId = asAssetId(randomUUID());
	await withAppTx(async (tx) => {
		await tx
			.insertInto("media_assets")
			.values({
				id: assetId,
				owner: args.owner,
				project_id: args.project_id,
				content_hash: args.contentHash,
				mime_type: args.mimeType,
				kind: args.kind,
				extension: args.extension,
				size_bytes: args.sizeBytes,
				gcs_object_key: args.gcsObjectKey,
				original_filename: args.originalFilename,
				display_name: args.displayName ?? args.originalFilename,
				...(args.dimensions !== undefined && {
					dimensions: JSON.stringify(args.dimensions),
				}),
				...(args.durationMs !== undefined && { duration_ms: args.durationMs }),
				status: "ready",
				created_at: new Date(),
			})
			.execute();
		const appIds = [...new Set(args.referencingAppIds ?? [])];
		if (appIds.length > 0) {
			await tx
				.insertInto("media_asset_refs")
				.values(appIds.map((appId) => ({ asset_id: assetId, app_id: appId })))
				.onConflict((oc) => oc.columns(["asset_id", "app_id"]).doNothing())
				.execute();
		}
	});
	return { assetId };
}

/**
 * Write the document-extract subobject in one shot, stamping `extractedAt` as
 * epoch ms. The extract is a self-contained jsonb object, so a plain
 * `set({ extract })` replaces the whole subobject on every state transition
 * (`extracting` → `ready`/`failed`) — no dot-path merge, no stale leftover
 * field. `failureReason` is passed only on the `failed` transition; an absent
 * optional simply isn't a key on the object. The extract TEXT is written to GCS
 * separately (see `writeTextObject`); this only tracks status + the metadata
 * the UI and chat resolve step read.
 */
export async function setAssetExtractStatus(
	assetId: AssetId,
	extract: Omit<MediaAssetExtract, "extractedAt">,
): Promise<void> {
	const db = await getAppDb();
	await db
		.updateTable("media_assets")
		.set({
			extract: JSON.stringify({ ...extract, extractedAt: Date.now() }),
		})
		.where("id", "=", assetId)
		.execute();
}

/**
 * Atomically claim a document's extraction. In ONE transaction, re-read the
 * extract status under a row lock and write `extracting` only if no LIVE current
 * job already holds it — a job is live iff its status is `extracting`, at
 * `currentVersion`, and younger than `staleMs` (a dead process leaves a stale
 * `extracting` record that is reclaimable). Returns `true` when THIS caller
 * acquired the claim (and should run the model), `false` when a live job already
 * owns it (the caller should wait or report in-flight).
 *
 * This is the lock that stops two concurrent eager extractions from both running
 * the model: the plain read-decide-then-write it backs let both pass the check
 * before either wrote the claim, so both proceeded. The `SELECT … FOR UPDATE`
 * closes that window — the second caller sees the first's `extracting` write and
 * backs off.
 */
export async function claimExtractionIfIdle(
	assetId: AssetId,
	opts: { now: number; staleMs: number; currentVersion: number; model: string },
): Promise<boolean> {
	return withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("media_assets")
			.select("extract")
			.where("id", "=", assetId)
			.forUpdate()
			.executeTakeFirst();
		const extract = row?.extract as MediaAssetExtract | null | undefined;
		const liveJob =
			extract?.status === "extracting" &&
			extract.version === opts.currentVersion &&
			typeof extract.extractedAt === "number" &&
			opts.now - extract.extractedAt < opts.staleMs;
		if (liveJob) return false;
		await tx
			.updateTable("media_assets")
			.set({
				extract: JSON.stringify({
					status: "extracting",
					version: opts.currentVersion,
					model: opts.model,
					truncated: false,
					charCount: 0,
					extractedAt: Date.now(),
				}),
			})
			.where("id", "=", assetId)
			.execute();
		return true;
	});
}

/**
 * True when another row points at the same GCS object. Used before deleting
 * bytes: duplicate-ready races and legacy content-hash-keyed rows can share
 * storage, so a row delete must not blindly remove the object out from under a
 * sibling.
 *
 * This closes the common shared-bytes case, not a transactional one: a delete
 * racing a same-bytes re-upload that promotes to the final key AFTER this check
 * can still leave the new row pointing at deleted bytes (no Postgres↔GCS
 * transaction spans the two layers). The window is narrow and the broken
 * reference is recoverable by re-upload; callers fail closed — a query throw is
 * treated as "shared" so bytes are retained — which keeps the conservative
 * choice the default.
 */
export async function hasOtherAssetForGcsObjectKey(
	gcsObjectKey: string,
	excludeAssetId: AssetId,
): Promise<boolean> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("media_assets")
		.select("id")
		.where("gcs_object_key", "=", gcsObjectKey)
		.where("id", "!=", excludeAssetId)
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
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
	const db = await getAppDb();
	const row = await db
		.selectFrom("media_assets")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("content_hash", "=", contentHash)
		.where("status", "=", "ready")
		.limit(1)
		.executeTakeFirst();
	return row ? toRecord(row) : null;
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
	const db = await getAppDb();
	const row = await db
		.selectFrom("media_assets")
		.selectAll()
		.where("id", "=", assetId)
		.executeTakeFirst();
	return row ? toRecord(row) : null;
}

/**
 * Bulk-load a Project's assets among a set of ids — the compile / upload
 * manifest loader's primary call. Resolves every `AssetId` a blueprint
 * references (from `lib/domain/mediaRefs::collectAssetRefs`) into rows in one
 * pass (`id = ANY($ids)`), then filters to the Project IN MEMORY.
 *
 * An id in ANOTHER Project OR not existing is silently omitted — never leaked,
 * so a doc that references a foreign-Project asset can't pull its bytes into a
 * compile. `pending` rows are included: the validator's `mediaAssetReady` rule
 * reports them with an actionable "still uploading" message. A foreign-Project
 * reference reads as a manifest miss and surfaces as `mediaAssetExists`'s
 * `MEDIA_ASSET_NOT_FOUND` — the same message a deleted asset produces, keeping
 * the cross-tenant distinction below the surface.
 */
export async function loadAssetsByIds(
	ids: readonly string[],
	projectId: string,
): Promise<MediaAssetRecord[]> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	const db = await getAppDb();
	const rows = await db
		.selectFrom("media_assets")
		.selectAll()
		.where("id", "in", unique)
		.execute();
	return rows
		.filter((row) => row.project_id === projectId)
		.map((row) => toRecord(row));
}

/**
 * Read a set of asset rows INSIDE a commit transaction — the guarded commit's
 * media re-check. Selecting `FOR SHARE` makes the rows part of the
 * transaction's read set, so a concurrent write to any of them (a delete racing
 * the attach) serializes against the blueprint commit instead of slipping
 * between a pre-commit check and the write.
 *
 * Missing rows are simply absent from the returned map — the caller's judgment
 * (`describeMediaExpectationFailures`) owns the missing/foreign distinction,
 * including the privacy rule that both read as "not found".
 */
export async function getAssetsInTransaction(
	tx: Transaction<AppDatabase>,
	ids: readonly string[],
): Promise<Map<string, MediaAssetRecord>> {
	const unique = [...new Set(ids)];
	const out = new Map<string, MediaAssetRecord>();
	if (unique.length === 0) return out;
	const rows = await tx
		.selectFrom("media_assets")
		.selectAll()
		.where("id", "in", unique)
		.forShare()
		.execute();
	for (const row of rows) out.set(row.id, toRecord(row));
	return out;
}

/** Page size for the library list — matches the apps route's `JSON_LIST_PAGE_SIZE`. */
const LIBRARY_PAGE_SIZE = 50;

/**
 * Cursor-paginated list of a Project's `ready` assets, newest first. Optionally
 * filtered to a SET of `kinds` via a server-side query — not an in-memory page
 * filter, so every returned page is full up to the page size regardless of how
 * sparse the filtered kinds are. This matters for the picker's "All" view, which
 * allows only its carrier's kinds (e.g. the chat file manager allows images +
 * documents, never audio/video): filtering server-side keeps a page of
 * irrelevant kinds from burying the few attachable ones behind "Load more".
 *
 * A single kind uses an equality (`=`); several use a disjunction (`in`). Both
 * ride the `(project_id, status, kind, created_at DESC, id DESC)` index.
 *
 * Pagination orders by `(created_at DESC, id DESC)` and the cursor carries BOTH
 * so two assets sharing an identical `created_at` can't straddle a page boundary
 * and get skipped. The cursor is an opaque base64url token; callers round-trip
 * it without interpreting it.
 */
export async function listReadyAssetsForProject(
	projectId: string,
	options: { kinds?: readonly AssetKind[]; cursor?: string } = {},
): Promise<{ assets: MediaAssetRecord[]; nextCursor: string | null }> {
	const db = await getAppDb();
	let query = db
		.selectFrom("media_assets")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("status", "=", "ready");
	// An empty `kinds` array means "no kind filter" — never `in []`. One kind
	// narrows with an equality; several with a disjunction.
	if (options.kinds && options.kinds.length > 0) {
		query =
			options.kinds.length === 1
				? query.where("kind", "=", options.kinds[0])
				: query.where("kind", "in", [...options.kinds]);
	}
	query = query
		.orderBy("created_at", "desc")
		.orderBy("id", "desc")
		.limit(LIBRARY_PAGE_SIZE);
	if (options.cursor) {
		const { createdAtMs, id } = decodeLibraryCursor(options.cursor);
		const boundary = new Date(createdAtMs);
		/* Resume strictly AFTER `(created_at, id)` in the DESC composite order:
		 * primary field past the boundary (older), OR equal primary and id less. */
		query = query.where((eb) =>
			eb.or([
				eb("created_at", "<", boundary),
				eb.and([eb("created_at", "=", boundary), eb("id", "<", id)]),
			]),
		);
	}
	const rows = await query.execute();
	const assets = rows.map((row) => toRecord(row));
	const last = rows[rows.length - 1];
	const nextCursor =
		rows.length === LIBRARY_PAGE_SIZE && last
			? encodeLibraryCursor(last.created_at, last.id)
			: null;
	return { assets, nextCursor };
}

/**
 * Encode/decode the opaque library pagination cursor. The cursor pins both the
 * boundary timestamp (epoch ms) AND the row id so the `(created_at, id)`
 * ordering resumes deterministically across pages even when timestamps tie.
 * Base64url of a small JSON object — opaque to clients, who just echo it back.
 *
 * The ms boundary relies on every `created_at` writer supplying a JS `Date`
 * (ms precision) rather than the column's `now()` default — a sub-ms stored
 * value would not round-trip through `getTime()` and could straddle a page
 * boundary. Keep inserts passing an explicit `new Date()`.
 */
export function encodeLibraryCursor(createdAt: Date, id: string): string {
	return Buffer.from(
		JSON.stringify({ createdAtMs: createdAt.getTime(), id }),
	).toString("base64url");
}

export function decodeLibraryCursor(cursor: string): {
	createdAtMs: number;
	id: string;
} {
	try {
		const parsed = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			Number.isFinite(parsed?.createdAtMs) &&
			typeof parsed?.id === "string"
		) {
			return { createdAtMs: parsed.createdAtMs, id: parsed.id };
		}
	} catch {
		/* malformed cursor falls through to the throw below */
	}
	throw new MalformedCursorError();
}

/**
 * Thrown when the library cursor can't be decoded. A client error (the caller
 * sent a token we didn't mint), so the library route maps it to a 400 —
 * distinct from the generic 500 a plain `Error` would collapse to.
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
 * references each of `assetIds`, so the delete reference guard can read an
 * asset's candidate referencing-app set instead of scanning every app the
 * Project has. Called by the blueprint writers on every save
 * (`syncMediaReferences`).
 *
 * Append-only by design: `ON CONFLICT DO NOTHING` is idempotent at the edge
 * level (re-adding a present `(asset, app)` leaves the set unchanged) and never
 * removes an app that stopped referencing the asset — the guard re-walks each
 * candidate to confirm + prune-by-omission, so a stale edge costs one extra app
 * load, never a wrong block. An empty `assetIds` (the overwhelming common case —
 * no media) does nothing.
 *
 * Each asset is written INDEPENDENTLY (settled, not one atomic batch): a saved
 * blueprint can carry a dangling asset id — a ref to a recovered or purged asset
 * with no `media_assets` row — and the `media_asset_refs.asset_id` foreign key
 * rejects the insert. In an atomic batch that one bad ref would drop EVERY edge
 * in the save; settled independently, the bogus id skips itself and every valid
 * edge still lands.
 */
export async function addReferencingApp(
	assetIds: readonly string[],
	appId: string,
): Promise<void> {
	const unique = [...new Set(assetIds)];
	if (unique.length === 0) return;
	const db = await getAppDb();
	const results = await Promise.allSettled(
		unique.map((assetId) =>
			db
				.insertInto("media_asset_refs")
				.values({ asset_id: assetId, app_id: appId })
				.onConflict((oc) => oc.columns(["asset_id", "app_id"]).doNothing())
				.execute(),
		),
	);
	results.forEach((r, i) => {
		// A rejection is almost always a dangling ref (no asset row → FK
		// violation). The valid edges still landed; log the orphan so it's
		// diagnosable, don't throw.
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
 * The apps whose persisted blueprint has EVER referenced `assetId` — the asset's
 * reverse-index candidate set (`media_asset_refs`), read by the deletion guard
 * so it re-walks only the 0–2 candidates instead of the Project's whole app
 * list. Append-only, so a candidate may be stale; the guard re-walks each to
 * confirm.
 */
export async function listReferencingAppIds(
	assetId: string,
): Promise<string[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("media_asset_refs")
		.select("app_id")
		.where("asset_id", "=", assetId)
		.execute();
	return rows.map((row) => row.app_id);
}

/**
 * Hard-delete an asset row. Caller is responsible for the GCS object cleanup AND
 * for ensuring no live blueprint references the asset — the deletion MCP tool
 * refuses to call this if any reference is found. The `media_asset_refs` edges
 * cascade on the row delete.
 */
export async function deleteAsset(assetId: AssetId): Promise<void> {
	const db = await getAppDb();
	await db.deleteFrom("media_assets").where("id", "=", assetId).execute();
}
