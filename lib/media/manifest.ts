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
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	ASSET_SIZE_CAPS_BYTES,
	asAssetId,
	isMediaKind,
	type MediaKind,
} from "@/lib/domain/multimedia";
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
 * load the owner's matching rows in one batch, keep only the `ready`
 * ones, derive each asset's content-hash wire path, and (when
 * `withBytes`) stream its bytes from GCS.
 *
 * Returns an empty manifest when the doc references no media — the
 * emitters treat an empty manifest the same as media-off, so a
 * media-free app costs one cheap `collectAssetRefs` walk and no I/O.
 *
 * The wire-emission manifest filters out non-`ready` rows here even
 * though `loadAssetsByIds` returns them — a pending row's GCS object
 * is unvalidated bytes, so resolving a `jr://` ref to it would bundle
 * garbage into the CCZ. The validator's `mediaAssetReady` rule fires
 * first in the SA loop with the user-actionable "still uploading"
 * message; the filter here is the lower-layer guard for any caller
 * that reaches emission without the validator (`compileCcz`,
 * `expandDoc` invoked directly from tests).
 *
 * A doc reference whose asset doesn't make it into the manifest
 * (foreign-owned, deleted, or filtered pending here) surfaces at
 * emission as a `requireAssetRef` throw — the floor when the
 * validator path was skipped.
 */
export async function resolveMediaManifest(
	doc: BlueprintDoc,
	owner: string,
	options: ResolveManifestOptions,
): Promise<AssetManifest> {
	const ids = [...collectAssetRefs(doc)];
	if (ids.length === 0) return new Map();

	// Keep `ready` rows of a wire-attachable (media) kind. Carrier slots
	// hold an opaque `AssetId` (the brand doesn't encode kind), so the
	// wire/library boundary is RUNTIME-enforced and fail-closed, not
	// compile-time: the validator's `mediaKindMatches` rule rejects a
	// document id in a media slot before compile, and this `isMediaKind`
	// filter is the wire-layer floor for any caller that reaches emission.
	// Keep it even though it reads as redundant — it's the last guard that
	// a document never lands in the suite. It also narrows the row into
	// `ResolvedMediaAsset` (whose `kind` is `MediaKind`).
	const rows = (await loadAssetsByIds(owner, ids)).filter(
		(row): row is MediaAssetRecord & { kind: MediaKind } =>
			row.status === "ready" && isMediaKind(row.kind),
	);
	// Bytes (when requested) come from GCS — fetch in parallel. Compile
	// is interactive (the user clicked "Compile to CCZ"); serializing
	// the awaits inside a `for` loop would stretch the round-trip from
	// max(per-asset latency) to sum(per-asset latency). `Promise.all` is
	// fine for typical app-sized N; if rate limiting ever becomes a
	// concern, gate concurrency with a small limit helper.
	const entries = await Promise.all(
		rows.map(async (row) => {
			const bytes = options.withBytes
				? await downloadAssetBytes(
						row.gcsObjectKey,
						ASSET_SIZE_CAPS_BYTES[row.kind],
					)
				: undefined;
			const id = asAssetId(row.id);
			return [
				id,
				{
					assetId: id,
					wirePath: wirePathFor(row.contentHash, row.extension),
					kind: row.kind,
					mimeType: row.mimeType,
					contentHash: row.contentHash,
					extension: row.extension,
					...(bytes !== undefined && { bytes }),
				} satisfies ResolvedMediaAsset,
			] as const;
		}),
	);
	return new Map(entries);
}
