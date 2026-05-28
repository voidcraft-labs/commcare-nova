import { describe, expect, it } from "vitest";
import { asAssetId } from "@/lib/domain/multimedia";
import type { AssetManifest, ResolvedMediaAsset } from "../assetWirePath";
import { buildMediaBundle, buildMultimediaMap } from "../bundle";

const HASH_IMG = "a".repeat(64);
const HASH_AUD = "b".repeat(64);

function asset(
	id: string,
	hash: string,
	extension: string,
	kind: ResolvedMediaAsset["kind"],
	withBytes: boolean,
): ResolvedMediaAsset {
	return {
		assetId: asAssetId(id),
		wirePath: `commcare/${hash}${extension}`,
		kind,
		mimeType: kind === "image" ? "image/png" : "audio/mpeg",
		contentHash: hash,
		extension,
		...(withBytes && { bytes: Buffer.from(`${id}-bytes`) }),
	};
}

function manifestOf(assets: ResolvedMediaAsset[]): AssetManifest {
	return new Map(assets.map((a) => [a.assetId, a]));
}

describe("buildMultimediaMap", () => {
	it("keys on the wire path (no jr://file/ prefix) with the media class + version", () => {
		const map = buildMultimediaMap([
			asset("img", HASH_IMG, ".png", "image", false),
			asset("aud", HASH_AUD, ".mp3", "audio", false),
		]);
		expect(map).toEqual({
			[`commcare/${HASH_IMG}.png`]: {
				multimedia_id: HASH_IMG,
				media_type: "CommCareImage",
				version: 1,
			},
			[`commcare/${HASH_AUD}.mp3`]: {
				multimedia_id: HASH_AUD,
				media_type: "CommCareAudio",
				version: 1,
			},
		});
	});
});

describe("buildMediaBundle", () => {
	it("produces media_suite, multimedia_map, and one CCZ entry per asset", () => {
		const bundle = buildMediaBundle(
			manifestOf([asset("img", HASH_IMG, ".png", "image", true)]),
			"t",
		);
		expect(bundle.mediaSuiteXml).toContain('descriptor="Media Suite File"');
		expect(bundle.mediaSuiteXml).toContain(`./commcare/${HASH_IMG}.png`);
		expect(bundle.multimediaMap[`commcare/${HASH_IMG}.png`]?.media_type).toBe(
			"CommCareImage",
		);
		expect(bundle.cczEntries).toEqual([
			{ path: `commcare/${HASH_IMG}.png`, bytes: Buffer.from("img-bytes") },
		]);
	});

	it("throws a compiler-bug when a referenced asset reached the bundler without bytes", () => {
		expect(() =>
			buildMediaBundle(
				manifestOf([asset("img", HASH_IMG, ".png", "image", false)]),
				"t",
			),
		).toThrow(/Internal bug.*without loaded bytes/s);
	});

	it("yields an empty placeholder suite + empty map for a media-free app", () => {
		const bundle = buildMediaBundle(manifestOf([]), "t");
		expect(bundle.mediaSuiteXml).toBe(
			'<?xml version="1.0"?>\n<suite version="1"/>',
		);
		expect(bundle.multimediaMap).toEqual({});
		expect(bundle.cczEntries).toEqual([]);
	});
});
