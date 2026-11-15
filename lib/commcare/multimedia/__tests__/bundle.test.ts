import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import {
	onlyXml,
	readXmlEvidence,
	xmlChildren,
} from "@/lib/commcare/__tests__/xmlEvidence";
import { validateMediaSuite } from "@/lib/commcare/validator/mediaSuiteOracle";
import type { AssetManifest, ResolvedMediaAsset } from "../assetWirePath";
import { buildMediaBulkUploadZip } from "../bulkUploadZip";
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

/** Each `<media>` block of a suite: its path and its one location. */
function mediaBlocks(xml: string): { path: string; location: string }[] {
	return xmlChildren(readXmlEvidence(xml), "media").map((media) => ({
		path: media.attributes.path,
		location: onlyXml(
			xmlChildren(onlyXml(xmlChildren(media, "resource")), "location"),
		).text,
	}));
}

/** The base manifest with the label image held at `label` and the audio file at `audio`. */
function heldManifest(label: string, audio: string): AssetManifest {
	const assets = new Map(mediaManifest());
	for (const [id, wirePath] of [
		[mediaIds.label, label],
		[mediaIds.audio, audio],
	] as const) {
		const asset = assets.get(id);
		if (asset === undefined) throw new Error(`Missing asset ${id}`);
		assets.set(id, { ...asset, wirePath });
	}
	return assets;
}

describe("a media path a target holds", () => {
	it("installs a nested path in its own directory and bundles it at that path", () => {
		const assets = heldManifest(
			"commcare/image/cow.png",
			"commcare/audio/moo.wav",
		);
		const bundle = buildMediaBundle(assets, "test");
		const blocks = mediaBlocks(bundle.mediaSuiteXml);
		expect(blocks).toContainEqual({
			path: "../../commcare/image",
			location: "./commcare/image/cow.png",
		});
		expect(blocks).toContainEqual({
			path: "../../commcare/audio",
			location: "./commcare/audio/moo.wav",
		});
		const entries = new Map(
			bundle.cczEntries.map((entry) => [entry.path, entry.bytes]),
		);
		expect(entries.get("commcare/image/cow.png")).toEqual(
			assets.get(mediaIds.label)?.bytes,
		);
		expect(entries.get("commcare/audio/moo.wav")).toEqual(
			assets.get(mediaIds.audio)?.bytes,
		);
		expect(
			validateMediaSuite(bundle.mediaSuiteXml, new Set(entries.keys())),
		).toEqual([]);
	});

	it("installs a path outside commcare/ in its own directory and bundles it at that path", () => {
		const assets = heldManifest("media/logo.png", "sounds/moo.wav");
		const bundle = buildMediaBundle(assets, "test");
		const blocks = mediaBlocks(bundle.mediaSuiteXml);
		expect(blocks).toContainEqual({
			path: "../../media",
			location: "./media/logo.png",
		});
		expect(blocks).toContainEqual({
			path: "../../sounds",
			location: "./sounds/moo.wav",
		});
		// Every derived file beside them keeps commcare/.
		for (const block of blocks) {
			if (block.location.startsWith("./commcare/")) {
				expect(block.path).toBe("../../commcare");
			}
		}
		const paths = bundle.cczEntries.map((entry) => entry.path);
		expect(paths).toContain("media/logo.png");
		expect(paths).toContain("sounds/moo.wav");
		expect(validateMediaSuite(bundle.mediaSuiteXml, new Set(paths))).toEqual(
			[],
		);
	});

	it("names each held file at its path in HQ's bulk upload", () => {
		const assets = heldManifest("media/logo.png", "commcare/audio/moo.wav");
		const zip = new AdmZip(buildMediaBulkUploadZip(assets));
		const entries = new Map(
			zip.getEntries().map((entry) => [entry.entryName, entry.getData()]),
		);
		expect(entries.get("media/logo.png")).toEqual(
			assets.get(mediaIds.label)?.bytes,
		);
		expect(entries.get("commcare/audio/moo.wav")).toEqual(
			assets.get(mediaIds.audio)?.bytes,
		);
		expect([...entries.keys()].sort()).toEqual(
			[...new Set([...assets.values()].map((asset) => asset.wirePath))].sort(),
		);
	});

	it("writes a manifest of content-hash paths exactly as before", () => {
		const hashA = "a".repeat(64);
		const hashB = "b".repeat(64);
		const file = (
			name: string,
			contentHash: string,
			extension: string,
		): ResolvedMediaAsset => ({
			assetId: testMediaAssetId(name),
			wirePath: `commcare/${contentHash}${extension}`,
			kind: extension === ".png" ? "image" : "audio",
			mimeType: extension === ".png" ? "image/png" : "audio/wav",
			contentHash,
			extension,
			bytes: Buffer.from(name),
		});
		const assets: AssetManifest = new Map(
			[file("second", hashB, ".wav"), file("first", hashA, ".png")].map(
				(asset) => [asset.assetId, asset],
			),
		);
		expect(buildMediaBundle(assets, "test").mediaSuiteXml).toBe(
			'<?xml version="1.0"?>\n' +
				'<suite version="1" descriptor="Media Suite File">' +
				'<media path="../../commcare">' +
				`<resource id="media-${hashA}-${hashA}.png" version="1">` +
				`<location authority="local">./commcare/${hashA}.png</location>` +
				"</resource></media>" +
				'<media path="../../commcare">' +
				`<resource id="media-${hashB}-${hashB}.wav" version="1">` +
				`<location authority="local">./commcare/${hashB}.wav</location>` +
				"</resource></media></suite>",
		);
	});
});
