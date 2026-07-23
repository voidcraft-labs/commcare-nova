/**
 * Media asset CRUD against Postgres.
 *
 * The asset row lives in `media_assets` (keyed by the asset's UUID); the
 * referencing-apps reverse index lives in the `media_asset_refs` join table
 * (one row per `(asset, app)` candidate edge). A successful browser confirm
 * that deduplicates to another row leaves a 24-hour `media_upload_aliases`
 * replay record keyed by the original attempt id. `project_id` is the tenant
 * and the only access gate — every read SITE authorizes Project membership on
 * the returned `project_id` before serving bytes or metadata.
 *
 * The record builders `Number(...)` the `bigint` columns (`size_bytes`,
 * `duration_ms`) that pg returns as strings, and parse the `extract` jsonb
 * through `mediaAssetExtractSchema` (tolerating a null column).
 */

import { randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
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
import { projectRoleForInTransaction } from "./projectMembership";
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

/** Identity of one extraction claim. `extractedAt` is the row-stored fencing
 * token, not merely display metadata: a stale job may publish only while this
 * exact claim still owns the asset's extract slot. */
export interface AssetExtractionClaim {
	readonly version: number;
	readonly model: string;
	readonly extractedAt: number;
}

export type AssetExtractionClaimResult =
	| { readonly kind: "claimed"; readonly claim: AssetExtractionClaim }
	| { readonly kind: "in_flight" }
	| { readonly kind: "superseded"; readonly extract: MediaAssetExtract }
	| { readonly kind: "not_found" };

export type ClaimedExtractPublicationResult =
	| { readonly kind: "published"; readonly extract: MediaAssetExtract }
	| { readonly kind: "adopted"; readonly extract: MediaAssetExtract }
	| {
			readonly kind: "superseded";
			readonly extract: MediaAssetExtract | null;
	  }
	| { readonly kind: "not_found" };

/** Assemble a `media_assets` row into the in-memory `MediaAssetRecord`. */
export function mediaAssetRecordFromRow(
	row: Selectable<MediaAssetsTable>,
): MediaAssetRecord {
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
export async function createPendingAsset(
	args: {
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
	},
	lockedDb?: Kysely<AppDatabase>,
): Promise<{
	assetId: AssetId;
	gcsObjectKey: string;
}> {
	const assetId = asAssetId(randomUUID());
	const gcsObjectKey =
		args.gcsObjectKey ??
		pendingGcsObjectKeyFor(args.project_id, assetId, args.extension);
	const db = lockedDb ?? (await getAppDb());
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
export async function confirmAssetReady(
	args: {
		assetId: AssetId;
		gcsObjectKey?: string;
		mimeType?: AssetMimeType;
		extension?: string;
		dimensions?: { width: number; height: number };
		durationMs?: number;
	},
	lockedDb?: Kysely<AppDatabase>,
): Promise<void> {
	const db = lockedDb ?? (await getAppDb());
	const result = await db
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
		.executeTakeFirst();
	/* The row can vanish between the confirm's byte validation and this flip
	 * (a co-member's library delete, a retried confirm) — a 0-row update must
	 * FAIL the confirm request at the race, not report a ready asset whose
	 * dangling reference then rejects far away at the commit gate or export. */
	if (Number(result.numUpdatedRows) === 0) {
		throw new Error(
			`[confirmAssetReady] asset row missing for assetId=${args.assetId} — it was deleted while the upload was being confirmed.`,
		);
	}
}

export type PendingAssetPublicationResult =
	| { readonly kind: "published"; readonly asset: MediaAssetRecord }
	| { readonly kind: "already_ready"; readonly asset: MediaAssetRecord }
	| { readonly kind: "not_found" };

/**
 * Freshly authorize and atomically publish one browser upload.
 *
 * The caller holds the canonical final-object key lock and has already copied
 * validated bytes. Membership is re-proved before the asset row lock, matching
 * deletion's membership -> asset order. A stale duplicate confirm that wakes
 * after another request published returns the authoritative ready row; it never
 * rewrites or deletes terminal state.
 */
export async function publishPendingAssetForActor(
	args: {
		assetId: AssetId;
		actorUserId: string;
		expectedProjectId: string;
		gcsObjectKey: string;
		mimeType: AssetMimeType;
		extension: string;
		dimensions?: { width: number; height: number };
		durationMs?: number;
	},
	lockedDb: Kysely<AppDatabase>,
): Promise<PendingAssetPublicationResult> {
	return lockedDb.transaction().execute(async (tx) => {
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			return { kind: "not_found" };
		}
		const row = await tx
			.selectFrom("media_assets")
			.selectAll()
			.where("id", "=", args.assetId)
			.where("project_id", "=", args.expectedProjectId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "not_found" };
		const current = mediaAssetRecordFromRow(row);
		if (current.status === "ready") {
			return { kind: "already_ready", asset: current };
		}
		if (current.status !== "pending") {
			return { kind: "not_found" };
		}
		const published = await tx
			.updateTable("media_assets")
			.set({
				status: "ready",
				gcs_object_key: args.gcsObjectKey,
				mime_type: args.mimeType,
				extension: args.extension,
				...(args.dimensions && {
					dimensions: JSON.stringify(args.dimensions),
				}),
				...(args.durationMs !== undefined && {
					duration_ms: args.durationMs,
				}),
			})
			.where("id", "=", args.assetId)
			.where("status", "=", "pending")
			.returningAll()
			.executeTakeFirst();
		if (published === undefined) return { kind: "not_found" };
		return { kind: "published", asset: mediaAssetRecordFromRow(published) };
	});
}

export type PendingAssetDeleteResult =
	| { readonly kind: "deleted"; readonly asset: MediaAssetRecord }
	| { readonly kind: "already_ready"; readonly asset: MediaAssetRecord }
	| { readonly kind: "not_found" };

/**
 * Delete only a still-pending browser attempt under fresh Project authority.
 * A stale validation failure that loses to publication observes `ready` and
 * returns it idempotently instead of deleting terminal metadata.
 */
export async function deletePendingAssetForActor(
	args: {
		assetId: AssetId;
		actorUserId: string;
		expectedProjectId: string;
	},
	lockedDb?: Kysely<AppDatabase>,
): Promise<PendingAssetDeleteResult> {
	const db = lockedDb ?? (await getAppDb());
	return db.transaction().execute(async (tx) => {
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			return { kind: "not_found" };
		}
		const row = await tx
			.selectFrom("media_assets")
			.selectAll()
			.where("id", "=", args.assetId)
			.where("project_id", "=", args.expectedProjectId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "not_found" };
		const current = mediaAssetRecordFromRow(row);
		if (current.status === "ready") {
			return { kind: "already_ready", asset: current };
		}
		if (current.status !== "pending") return { kind: "not_found" };
		const deleted = await tx
			.deleteFrom("media_assets")
			.where("id", "=", args.assetId)
			.where("status", "=", "pending")
			.executeTakeFirst();
		return Number(deleted.numDeletedRows) === 1
			? { kind: "deleted", asset: current }
			: { kind: "not_found" };
	});
}

export type PendingAssetCanonicalizationResult =
	| {
			readonly kind: "canonicalized";
			readonly asset: MediaAssetRecord;
			readonly releasedPending: MediaAssetRecord;
	  }
	| { readonly kind: "already_canonical"; readonly asset: MediaAssetRecord }
	| { readonly kind: "already_ready"; readonly asset: MediaAssetRecord }
	| { readonly kind: "not_found" };

/**
 * Atomically replace one pending upload attempt with a durable pointer to an
 * already-ready Project/hash sibling.
 *
 * The caller holds the canonical content-object lock. Fresh Project edit
 * authority is proved before asset rows; the attempt and candidate are then
 * locked in lexical id order. The alias INSERT and pending-row DELETE share one
 * transaction, so a successful response can always be replayed by the original
 * attempt id. A same-attempt loser whose row is already gone resolves the
 * existing alias instead of inferring a sibling from the hash.
 */
export async function canonicalizePendingAssetForActor(
	args: {
		attemptAssetId: AssetId;
		canonicalAssetId: AssetId;
		actorUserId: string;
		expectedProjectId: string;
		expectedContentHash: string;
	},
	lockedDb: Kysely<AppDatabase>,
): Promise<PendingAssetCanonicalizationResult> {
	return lockedDb.transaction().execute(async (tx) => {
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			return { kind: "not_found" };
		}

		// Avoid locking a caller-supplied canonical row when this is already a
		// retry whose attempt row vanished. The alias is the only durable
		// authority in that state.
		const attemptSnapshot = await tx
			.selectFrom("media_assets")
			.select("id")
			.where("id", "=", args.attemptAssetId)
			.where("project_id", "=", args.expectedProjectId)
			.executeTakeFirst();
		if (attemptSnapshot === undefined) {
			const replay = await resolveReadyUploadAliasInTransaction(tx, {
				attemptAssetId: args.attemptAssetId,
				actorUserId: args.actorUserId,
			});
			return replay
				? { kind: "already_canonical", asset: replay }
				: { kind: "not_found" };
		}

		const lockedRows = await tx
			.selectFrom("media_assets")
			.selectAll()
			.where("id", "in", [args.attemptAssetId, args.canonicalAssetId].sort())
			.orderBy("id")
			.forUpdate()
			.execute();
		const attemptRow = lockedRows.find((row) => row.id === args.attemptAssetId);
		if (attemptRow === undefined) {
			const replay = await resolveReadyUploadAliasInTransaction(tx, {
				attemptAssetId: args.attemptAssetId,
				actorUserId: args.actorUserId,
			});
			return replay
				? { kind: "already_canonical", asset: replay }
				: { kind: "not_found" };
		}
		const attempt = mediaAssetRecordFromRow(attemptRow);
		if (
			attempt.project_id !== args.expectedProjectId ||
			attempt.contentHash !== args.expectedContentHash
		) {
			return { kind: "not_found" };
		}
		if (attempt.status === "ready") {
			return { kind: "already_ready", asset: attempt };
		}
		if (attempt.status !== "pending") return { kind: "not_found" };

		const canonicalRow = lockedRows.find(
			(row) => row.id === args.canonicalAssetId,
		);
		if (canonicalRow === undefined) return { kind: "not_found" };
		const canonical = mediaAssetRecordFromRow(canonicalRow);
		if (
			canonical.id === attempt.id ||
			canonical.status !== "ready" ||
			canonical.project_id !== args.expectedProjectId ||
			canonical.contentHash !== args.expectedContentHash
		) {
			return { kind: "not_found" };
		}

		// A UUID collision with an expired attempt tombstone is fantastically
		// unlikely, but deleting it explicitly keeps the invariant local instead
		// of allowing a stale primary-key conflict to rewrite a past result.
		await tx
			.deleteFrom("media_upload_aliases")
			.where("attempt_asset_id", "=", args.attemptAssetId)
			.where("expires_at", "<=", sql<Date>`now()`)
			.execute();
		await tx
			.insertInto("media_upload_aliases")
			.values({
				attempt_asset_id: args.attemptAssetId,
				project_id: args.expectedProjectId,
				content_hash: args.expectedContentHash,
				canonical_asset_id: canonical.id,
			})
			.onConflict((conflict) => conflict.column("attempt_asset_id").doNothing())
			.execute();
		const alias = await tx
			.selectFrom("media_upload_aliases")
			.select(["project_id", "content_hash", "canonical_asset_id"])
			.where("attempt_asset_id", "=", args.attemptAssetId)
			.where("expires_at", ">", sql<Date>`now()`)
			.forUpdate()
			.executeTakeFirst();
		if (
			alias === undefined ||
			alias.project_id !== args.expectedProjectId ||
			alias.content_hash !== args.expectedContentHash ||
			alias.canonical_asset_id !== canonical.id
		) {
			return { kind: "not_found" };
		}

		const deleted = await tx
			.deleteFrom("media_assets")
			.where("id", "=", args.attemptAssetId)
			.where("status", "=", "pending")
			.executeTakeFirst();
		if (Number(deleted.numDeletedRows) !== 1) {
			throw new Error(
				`[canonicalizePendingAssetForActor] locked pending row was not deleted for assetId=${args.attemptAssetId}.`,
			);
		}
		return {
			kind: "canonicalized",
			asset: canonical,
			releasedPending: attempt,
		};
	});
}

