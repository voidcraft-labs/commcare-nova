// lib/media/assetDeletion.ts
//
// Shared media-asset deletion: the reference guard + the storage purge that BOTH
// the SA's `remove_media_asset` tool and the browser DELETE route go through, so
// there is ONE deletion implementation rather than two that drift.
//
// Two concerns live here:
//   - `findAppReferencesToAsset` — find the live apps whose carriers still point
//     at the asset, so a delete can refuse (and name the slots) rather than
//     orphaning a live reference the export boundary gate would later reject far
//     from where it could be fixed. It re-walks the asset's `referencingAppIds`
//     reverse index (the 0–2 candidate apps), NOT the owner's whole app list;
//     the owner-wide scan survives only as the fallback for un-indexed rows.
//   - `purgeAssetStorage` — drop the Firestore row, then the GCS bytes (and any
//     content-addressed siblings, e.g. a document's extract) only when no other
//     asset row shares the bytes.
//
// `describeCarrier` renders a reference into the authoring layer's own nouns
// (module / form / field / option / logo) for the refusal message — no wire
// vocabulary.

import { listApps, loadApp } from "@/lib/db/apps";
import {
	deleteAsset as deleteAssetRow,
	hasOtherAssetForGcsObjectKey,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import {
	type AssetRef,
	asWalkableDoc,
	walkAssetRefs,
} from "@/lib/domain/mediaRefs";
import { log } from "@/lib/logger";
import { deleteAsset as deleteGcsObject } from "@/lib/storage/media";

/** Apps scanned per page in the full-scan fallback (un-backfilled assets). */
const APP_SCAN_PAGE_SIZE = 50;
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
 * gone/foreign/deleted or no longer references it (a stale index candidate).
 */
async function describeAppReference(
	appId: string,
	ownerId: string,
	assetId: string,
): Promise<string | null> {
	const app = await loadApp(appId);
	// Guard against a deleted app or a list/load ownership skew — only a live,
	// owner-held app's references should block a delete.
	if (!app || app.owner !== ownerId || app.deleted_at !== null) return null;
	const carriers = carriersForAsset(asWalkableDoc(app.blueprint), assetId);
	if (carriers.length === 0) return null;
	return `"${app.app_name}" (${appId}) on ${carriers.join("; ")}`;
}

/**
 * Find which of the owner's live apps still reference the asset, returning a
 * human-readable description per referencing app (capped at `APP_REF_LIMIT`). An
 * empty array means no persisted app uses it — the asset is safe to delete.
 *
 * `candidateAppIds` is the asset's reverse index (`referencingAppIds`): the only
 * apps whose persisted blueprint has EVER referenced it. Passing it turns the
 * guard from "load every app the owner has" (measured 8s on an 83-app account)
 * into "load only the 0–2 apps that might reference it". The index is
 * append-only, so a candidate may be STALE — this re-walks each candidate's live
 * doc to confirm a real reference and name the carrier, so a stale entry simply
 * drops out (yields `null`).
 *
 * `undefined` candidates means the asset row predates the index and was never
 * backfilled — there's no candidate set to trust, so this falls back to the full
 * owner-wide scan (correct, just slow). After the backfill migration no live row
 * is `undefined`, so the fallback is transitional.
 *
 * `skipAppId` omits one app the caller checks separately — the SA tool checks
 * its in-hand working doc (which may carry unsaved mutations the persisted copy
 * lacks) and passes its app id here so the same app isn't double-counted.
 */
export async function findAppReferencesToAsset(
	ownerId: string,
	assetId: string,
	candidateAppIds: readonly string[] | undefined,
	opts: { skipAppId?: string } = {},
): Promise<string[]> {
	if (candidateAppIds === undefined) {
		return scanAllAppsForReferences(ownerId, assetId, opts);
	}
	const candidates = [...new Set(candidateAppIds)].filter(
		(id) => id !== opts.skipAppId,
	);
	// The candidate set is tiny (sparse media references), so load them together
	// and confirm each. Drop the nulls (gone / foreign / stale), cap to the few
	// the refusal needs to be actionable.
	const descriptions = await Promise.all(
		candidates.map((id) => describeAppReference(id, ownerId, assetId)),
	);
	return descriptions
		.filter((d): d is string => d !== null)
		.slice(0, APP_REF_LIMIT);
}

/**
 * Full owner-wide scan: page every live app, load its doc, walk its refs. The
 * pre-index behavior, kept ONLY as the fallback for an un-backfilled asset row
 * (`referencingAppIds` absent). Slow by construction — it loads every app's
 * blueprint — which is exactly why the index path above exists.
 */
async function scanAllAppsForReferences(
	ownerId: string,
	assetId: string,
	opts: { skipAppId?: string },
): Promise<string[]> {
	const references: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await listApps(ownerId, {
			limit: APP_SCAN_PAGE_SIZE,
			sort: "updated_desc",
			cursor,
		});
		for (const summary of page.apps) {
			if (summary.id === opts.skipAppId) continue;
			const description = await describeAppReference(
				summary.id,
				ownerId,
				assetId,
			);
			if (description === null) continue;
			references.push(description);
			if (references.length >= APP_REF_LIMIT) return references;
		}
		cursor = page.nextCursor;
	} while (cursor);
	return references;
}

