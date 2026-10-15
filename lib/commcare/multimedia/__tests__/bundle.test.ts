import { describe, expect, it } from "vitest";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import {
	onlyXml,
	readXmlEvidence,
	xmlChildren,
} from "@/lib/commcare/__tests__/xmlEvidence";
import { buildMediaBundle } from "../bundle";

describe("resolved media bundle assembly", () => {
	it("deduplicates shared content while retaining every file and its exact bytes", () => {
		const assets = mediaManifest();
		expect(assets.size).toBe(6);
		const bundle = buildMediaBundle(assets, "test");
		expect(bundle.cczEntries).toHaveLength(5);
		const expected = new Map(
			[...assets.values()].map((asset) => [asset.wirePath, asset.bytes]),
		);
		expect(
			new Map(bundle.cczEntries.map((entry) => [entry.path, entry.bytes])),
		).toEqual(expected);
		const xml = readXmlEvidence(bundle.mediaSuiteXml);
		expect(
			xmlChildren(xml, "media").map(
				(media) =>
					onlyXml(
						xmlChildren(onlyXml(xmlChildren(media, "resource")), "location"),
					).text,
			),
		).toEqual([...expected.keys()].sort().map((path) => `./${path}`));
	});
	it("refuses a manifest that has not loaded referenced bytes", () => {
		const assets = new Map(mediaManifest());
		const image = assets.get(mediaIds.label);
		if (!image) throw new Error("Missing asset");
		const { bytes: _bytes, ...withoutBytes } = image;
		assets.set(image.assetId, withoutBytes);
		expect(() => buildMediaBundle(assets, "missing-byte-proof")).toThrow(
			/Internal bug.*without loaded bytes/s,
		);
	});
});