/**
 * Resolve the exact durable successful result for an upload attempt whose
 * pending row no longer exists. The alias names its Project/hash as well as the
 * canonical id; resolution rechecks all three against a terminal ready row and
 * freshly proves Project edit authority before taking the asset share lock.
 */
export async function resolveReadyUploadAliasForActor(args: {
	attemptAssetId: AssetId;
	actorUserId: string;
}): Promise<MediaAssetRecord | null> {
	const db = await getAppDb();
	return db
		.transaction()
		.execute((tx) => resolveReadyUploadAliasInTransaction(tx, args));
}

async function resolveReadyUploadAliasInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		attemptAssetId: AssetId;
		actorUserId: string;
	},
): Promise<MediaAssetRecord | null> {
	const scope = await tx
		.selectFrom("media_upload_aliases")
		.select(["project_id", "content_hash", "canonical_asset_id"])
		.where("attempt_asset_id", "=", args.attemptAssetId)
		.where("expires_at", ">", sql<Date>`now()`)
		.executeTakeFirst();
	if (scope === undefined) return null;
	const role = await projectRoleForInTransaction(
		tx,
		args.actorUserId,
		scope.project_id,
	);
	if (role === null || !roleAllowsApp(role, "edit")) return null;

	const row = await tx
		.selectFrom("media_upload_aliases as alias")
		.innerJoin("media_assets as asset", "asset.id", "alias.canonical_asset_id")
		.selectAll("asset")
		.where("alias.attempt_asset_id", "=", args.attemptAssetId)
		.where("alias.project_id", "=", scope.project_id)
		.where("alias.content_hash", "=", scope.content_hash)
		.where("alias.canonical_asset_id", "=", scope.canonical_asset_id)
		.where("alias.expires_at", ">", sql<Date>`now()`)
		.where("asset.project_id", "=", scope.project_id)
		.where("asset.content_hash", "=", scope.content_hash)
		.where("asset.status", "=", "ready")
		.forShare("asset")
		.executeTakeFirst();
	return row ? mediaAssetRecordFromRow(row) : null;
}

