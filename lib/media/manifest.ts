// lib/media/manifest.ts
//
// Resolves a blueprint's media references into the `AssetManifest` the
// wire emitters (`expandDoc` / `compileCcz`) consume. The one bridge
// from storage (Firestore rows + GCS bytes) to the CommCare wire-path
// vocabulary — which is why this file is the single media-side member
// of the `lib/commcare` import allowlist (see biome.json).
//
// Server-only: it reads Firestore + GCS. The compile / upload routes
// and the MCP compile tool call it; the validation loop and asset-free
// previews skip it (passing no manifest = media emission off).

import "server-only";

import {
	type AssetManifest,
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import { asAssetId } from "@/lib/domain/multimedia";
import { downloadAssetBytes } from "@/lib/storage/media";

export interface ResolveManifestOptions {
	/**
	 * Load each referenced asset's bytes from GCS. Required for the
	 * compile path (the `.ccz` bundles the files) and the HQ multimedia
	 * upload; omitted for the HQ-JSON-only path (preview / upload-JSON),
	 * which needs only the wire paths the references resolve to.
	 */
	withBytes: boolean;
}

/**
 * Build the `AssetManifest` for a blueprint: walk every media reference,
 * load the owner's matching `ready` rows in one batch, derive each
 * asset's content-hash wire path, and (when `withBytes`) stream its
 * bytes from GCS.
 *
 * Returns an empty manifest when the doc references no media — the
 * emitters treat an empty manifest the same as media-off, so a
 * media-free app costs one cheap `collectAssetRefs` walk and no I/O.
 *
 * Assets the owner doesn't own / that aren't `ready` are dropped by
 * `loadAssetsByIds` (never leaked). A reference left unresolved this
 * way is rejected by the media validator rules before compile; if one
 * still reaches the emitter, its manifest lookup throws a compiler-bug.
 */
export async function resolveMediaManifest(
	doc: BlueprintDoc,
	owner: string,
	options: ResolveManifestOptions,
): Promise<AssetManifest> {
	const ids = [...collectAssetRefs(doc)];
	if (ids.length === 0) return new Map();

	const rows = await loadAssetsByIds(owner, ids);
	const manifest = new Map<ReturnType<typeof asAssetId>, ResolvedMediaAsset>();
	for (const row of rows) {
		const bytes = options.withBytes
			? await downloadAssetBytes(row.gcsObjectKey)
			: undefined;
		manifest.set(asAssetId(row.id), {
			assetId: asAssetId(row.id),
			wirePath: wirePathFor(row.contentHash, row.extension),
			kind: row.kind,
			mimeType: row.mimeType,
			contentHash: row.contentHash,
			extension: row.extension,
			...(bytes !== undefined && { bytes }),
		});
	}
	return manifest;
}
