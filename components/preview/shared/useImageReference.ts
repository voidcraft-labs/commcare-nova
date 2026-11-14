// components/preview/shared/useImageReference.ts
//
// The `jr://file/` path a device holds for each image the list's image-map
// columns show, which a device's list filter reads in place of the image
// (`lib/preview/engine/caseListFilterFields.ts`). The path names the file by
// its content hash and extension, so it comes from the image's media row,
// read through the session's shared registry; an image whose row Preview has
// not read yet has no path, and its field holds no text until it arrives.

"use client";
import { useMemo } from "react";
import { useReferencedAssetRows } from "@/components/builder/media/useReferencedAssetRows";
import type { Column, MediaAssetId } from "@/lib/domain";
import {
	type ImageReference,
	mediaImageReference,
} from "@/lib/preview/engine/caseListFilterFields";

export function useImageReference(columns: readonly Column[]): ImageReference {
	const assetIds = [
		...new Set(
			columns.flatMap((column) =>
				column.kind === "image-map"
					? column.mapping.map((entry) => entry.assetId)
					: [],
			),
		),
	];
	const rows = useReferencedAssetRows(assetIds);
	const paths = assetIds.map((id) => {
		const row = rows[id];
		return [id, row ? mediaImageReference(row) : undefined] as const;
	});
	/* The registry hands back a fresh record on every render; the paths
	 * themselves change only when a row arrives, so the reference keys on them. */
	const key = paths.map(([id, path]) => `${id}=${path ?? ""}`).join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the paths it joins
	return useMemo(() => {
		const byId = new Map<MediaAssetId, string | undefined>(paths);
		return (assetId: MediaAssetId) => byId.get(assetId);
	}, [key]);
}