/** Opportunistically remove a bounded oldest batch of expired replay rows. */
export async function purgeExpiredMediaUploadAliases(
	limit = 256,
): Promise<number> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
		throw new Error(
			"[purgeExpiredMediaUploadAliases] limit must be an integer from 1 to 1000.",
		);
	}
	const db = await getAppDb();
	const expired = db
		.selectFrom("media_upload_aliases")
		.select("attempt_asset_id")
		.where("expires_at", "<=", sql<Date>`now()`)
		.orderBy("expires_at")
		.orderBy("attempt_asset_id")
		.limit(limit);
	const deleted = await db
		.deleteFrom("media_upload_aliases")
		.where("attempt_asset_id", "in", expired)
		.executeTakeFirst();
	return Number(deleted.numDeletedRows);
}

export interface ReadyAssetInsert {
	assetId: AssetId;
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
	extract?: MediaAssetExtract;
}

/**
 * Insert one terminal `ready` asset with a caller-allocated id.
 *
 * The insert is the complete metadata publication: there is no separately
 * committed `pending` row or follow-up status flip. Callers that publish bytes
 * before metadata can retain `assetId` across an ambiguous commit response,
 * re-read that exact publication under their content lock, and distinguish
 * "commit succeeded" from "no metadata exists; clean the object".
 */
