// lib/commcare/multimedia/bulkUploadZip.ts
//
// Builds CommCare HQ's bulk-multimedia-upload ZIP from a resolved media
// manifest. Node-only (adm-zip), kept out of `bundle.ts` so that module
// stays dependency-light for its client-reachable consumers.

import AdmZip from "adm-zip";
import type { AssetManifest } from "./assetWirePath";

/**
 * Build the ZIP CommCare HQ's `upload_multimedia_api` endpoint ingests:
 * one entry per unique wire path (`commcare/<hash><ext>`) carrying the
 * asset's bytes. HQ's `process_bulk_upload_zip` matches each entry to the
 * imported app's `jr://file/commcare/...` references by path
 * (`get_form_path`), so the entry layout IS the bare wire path —
 * byte-identical to the references the expander emitted and to the `.ccz`'s
 * media entries. The same ZIP is what the JSON-export bundle ships for a
 * manual two-step import, so both paths speak one format.
 *
 * Dedupes by wire path: two distinct `AssetId`s can resolve to one
 * `(contentHash, extension)` — and so one wire path — when the storage
 * dedup probe races (concurrent uploads of identical bytes land two `ready`
 * rows). Same wire path = same bytes, so either entry is byte-equivalent;
 * collapsing avoids a duplicate ZIP entry. Every entry MUST carry bytes —
 * resolve the manifest with `withBytes: true` before calling.
 */
export function buildMediaBulkUploadZip(manifest: AssetManifest): Buffer {
	const zip = new AdmZip();
	const seen = new Set<string>();
	for (const asset of manifest.values()) {
		if (seen.has(asset.wirePath)) continue;
		if (!asset.bytes) {
			throw new Error(
				`The HQ multimedia bundle needs every asset's bytes, but "${asset.wirePath}" arrived without any. ` +
					"Resolve the manifest with `withBytes: true` before building the upload ZIP.",
			);
		}
		seen.add(asset.wirePath);
		zip.addFile(asset.wirePath, asset.bytes);
	}
	return zip.toBuffer();
}
