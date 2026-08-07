/**
 * Production resource seams for the source-package builder — split from
 * `sourcePackage.ts` on purpose: `ensureStoredExtract`'s import graph
 * carries the office parsers (mammoth loads bluebird, which allocates a
 * promise at module load), and the pure builder, its schemas, and the
 * pipeline must stay importable without dragging that graph in — the same
 * dep-free split `documentExtraction.ts` documents for `EXTRACTOR_VERSION`.
 */

import { createHash } from "node:crypto";
import type { AttachmentCondenser } from "@/lib/agent/documentExtraction";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import { downloadAssetBytes } from "@/lib/storage/media";
import {
	MAX_IMAGE_BYTES,
	type SourcePackageDeps,
	SourcePackageError,
} from "./sourcePackage";

/** Production seams. The condenser backs the extraction store's backstop
 *  for a document whose eager extraction never ran. */
export function productionSourcePackageDeps(
	condenser: AttachmentCondenser,
): SourcePackageDeps {
	return {
		loadAssets: (ids, projectId) => loadAssetsByIds(ids, projectId),
		async readExtract(asset, kind) {
			const result = await ensureStoredExtract({
				asset,
				documentKind: kind,
				condenser,
				onInflight: "wait",
			});
			if (result.status === "ready") {
				return { text: result.text, truncated: result.truncated };
			}
			throw new SourcePackageError(
				`The document "${asset.originalFilename}" could not be read: its extraction failed, so its requirements cannot ground a design. Re-attach the document or remove it from the request.`,
			);
		},
		async loadImage(asset) {
			const bytes = await downloadAssetBytes(
				asset.gcsObjectKey,
				MAX_IMAGE_BYTES,
			);
			return {
				mediaType: asset.mimeType,
				dataUrl: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
				bytesDigest: createHash("sha256").update(bytes).digest("hex"),
			};
		},
	};
}