export async function insertReadyAsset(
	args: ReadyAssetInsert,
	lockedDb?: Kysely<AppDatabase>,
): Promise<MediaAssetRecord> {
	const insert = async (tx: Transaction<AppDatabase>) => {
		const row = await tx
			.insertInto("media_assets")
			.values({
				id: args.assetId,
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
				...(args.extract !== undefined && {
					extract: JSON.stringify(args.extract),
				}),
				status: "ready",
				created_at: new Date(),
			})
			.returningAll()
			.executeTakeFirstOrThrow();
		return mediaAssetRecordFromRow(row);
	};
	if (lockedDb) {
		return lockedDb.transaction().execute(insert);
	}
	return withAppTx(insert);
}

/**
 * Create a `ready` asset row in one shot — the cross-Project move's
 * copy-into-destination path (`lib/media/moveMedia.ts`). The bytes are already
 * validated (they are a server-side GCS copy of an existing `ready` asset), so
 * this skips the pending→confirm dance browser uploads need and writes the
 * final row directly: no lingering `pending` intermediate to strand on a crash.
 * This pre-copy step deliberately creates no app reference; the final app-move
 * transaction revalidates the destination row and inserts the exact edge only
 * when the blueprint/thread remap and Project flip commit. Returns the new id.
 */
export async function createReadyAsset(
	args: Omit<ReadyAssetInsert, "assetId">,
	lockedDb?: Kysely<AppDatabase>,
): Promise<{ assetId: AssetId }> {
	const assetId = asAssetId(randomUUID());
	await insertReadyAsset({ ...args, assetId }, lockedDb);
	return { assetId };
}