/**
 * Remove the asset's storage: drop the Firestore row FIRST (so a storage-cleanup
 * failure can only orphan a blob, never leave a `ready` row pointing at missing
 * bytes), then delete the GCS bytes and any `alsoDelete` siblings — but only when
 * no other asset row shares the bytes. The bytes object is content-hash keyed, so
 * a same-bytes sibling (a duplicate-upload row) shares both the bytes AND every
 * content-addressed sibling (a document's extract); retaining all of them when
 * the object is shared keeps the sibling alive. A failed shared-bytes probe fails
 * closed (retain), so we never delete bytes another row still points at.
 *
 * Callers are responsible for the ownership gate + the reference guard before
 * calling this. `alsoDelete` carries content-addressed sibling keys (e.g.
 * `extractObjectKeyForAsset(asset)` for a document); `deleteGcsObject` ignores a
 * missing object, so passing a key whose object was never written is a no-op.
 */
export async function purgeAssetStorage(
	asset: MediaAssetRecord,
	opts: { alsoDelete?: ReadonlyArray<string | null> } = {},
): Promise<void> {
	const sharedObject = await hasOtherAssetForGcsObjectKey(
		asset.owner,
		asset.gcsObjectKey,
		asset.id,
	).catch((err: unknown) => {
		log.error("[asset-deletion] shared-object check failed", {
			assetId: asset.id,
			gcsObjectKey: asset.gcsObjectKey,
			err,
		});
		// If we can't prove the bytes are unshared, retain them.
		return true;
	});

	await deleteAssetRow(asset.id);

	if (!sharedObject) {
		await deleteGcsObject(asset.gcsObjectKey);
		for (const key of opts.alsoDelete ?? []) {
			if (key) await deleteGcsObject(key);
		}
	}
}

/**
 * Render a media reference's carrier into a human-readable phrase for a refusal
 * message. Each `MediaRefLocation` variant names the slot + the entity it lives
 * on, so the user (or SA) knows exactly which attachment to clear. The phrasing
 * speaks the authoring layer's own nouns — module / form / field / option / logo
 * — never wire vocabulary.
 */
export function describeCarrier(ref: AssetRef): string {
	const loc = ref.location;
	switch (loc.kind) {
		case "app_logo":
			return "the app logo";
		case "module_icon":
			return `the icon on module "${loc.moduleName}"`;
		case "module_audio_label":
			return `the audio label on module "${loc.moduleName}"`;
		case "case_list_icon":
			return `the case-list icon on module "${loc.moduleName}"`;
		case "case_list_audio_label":
			return `the case-list audio label on module "${loc.moduleName}"`;
		case "form_icon":
			return `the icon on form "${loc.formName}" (module "${loc.moduleName}")`;
		case "form_audio_label":
			return `the audio label on form "${loc.formName}" (module "${loc.moduleName}")`;
		case "field_media_bundle":
			return `the ${ref.slotKind} on field "${loc.fieldId}"'s ${bundleSlotLabel(loc.bundleKey)} (form "${loc.formName}")`;
		case "option_media":
			return `the ${ref.slotKind} on option "${loc.optionValue}" of field "${loc.fieldId}" (form "${loc.formName}")`;
		case "image_map_mapping":
			return `the image-map row "${loc.rowValue}" in column "${loc.columnHeader}" (module "${loc.moduleName}")`;
	}
}

/** Friendly label for a field message-bundle key. */
function bundleSlotLabel(
	bundleKey: "label_media" | "hint_media" | "help_media" | "validate_msg_media",
): string {
	switch (bundleKey) {
		case "label_media":
			return "label";
		case "hint_media":
			return "hint";
		case "help_media":
			return "help";
		case "validate_msg_media":
			return "validation message";
	}
}
