// lib/media/assetDeletion.ts
//
// Shared media-asset deletion: the reference guard + the storage purge that BOTH
// the SA's `remove_media_asset` tool and the browser DELETE route go through, so
// there is ONE deletion implementation rather than two that drift.
//
// Two concerns live here:
//   - `findAppReferencesToAsset` — a fast UX preflight over reverse-index
//     candidates. The authoritative full persisted-carrier check lives in the
//     metadata-delete transaction (`lib/db/mediaDeletion.ts`); an empty preflight
//     never authorizes deletion.
//   - `purgeAssetStorage` — drop the asset row, then the GCS bytes (and any
//     content-addressed siblings, e.g. a document's extract) only when no other
//     asset row shares the bytes.
//
// Carrier phrasing comes from the shared `describeCarrier` (lib/domain/mediaRefs)
// so the refusal message and the upload-attach warning name a carrier the same
// way — no wire vocabulary.

import { loadApp } from "@/lib/db/apps";
import {
	deleteAsset as deleteAssetRow,
	hasAssetForGcsObjectKey,
	hasOtherAssetForGcsObjectKey,
	hasReadyExtractForProjectAndHash,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import {
	asWalkableDoc,
	describeCarrier,
	walkAssetRefs,
} from "@/lib/domain/mediaRefs";
import {
	EXTRACTOR_VERSION,
	extractObjectKeyForAsset,
} from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { deleteAsset as deleteGcsObject } from "@/lib/storage/media";
import { withMediaObjectKeyLock } from "@/lib/storage/mediaObjectKeyLock";

/** Stop after this many referencing apps — the refusal only needs to name a few
 *  to be actionable, and an unbounded scan over a large account is wasteful. */
const APP_REF_LIMIT = 5;

/**
 * The carriers in `doc` that reference `assetId`, each rendered as an
 * authoring-layer phrase ("the app logo", "the icon on module X"), de-duplicated
 * so one asset on two slots of the same form reads once. Empty when the doc
 * doesn't reference the asset.
 *
 * The single carrier-walk both delete surfaces share: the SA tool's in-hand
 * working-doc check (`removeMediaAsset`) and the guard's persisted-doc re-walk
 * (`describeAppReference`). Keeping it one function is what stops the two refusal
 * messages from drifting on how carriers are phrased or de-duplicated.
 */
export function carriersForAsset(doc: BlueprintDoc, assetId: string): string[] {
	return [
		...new Set(
			[...walkAssetRefs(doc)]
				.filter((ref) => ref.assetId === assetId)
				.map(describeCarrier),
		),
	];
}

/**
 * Resolve the carriers in ONE app's persisted doc that still reference the
 * asset, as a human-readable refusal phrase — or `null` when the app is
 * gone/out-of-Project/deleted or no longer references it (a stale index
 * candidate).
 */
async function describeAppReference(
	appId: string,
	projectId: string,
	assetId: string,
): Promise<string | null> {
	const app = await loadApp(appId);
	// This fast UX preflight skips list-hidden deleted apps and guards a list/load
	// Project skew. The authoritative transaction re-walks persisted recoverable
	// apps too, so skipping one here can delay the refusal but never authorize a
	// destructive delete. Owner is irrelevant: every Project member shares media.
	if (!app || app.project_id !== projectId || app.deleted_at !== null) {
		return null;
	}
	const carriers = carriersForAsset(asWalkableDoc(app.blueprint), assetId);
	if (carriers.length === 0) return null;
	return `"${app.app_name}" (${appId}) on ${carriers.join("; ")}`;
}

/**
 * Find which of the Project's live apps still reference the asset, returning a
 * human-readable description per referencing app (capped at `APP_REF_LIMIT`). An
 * empty array means no indexed candidate currently uses it; only the
 * authoritative delete transaction may decide that the asset is safe.
 *
 * `candidateAppIds` is the asset's reverse index (`media_asset_refs`, read via
 * `listReferencingAppIds`): the only apps whose persisted blueprint has EVER
 * referenced it. Passing it turns the guard from "load every app the Project
 * has" (measured 8s on an 83-app account) into "load only the 0–2 apps that
 * might reference it". The index is append-only, so a candidate may be STALE —
 * this re-walks each candidate's live doc to confirm a real reference and name
 * the carrier, so a stale entry simply drops out (yields `null`).
 *
 * This helper is intentionally only a latency optimization. Deletion full-scans
 * while the durable completeness marker is unset and may narrow to this index
 * only after an audited backfill stamps it complete.
 *
 * `skipAppId` omits one app the caller checks separately — the SA tool checks
 * its in-hand working doc (which may carry unsaved mutations the persisted copy
 * lacks) and passes its app id here so the same app isn't double-counted.
 */
export async function findAppReferencesToAsset(
	projectId: string,
	assetId: string,
	candidateAppIds: readonly string[],
	opts: { skipAppId?: string } = {},
): Promise<string[]> {
	const candidates = [...new Set(candidateAppIds)].filter(
		(id) => id !== opts.skipAppId,
	);
	// The candidate set is tiny (sparse media references), so load them together
	// and confirm each. Drop the nulls (gone / out-of-Project / stale), cap to the
	// few the refusal needs to be actionable.
	const descriptions = await Promise.all(
		candidates.map((id) => describeAppReference(id, projectId, assetId)),
	);
	return descriptions
		.filter((d): d is string => d !== null)
		.slice(0, APP_REF_LIMIT);
}

/**
 * Remove the asset's storage: drop the asset row FIRST (so a storage-cleanup
 * failure can only orphan a blob, never leave a `ready` row pointing at missing
 * bytes), then delete the GCS bytes and any `alsoDelete` siblings — but only when
 * no other asset row shares each object. Base bytes are extension-qualified, so
 * their last-reference probe is the exact GCS key. Document extracts omit the
 * source extension, so their probe is `(Project, content hash, version)`; this
 * keeps a shared extract alive when identical text bytes have both `.txt` and
 * `.md` rows. A failed probe fails closed (retain), so we never delete an object
 * another row still points at.
 *
 * Callers are responsible for supplying an authoritative metadata-delete
 * callback when the operation is actor-facing. `alsoDelete` carries content-addressed sibling keys (e.g.
 * `extractObjectKeyForAsset(asset)` for a document); `deleteGcsObject` ignores a
 * missing object, so passing a key whose object was never written is a no-op.
 */
export async function purgeAssetStorage(
	asset: MediaAssetRecord,
	opts: {
		alsoDelete?: ReadonlyArray<string | null>;
		alsoDeleteForAsset?: (
			deletedAsset: MediaAssetRecord,
		) => ReadonlyArray<string | null>;
		/** Optional authoritative metadata delete. It must commit before this
		 * function touches GCS. Return the locked deleted record when metadata
		 * could have changed since the caller's preflight; false means the row no
		 * longer exists. `true` retains the caller's snapshot for legacy seams. */
		deleteRow?: () => Promise<boolean | MediaAssetRecord>;
	} = {},
): Promise<boolean> {
	let deletedAsset = asset;
	if (opts.deleteRow) {
		const result = await opts.deleteRow();
		if (result === false) return false;
		if (result !== true) deletedAsset = result;
	} else {
		await deleteAssetRow(asset.id);
	}
	await cleanupReleasedAssetStorage(deletedAsset, {
		alsoDelete: [
			...(opts.alsoDelete ?? []),
			...(opts.alsoDeleteForAsset?.(deletedAsset) ?? []),
		],
	});
	return true;
}

/**
 * Clean objects after metadata stopped naming `asset.gcsObjectKey`.
 *
 * This is split from {@link purgeAssetStorage} for publication paths that
 * replace or delete metadata while already holding the canonical destination
 * key lock. They release that lock first, then call this helper for the old
 * (usually per-attempt pending) key. Keeping the object cleanup outside the
 * publication critical section avoids recursively taking the same session
 * advisory lock while preserving the metadata-first invariant.
 */
export async function cleanupReleasedAssetStorage(
	asset: MediaAssetRecord,
	opts: { alsoDelete?: ReadonlyArray<string | null> } = {},
): Promise<void> {
	// Metadata commits before object cleanup. Under the canonical Project/hash
	// lock, re-read siblings AFTER that commit; a publisher of the same content
	// (including a different source extension) holds this lock across bytes +
	// ready-row publication, so either its row is visible and shared objects stay,
	// or it publishes only after this cleanup finishes.
	await withMediaObjectKeyLock(asset.gcsObjectKey, async (lockedDb) => {
		const sharedBaseObject = await hasOtherAssetForGcsObjectKey(
			asset.gcsObjectKey,
			asset.id,
			lockedDb,
		).catch((err: unknown) => {
			log.error("[asset-deletion] shared-object check failed", err, {
				assetId: asset.id,
				gcsObjectKey: asset.gcsObjectKey,
			});
			return true;
		});
		if (!sharedBaseObject) {
			await deleteGcsObject(asset.gcsObjectKey);
		}

		const extractKey = extractObjectKeyForAsset(asset);
		const deletesExtract = (opts.alsoDelete ?? []).some(
			(key) => key !== null && key === extractKey,
		);
		const extractVersion = asset.extract?.version ?? EXTRACTOR_VERSION;
		const sharedReadyExtract = deletesExtract
			? await hasReadyExtractForProjectAndHash(
					asset.project_id,
					asset.contentHash,
					extractVersion,
					lockedDb,
				).catch((err: unknown) => {
					log.error("[asset-deletion] shared-extract check failed", err, {
						assetId: asset.id,
						projectId: asset.project_id,
						contentHash: asset.contentHash,
						version: extractVersion,
					});
					return true;
				})
			: false;

		for (const key of opts.alsoDelete ?? []) {
			if (!key) continue;
			const shared = key === extractKey ? sharedReadyExtract : sharedBaseObject;
			if (!shared) await deleteGcsObject(key);
		}
	});
}

/**
 * Remove a final object copied by a publication attempt whose metadata commit
 * lost. Reacquire the canonical key lock after the failed publisher released
 * it, then retain bytes if ANY row names the key — including the same asset id,
 * because a retry may have successfully published while this cleanup waited.
 */
export async function cleanupUnpublishedAssetObject(
	gcsObjectKey: string,
): Promise<void> {
	await withMediaObjectKeyLock(gcsObjectKey, async (lockedDb) => {
		const published = await hasAssetForGcsObjectKey(
			gcsObjectKey,
			lockedDb,
		).catch((err: unknown) => {
			log.error("[asset-publication] published-object check failed", err, {
				gcsObjectKey,
			});
			return true;
		});
		if (!published) await deleteGcsObject(gcsObjectKey);
	});
}