/**
 * Publish a verified ready document extract pair across duplicate asset rows.
 * The caller holds the Project/hash content lock and has either verified the
 * destination object paired with `extract`, or just copied that exact source
 * object there. Lock every duplicate row in asset-id order, preserve strictly
 * higher versions, and make all other ready rows name this one canonical pair.
 */
export async function installCopiedReadyExtract(
	args: {
		assetId: AssetId;
		extract: MediaAssetExtract;
	},
	lockedDb?: Kysely<AppDatabase>,
): Promise<MediaAssetExtract> {
	if (args.extract.status !== "ready") {
		throw new Error(
			"[installCopiedReadyExtract] only a ready source extract may be published.",
		);
	}
	const install = async (tx: Transaction<AppDatabase>) => {
		const snapshot = await tx
			.selectFrom("media_assets")
			.select(["project_id", "content_hash"])
			.where("id", "=", args.assetId)
			.executeTakeFirst();
		if (snapshot === undefined) {
			throw new Error(
				`[installCopiedReadyExtract] destination asset row missing for assetId=${args.assetId}.`,
			);
		}
		const contentRows = await tx
			.selectFrom("media_assets")
			.select(["id", "status", "extract"])
			.where("project_id", "=", snapshot.project_id)
			.where("content_hash", "=", snapshot.content_hash)
			.orderBy("id")
			.forUpdate()
			.execute();
		const target = contentRows.find((row) => row.id === args.assetId);
		if (target === undefined || target.status !== "ready") {
			throw new Error(
				`[installCopiedReadyExtract] destination asset is missing or not ready for assetId=${args.assetId}.`,
			);
		}
		const eligibleIds = contentRows
			.filter((row) => {
				if (row.status !== "ready") return false;
				if (row.extract === null) return true;
				return (
					mediaAssetExtractSchema.parse(row.extract).version <=
					args.extract.version
				);
			})
			.map((row) => asAssetId(row.id));
		if (eligibleIds.length > 0) {
			await tx
				.updateTable("media_assets")
				.set({ extract: JSON.stringify(args.extract) })
				.where("id", "in", eligibleIds)
				.execute();
		}
		if (eligibleIds.includes(args.assetId)) return args.extract;
		if (target.extract === null) {
			throw new Error(
				`[installCopiedReadyExtract] target unexpectedly lacked an eligible extract for assetId=${args.assetId}.`,
			);
		}
		return mediaAssetExtractSchema.parse(target.extract);
	};
	if (lockedDb) {
		return lockedDb.transaction().execute(install);
	}
	return withAppTx(install);
}

