import { bytesMember, type StreamMember } from "../streamZip";
import type { AssetManifest, ResolvedMediaAsset } from "./assetWirePath";

export function mediaMember(
	asset: ResolvedMediaAsset,
	path = asset.wirePath,
): StreamMember {
	if (asset.byteSource) return { path, ...asset.byteSource };
	if (asset.bytes) return bytesMember(path, asset.bytes);
	throw new Error("An archive media member needs a verified byte source.");
}

export function mediaMembers(manifest: AssetManifest) {
	const byPath = new Map<string, ResolvedMediaAsset>();
	for (const asset of manifest.values()) {
		const previous = byPath.get(asset.wirePath);
		if (previous && previous.contentHash !== asset.contentHash)
			throw new Error("Two different media assets share an archive path.");
		byPath.set(asset.wirePath, asset);
	}
	return Array.from(byPath.values())
		.sort((a, b) => (a.wirePath < b.wirePath ? -1 : 1))
		.map((a) => mediaMember(a));
}
