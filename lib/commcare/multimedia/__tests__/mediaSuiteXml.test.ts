import { describe, expect, it } from "vitest";
import { asAssetId } from "@/lib/domain/multimedia";
import type { ResolvedMediaAsset } from "../assetWirePath";
import { buildMediaSuiteXml } from "../mediaSuiteXml";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function asset(
	hash: string,
	extension: string,
	kind: ResolvedMediaAsset["kind"],
): ResolvedMediaAsset {
	return {
		assetId: asAssetId(`asset-${hash}`),
		wirePath: `commcare/${hash}${extension}`,
		kind,
		mimeType: "image/png",
		contentHash: hash,
		extension,
	};
}

describe("buildMediaSuiteXml", () => {
	it("returns the byte-identical empty placeholder when no assets are referenced", () => {
		expect(buildMediaSuiteXml([])).toBe(
			'<?xml version="1.0"?>\n<suite version="1"/>',
		);
	});

	it("emits a descriptor'd suite with one local-authority <media> block per asset", () => {
		const xml = buildMediaSuiteXml([asset(HASH_A, ".png", "image")]);
		expect(xml).toBe(
			'<?xml version="1.0"?>\n' +
				'<suite version="1" descriptor="Media Suite File">' +
				'<media path="../../commcare">' +
				`<resource id="media-${HASH_A}-${HASH_A}.png" version="1">` +
				`<location authority="local">./commcare/${HASH_A}.png</location>` +
				"</resource>" +
				"</media>" +
				"</suite>",
		);
	});

	it("orders <media> blocks deterministically by wire path", () => {
		// Pass B before A; output must still be A then B.
		const xml = buildMediaSuiteXml([
			asset(HASH_B, ".mp3", "audio"),
			asset(HASH_A, ".png", "image"),
		]);
		const aIdx = xml.indexOf(`./commcare/${HASH_A}.png`);
		const bIdx = xml.indexOf(`./commcare/${HASH_B}.mp3`);
		expect(aIdx).toBeGreaterThan(-1);
		expect(bIdx).toBeGreaterThan(-1);
		expect(aIdx).toBeLessThan(bIdx);
	});
});