/**
 * Publish one claimed extraction while the caller holds the asset's canonical
 * extension-independent Project/hash content session lock.
 *
 * Lock order is canonical content -> asset row. Deletion takes the asset row
 * only for its metadata transaction, commits, and acquires the content lock
 * afterward for byte cleanup, so there is no row/key cycle. The exact claim
 * comparison fences a stale model job: Project-copy publication, a newer claim,
 * or deletion may win while the model runs, and none can be overwritten when
 * the old job eventually returns.
 *
 * For a ready result, `publishReadyObject` runs after the row is locked and the
 * claim is proven, but before ready metadata is committed. Thus a delete winner
 * yields `not_found` without recreating an extract object; a publication winner
 * makes its GCS object and matching metadata visible as one serialized pair.
 */
export async function publishClaimedAssetExtract(
	args: {
		readonly assetId: AssetId;
		readonly claim: AssetExtractionClaim;
		readonly extract: Omit<MediaAssetExtract, "extractedAt" | "status"> & {
			readonly status: "ready" | "failed";
		};
		readonly publishReadyObject?: () => Promise<void>;
		/** A committed same-content pair whose object the caller verified while
		 * holding the content lock. Adopt it instead of overwriting the shared
		 * object with this job's independently generated output. */
		readonly sharedReadyExtract?: MediaAssetExtract;
	},
	lockedDb: Kysely<AppDatabase>,
): Promise<ClaimedExtractPublicationResult> {
	return lockedDb.transaction().execute(async (tx) => {
		const snapshot = await tx
			.selectFrom("media_assets")
			.select(["project_id", "content_hash"])
			.where("id", "=", args.assetId)
			.executeTakeFirst();
		if (snapshot === undefined) return { kind: "not_found" };

		// Extraction metadata is content-scoped even though callers address one
		// asset id. Lock every duplicate row in global asset-id order from the
		// outset: app writers use the same sorted order for their `FOR SHARE`
		// admission locks, so starting with an arbitrary current row and then a
		// lower-id sibling would introduce a row-lock cycle.
		const contentRows = await tx
			.selectFrom("media_assets")
			.select(["id", "status", "extract"])
			.where("project_id", "=", snapshot.project_id)
			.where("content_hash", "=", snapshot.content_hash)
			.orderBy("id")
			.forUpdate()
			.execute();
		const row = contentRows.find((candidate) => candidate.id === args.assetId);
		if (row === undefined) return { kind: "not_found" };

		const current =
			row.extract === null ? null : mediaAssetExtractSchema.parse(row.extract);
		const ownsClaim =
			current?.status === "extracting" &&
			current.version === args.claim.version &&
			current.model === args.claim.model &&
			current.extractedAt === args.claim.extractedAt;
		if (!ownsClaim) return { kind: "superseded", extract: current };

		if (args.sharedReadyExtract !== undefined) {
			if (
				args.sharedReadyExtract.status !== "ready" ||
				args.sharedReadyExtract.version !== args.claim.version
			) {
				throw new Error(
					"[publishClaimedAssetExtract] shared extract must be ready at the claim version.",
				);
			}
			await tx
				.updateTable("media_assets")
				.set({ extract: JSON.stringify(args.sharedReadyExtract) })
				.where("id", "=", args.assetId)
				.execute();
			return { kind: "adopted", extract: args.sharedReadyExtract };
		}

		if (args.extract.status === "ready") {
			if (args.publishReadyObject === undefined) {
				throw new Error(
					"[publishClaimedAssetExtract] ready publication requires its GCS object callback.",
				);
			}
			await args.publishReadyObject();
		}
		const extract = mediaAssetExtractSchema.parse({
			...args.extract,
			extractedAt: Date.now(),
		});

		let synchronizedAssetIds = [args.assetId];
		if (extract.status === "ready" && row.status === "ready") {
			// Every ready asset row for this Project/hash/version points at ONE
			// shared extract object. Advance every non-newer state in the already
			// sorted/locked content set to the same metadata, so two rows that
			// claimed concurrently cannot leave one object paired with two model
			// summaries/truncation records. A higher version always wins.
			synchronizedAssetIds = contentRows
				.filter((sibling) => {
					if (sibling.status !== "ready") return false;
					if (sibling.extract === null) return true;
					const siblingExtract = mediaAssetExtractSchema.parse(sibling.extract);
					return siblingExtract.version <= extract.version;
				})
				.map((sibling) => asAssetId(sibling.id));
		}
		await tx
			.updateTable("media_assets")
			.set({ extract: JSON.stringify(extract) })
			.where("id", "in", synchronizedAssetIds)
			.execute();
		return { kind: "published", extract };
	});
}

