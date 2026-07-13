// lib/media/manifest.ts
//
// Resolves a blueprint's media references into the `AssetManifest` the
// wire emitters (`expandDoc` / `compileCcz`) consume. The one bridge
// from storage (Postgres rows + GCS bytes) to the CommCare wire-path
// vocabulary — which is why this file is the single media-side member
// of the `lib/commcare` import allowlist (see biome.json).
//
// Server-only: it reads Postgres + GCS. The compile / upload routes
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
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import {
	partitionAssetRefs,
	resolveBuiltinManifestEntries,
} from "./builtinIconAssets";

/**
 * Max GCS object downloads in flight at once when resolving a manifest's
 * bytes. Small on purpose — the total volume is already bounded by the
 * validator's aggregate-byte ceiling, so this only smooths the peak
 * (concurrent open streams + bytes held simultaneously), not the total.
 */
const MEDIA_DOWNLOAD_CONCURRENCY = 6;

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
 * load the project's matching rows in one batch, keep only the `ready`
 * ones, derive each asset's content-hash wire path, and (when
 * `withBytes`) stream its bytes from GCS.
 *
 * The scope is the doc's referenced ids filtered to `projectId` — a
 * reference to a foreign-PROJECT asset is filtered out (it never lands
 * in the manifest), which surfaces at emission as `MEDIA_ASSET_NOT_FOUND`.
 * That filter is the cross-tenant defense: media is shared at the Project
 * boundary, so an export resolves only the assets of its own Project.
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
 * (foreign-project, deleted, or filtered pending here) surfaces at
 * emission as a `requireAssetRef` throw — the floor when the
 * validator path was skipped.
 */
export async function resolveMediaManifest(
	doc: BlueprintDoc,
	projectId: string,
	options: ResolveManifestOptions,
): Promise<AssetManifest> {
	const ids = [...collectAssetRefs(doc)];
	if (ids.length === 0) return new Map();

	// Built-in icon refs (`nova-icon:<slug>`) carry no asset row — they
	// resolve from the shipped catalog + `public/nova-icons/` bytes. Route them
	// away from the asset-row load and synthesize their manifest entries; only
	// the real ids hit `loadAssetsByIds`.
	const { realIds, builtinSlugs } = partitionAssetRefs(ids);

	// Keep `ready` rows of a wire-attachable (media) kind. Carrier slots
	// hold an opaque `AssetId` (the brand doesn't encode kind), so the
	// wire/library boundary is RUNTIME-enforced and fail-closed, not
	// compile-time: the validator's `mediaKindMatches` rule rejects a
	// document id in a media slot before compile, and this `isMediaKind`
	// filter is the wire-layer floor for any caller that reaches emission.
	// Keep it even though it reads as redundant — it's the last guard that
	// a document never lands in the suite. It also narrows the row into
	// `ResolvedMediaAsset` (whose `kind` is `MediaKind`).
	const rows =
		realIds.length === 0
			? []
			: (await loadAssetsByIds(realIds, projectId)).filter(
					(row): row is MediaAssetRecord & { kind: MediaKind } =>
						row.status === "ready" && isMediaKind(row.kind),
				);
	// Bytes (when requested) stream from GCS. Compile is interactive (the
	// user clicked "Compile to CCZ"), so serializing the awaits in a `for`
	// loop would stretch the round-trip to sum(per-asset latency) — but
	// firing ALL downloads at once (`Promise.all`) opens one GCS read
	// stream per asset and holds every asset's bytes in memory at the same
	// peak. Bound the in-flight count instead: the aggregate-byte ceiling
	// (enforced upstream in the media validator) caps the TOTAL, and this
	// caps how much arrives at once. Order is preserved, so the manifest
	// map key order is stable.
	const entries = await mapWithConcurrency(
		rows,
		MEDIA_DOWNLOAD_CONCURRENCY,
		async (row) => {
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
		},
	);
	// Built-in icons resolve to the same `ResolvedMediaAsset` shape, deduped by
	// slug, so the emitters (CCZ bundle, media_suite, itext, HQ upload) treat them
	// identically to uploads. Multiple modules referencing one slug collapse to a
	// single wire entry via the shared content-hash wire path.
	const builtinEntries = await resolveBuiltinManifestEntries(
		builtinSlugs,
		options.withBytes,
	);
	return new Map([...entries, ...builtinEntries]);
}

/**
 * Project a resolved manifest to its `AssetId → wirePath` map — the input
 * the upload-outcome interpreter (`./uploadOutcome.ts`) joins against the
 * doc's references to name which media, where, didn't attach. Keeps the
 * `AssetManifest` type (a `lib/commcare` shape) on this side of the import
 * boundary so the interpreter stays boundary-free.
 */
export function assetWirePaths(manifest: AssetManifest): Map<string, string> {
	const map = new Map<string, string>();
	for (const [assetId, asset] of manifest) map.set(assetId, asset.wirePath);
	return map;
}
