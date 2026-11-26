import type { IconRef } from "@/lib/domain/builtinIcons";
import type { AssetManifest, ResolvedMediaAsset } from "./assetWirePath";

/** The bytes an ordinary batch stays within; one file larger travels alone. */
export const TARGET_BATCH_BYTES = 24 * 1024 * 1024;
const TARGET_BATCH_FILES = 200;

/** One indivisible file travels alone when it is larger than the ordinary
 * upload workspace. Aliases sharing a wire path always share a receipt. */
export function* mediaUploadBatches(
	assets: AssetManifest,
): Generator<AssetManifest> {
	const paths = new Map<string, ResolvedMediaAsset[]>();
	for (const asset of assets.values()) {
		const group = paths.get(asset.wirePath) ?? [];
		group.push(asset);
		paths.set(asset.wirePath, group);
	}
	let batch = new Map<IconRef, ResolvedMediaAsset>();
	let size = 0,
		count = 0;
	for (const [, aliases] of [...paths.entries()].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		const first = aliases[0];
		const bytes = first.byteSource?.size ?? first.bytes?.length;
		if (bytes === undefined)
			throw new Error("A media upload needs the size of its file.");
		if (
			count &&
			(count >= TARGET_BATCH_FILES || size + bytes > TARGET_BATCH_BYTES)
		) {
			yield batch;
			batch = new Map();
			size = 0;
			count = 0;
		}
		for (const asset of aliases) batch.set(asset.assetId, asset);
		size += bytes;
		count++;
	}
	if (count) yield batch;
}