/**
 * Atomically claim a document's extraction. In ONE transaction, re-read the
 * extract status under a row lock and write `extracting` only if no LIVE current
 * job already holds it — a job is live iff its status is `extracting`, at
 * `currentVersion`, and younger than `staleMs` (a dead process leaves a stale
 * `extracting` record that is reclaimable). A higher-version state always
 * supersedes an older binary's request, regardless of status, so a rolling
 * server fleet cannot regress ready metadata. Returns the exact fencing claim
 * when this caller acquired it, `in_flight` for a live same-version job,
 * `superseded` for any higher-version state, or `not_found` when deletion won.
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
): Promise<AssetExtractionClaimResult> {
	return withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("media_assets")
			.select("extract")
			.where("id", "=", assetId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "not_found" };
		const extract =
			row.extract === null ? null : mediaAssetExtractSchema.parse(row.extract);
		if (extract !== null && extract.version > opts.currentVersion) {
			return { kind: "superseded", extract };
		}
		const liveJob =
			extract?.status === "extracting" &&
			extract.version === opts.currentVersion &&
			typeof extract.extractedAt === "number" &&
			opts.now - extract.extractedAt < opts.staleMs;
		if (liveJob) return { kind: "in_flight" };
		const claim: AssetExtractionClaim = {
			version: opts.currentVersion,
			model: opts.model,
			extractedAt: opts.now,
		};
		await tx
			.updateTable("media_assets")
			.set({
				extract: JSON.stringify({
					status: "extracting",
					version: claim.version,
					model: claim.model,
					truncated: false,
					charCount: 0,
					extractedAt: claim.extractedAt,
				}),
			})
			.where("id", "=", assetId)
			.execute();
		return { kind: "claimed", claim };
	});
}

/**
 * True when another row points at the same GCS object. Used before deleting
 * bytes: duplicate-ready races and legacy content-hash-keyed rows can share
 * storage, so a row delete must not blindly remove the object out from under a
 * sibling.
 *
 * Correct callers invoke this only while holding the canonical object-key
 * session advisory lock, after the deleted metadata committed. Every publisher
 * holds that same lock across object publication and committed ready metadata,
 * so the re-read is the serialized last-reference decision even though GCS and
 * Postgres do not share a transaction. A query failure still fails closed:
 * retain bytes rather than risk another row's object.
 */
