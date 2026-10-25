/**
 * The media fixtures' stand-in rows against the production classifier: each
 * file's recorded variant is the one the upload gate gives its bytes, so a
 * fixture that stopped playing on a platform fails here rather than passing
 * the corpus and the native family while production refuses it.
 */

import { describe, expect, it } from "vitest";
import type { AssetMimeType } from "@/lib/domain/multimedia";
import { classifyStoredMediaBytes } from "@/lib/media/validate";
import {
	MEDIA_FORMAT_SETS,
	mediaManifest,
	mediaRecords,
	mediaWireFixture,
} from "./mediaWireFixtures";

describe("the media fixtures' recorded variants", () => {
	it.each(MEDIA_FORMAT_SETS)(
		"records each file of the %s set as the variant its bytes are",
		async (set) => {
			const assets = mediaManifest(set);
			const records = mediaRecords(assets);
			for (const asset of assets.values()) {
				const bytes = asset.bytes;
				if (bytes === undefined)
					throw new Error("A fixture carries its bytes.");
				expect(
					await classifyStoredMediaBytes(bytes, {
						mimeType: asset.mimeType as AssetMimeType,
						extension: asset.extension,
					}),
					`${asset.assetId} (${asset.extension})`,
				).toBe(records.get(asset.assetId)?.mediaFormat);
			}
		},
	);

	it.each(MEDIA_FORMAT_SETS)(
		"builds the %s scenario admitted, its files in the zip counts the family expects",
		(set) => {
			const { assets } = mediaWireFixture(false, set);
			const kinds: Record<string, number> = {};
			const seen = new Set<string>();
			for (const asset of assets.values()) {
				if (seen.has(asset.contentHash)) continue;
				seen.add(asset.contentHash);
				kinds[asset.kind] = (kinds[asset.kind] ?? 0) + 1;
			}
			const expected = {
				none: { image: 3, audio: 1, video: 1 },
				"every-platform": { image: 4, audio: 5, video: 2 },
				"web-apps": { image: 5, audio: 1, video: 1 },
				android: { image: 3, audio: 4, video: 4 },
			}[set];
			expect(kinds).toEqual(expected);
		},
	);

	it("holds no SVG in any manifest", () => {
		for (const set of MEDIA_FORMAT_SETS) {
			for (const asset of mediaManifest(set).values()) {
				expect(asset.mimeType).not.toBe("image/svg+xml");
			}
		}
	});
});