export async function hasOtherAssetForGcsObjectKey(
	gcsObjectKey: string,
	excludeAssetId: AssetId,
	lockedDb?: Kysely<AppDatabase>,
): Promise<boolean> {
	const db = lockedDb ?? (await getAppDb());
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
 * True when any committed asset row currently names a GCS object key.
 * Lost-publication cleanup uses this under the canonical key lock and must NOT
 * exclude the attempted asset id: a retry of that same upload may have won and
 * published the row while cleanup waited to reacquire the lock.
 */
export async function hasAssetForGcsObjectKey(
	gcsObjectKey: string,
	lockedDb?: Kysely<AppDatabase>,
): Promise<boolean> {
	const db = lockedDb ?? (await getAppDb());
	const row = await db
		.selectFrom("media_assets")
		.select("id")
		.where("gcs_object_key", "=", gcsObjectKey)
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
}

/**
 * Whether any committed asset row for this content names a ready extract at
 * `version`. Failed ready-publication cleanup calls this while holding the
 * canonical Project/hash content lock: retain the shared extract object if a deduplicated
 * sibling already published the same version.
 */
export async function hasReadyExtractForProjectAndHash(
	projectId: string,
	contentHash: string,
	version: number,
	lockedDb: Kysely<AppDatabase>,
): Promise<boolean> {
	return (
		(await findReadyExtractForProjectAndHash(
			projectId,
			contentHash,
			version,
			lockedDb,
		)) !== null
	);
}

/**
 * The canonical committed ready metadata for one shared extract object, if any.
 * Callers pair this with a read of the versioned object while holding the
 * Project/hash content lock before adopting it onto another duplicate row.
 */
export async function findReadyExtractForProjectAndHash(
	projectId: string,
	contentHash: string,
	version: number,
	lockedDb: Kysely<AppDatabase>,
): Promise<MediaAssetExtract | null> {
	const rows = await lockedDb
		.selectFrom("media_assets")
		.select(["id", "extract"])
		.where("project_id", "=", projectId)
		.where("content_hash", "=", contentHash)
		.where("status", "=", "ready")
		.orderBy("id")
		.execute();
	for (const row of rows) {
		if (row.extract === null) continue;
		const extract = mediaAssetExtractSchema.parse(row.extract);
		if (extract.status === "ready" && extract.version === version) {
			return extract;
		}
	}
	return null;
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
	lockedDb?: Kysely<AppDatabase>,
): Promise<MediaAssetRecord | null> {
	const db = lockedDb ?? (await getAppDb());
	const row = await db
		.selectFrom("media_assets")
		.selectAll()
		.where("project_id", "=", projectId)
		.where("content_hash", "=", contentHash)
		.where("status", "=", "ready")
		.orderBy("created_at")
		.orderBy("id")
		.limit(1)
		.executeTakeFirst();
	return row ? mediaAssetRecordFromRow(row) : null;
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
	return row ? mediaAssetRecordFromRow(row) : null;
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
		.map((row) => mediaAssetRecordFromRow(row));
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
		.orderBy("id")
		.forShare()
		.execute();
	for (const row of rows) out.set(row.id, mediaAssetRecordFromRow(row));
	return out;
}

/** Page size for the library list — matches the apps route's `JSON_LIST_PAGE_SIZE`. */
const LIBRARY_PAGE_SIZE = 50;

/**
 * Cursor-paginated list of a Project's `ready` assets, newest first. Kind and
 * name filters run in Postgres BEFORE pagination — never over one client page.
 * That makes both "All" and search authoritative across the Project's whole
 * authorized library: a matching older file cannot be buried behind a page of
 * newer non-matches while the picker incorrectly says there are no results.
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
	options: {
		kinds?: readonly AssetKind[];
		cursor?: string;
		/** Case-insensitive literal substring matched against the visible file name
		 *  and a document's extracted title. Whitespace-only means no search. */
		query?: string;
	} = {},
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
	const normalizedQuery = options.query?.trim();
	if (normalizedQuery) {
		// `position` treats `%` / `_` as ordinary user text (unlike LIKE), while
		// Kysely binds the query as a parameter. `concat_ws` searches exactly the
		// names the library renders: display/filename plus extracted document title.
		query = query.where(
			sql<boolean>`position(lower(${normalizedQuery}) in lower(concat_ws(' ', coalesce(display_name, original_filename), extract ->> 'title'))) > 0`,
		);
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
	const assets = rows.map((row) => mediaAssetRecordFromRow(row));
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
 * Persist newly introduced reverse edges on the authoritative app-write
 * transaction. Callers must already hold every named asset `FOR SHARE` and
 * have validated its Project/readiness; an FK failure therefore aborts the app
 * write instead of silently leaving the completeness protocol behind.
 */
export async function addReferencingAppInTransaction(
	tx: Transaction<AppDatabase>,
	assetIds: readonly string[],
	appId: string,
): Promise<void> {
	const unique = [...new Set(assetIds)].sort();
	if (unique.length === 0) return;
	await tx
		.insertInto("media_asset_refs")
		.values(unique.map((assetId) => ({ asset_id: assetId, app_id: appId })))
		.onConflict((oc) => oc.columns(["asset_id", "app_id"]).doNothing())
		.execute();
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
export async function deleteAsset(
	assetId: AssetId,
	lockedDb?: Kysely<AppDatabase>,
): Promise<void> {
	const db = lockedDb ?? (await getAppDb());
	await db.deleteFrom("media_assets").where("id", "=", assetId).execute();
}
