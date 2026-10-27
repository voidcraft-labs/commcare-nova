import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import AdmZip from "adm-zip";
import { testMediaAssetId, testUuid } from "../../../__tests__/helpers/uuid";
import {
	type MediaFormatSet,
	mediaIds,
	mediaWireFixture,
} from "../../../lib/commcare/__tests__/mediaWireFixtures";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "../../../lib/commcare/multimedia/assetWirePath";
import { buildMediaBulkUploadZip } from "../../../lib/commcare/multimedia/bulkUploadZip";
import type { BlueprintDoc } from "../../../lib/domain";
import { proseText } from "../../../lib/domain/prose";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const outputArgument = process.argv[2];
if (!outputArgument)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-media-evidence.ts OUTPUT_DIRECTORY",
	);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const write = (path: string, bytes: string | Uint8Array) => {
	const file = resolve(output, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, bytes);
};
/** Write one scenario's exports: its form source, HQ JSON, archive and, with media, its upload zip and files. */
function writeScenario(
	name: string,
	doc: BlueprintDoc,
	assets: AssetManifest,
	enabled: boolean,
): void {
	const options = enabled ? { assets } : {};
	const hq = expandDoc(doc, options);
	const ccz = compileCcz(hq, doc.appName, doc, {
		...options,
		runtimeTarget: NATIVE_RUNTIME_TARGET,
	});
	const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing source");
	write(`${name}.source.xml`, source);
	write(`${name}.json`, JSON.stringify(hq));
	write(`${name}.ccz`, ccz);
	const zip = new AdmZip(ccz);
	for (const [entry, target] of [
		["suite.xml", `${name}.suite.xml`],
		["media_suite.xml", `${name}.media-suite.xml`],
		["profile.ccpr", `${name}.profile.xml`],
		["default/app_strings.txt", `${name}.strings.properties`],
		["modules-0/forms-0.xml", `${name}.xml`],
	])
		write(target, zip.readAsText(entry));
	if (enabled) {
		write(`${name}.multimedia.zip`, buildMediaBulkUploadZip(assets));
		for (const asset of assets.values()) {
			if (!asset.bytes) throw new Error("Missing bytes");
			write(asset.wirePath, asset.bytes);
		}
	}
}

for (const mediaOnly of [false, true])
	for (const enabled of [false, true]) {
		// The family's scenario holds one file of each format defect 11's first
		// half accepts, each in a slot of its kind, beside the corpus's media.
		const { doc, assets } = mediaWireFixture(mediaOnly, "every-platform");
		writeScenario(
			`media-${mediaOnly ? "only" : "rich"}-${enabled ? "on" : "off"}`,
			doc,
			assets,
			enabled,
		);
	}

/** The format scenarios, by name, from the sets of the variants one platform plays. */
const FORMAT_SETS: readonly (readonly [string, MediaFormatSet])[] = [
	["media-web-apps-on", "web-apps"],
	["media-android-on", "android"],
];
for (const [name, set] of FORMAT_SETS) {
	const { doc, assets } = mediaWireFixture(false, set);
	writeScenario(name, doc, assets, true);
}

/** The SVG this family uploads to HQ, the one file Nova refuses at upload. */
const SVG_FILE = "lib/media/__tests__/fixtures/pattern.svg";
const SVG_ID = testMediaAssetId("wire-svg");

/**
 * The one emission Nova itself would refuse, built only so HQ's refusal of
 * an SVG is executed: the base document (both platforms declared) with one
 * more select option whose image is an SVG, and the SVG appended to the
 * manifest after the base PNGs. Nova's validator refuses this document (an
 * SVG is no accepted type, and its row would play nowhere), and no
 * production path can emit it, so it runs no validation and never enters
 * `mediaManifest`.
 */
function svgRefusedScenario(): { doc: BlueprintDoc; assets: AssetManifest } {
	const fixture = mediaWireFixture(false, "none");
	// A fresh copy: the fixture's document was read, and read results are
	// cached by object, before this adds an option to it.
	const doc = structuredClone(fixture.doc);
	const assets = fixture.assets;
	const choice = Object.values(doc.fields).find(
		(field) => field.kind === "single_select",
	);
	if (
		choice?.kind !== "single_select" ||
		choice.optionsSource.kind !== "inline"
	)
		throw new Error("The media fixture holds an inline select.");
	choice.optionsSource.options.push({
		uuid: testUuid("wire-svg-option"),
		value: "svg",
		label: proseText("SVG"),
		media: { image: SVG_ID },
	});
	const bytes = readFileSync(new URL(`../../../${SVG_FILE}`, import.meta.url));
	const contentHash = createHash("sha256").update(bytes).digest("hex");
	const svg: ResolvedMediaAsset = {
		assetId: SVG_ID,
		bytes,
		kind: "image",
		mimeType: "image/svg+xml",
		extension: ".svg",
		contentHash,
		wirePath: `commcare/${contentHash}.svg`,
	};
	const entries = [...assets.entries()];
	const afterPngs =
		entries.findLastIndex(([, asset]) => asset.mimeType === "image/png") + 1;
	entries.splice(afterPngs, 0, [SVG_ID, svg]);
	return { doc, assets: new Map(entries) };
}
const svgScenario = svgRefusedScenario();
writeScenario("media-svg-refused", svgScenario.doc, svgScenario.assets, true);

// Every set's files and the SVG scenario's: HQ's upload step gives each
// uploaded file the kind this names for its path, and Core resolves each id.
const assets: AssetManifest = new Map([
	...mediaWireFixture(false, "every-platform").assets,
	...FORMAT_SETS.flatMap(([, set]) => [...mediaWireFixture(false, set).assets]),
	...svgScenario.assets,
]);
write(
	"media-paths.properties",
	Object.entries(mediaIds)
		.map(([key, id]) => `${key}=jr://file/${assets.get(id)?.wirePath}`)
		.join("\n"),
);
// The kind Nova gives each uploaded file, which HQ's upload must class alike.
write(
	"media-kinds.json",
	JSON.stringify(
		Object.fromEntries(
			[...assets.values()].map((asset) => [asset.wirePath, asset.kind]),
		),
	),
);
const paths = [
	"lib/commcare/__tests__/mediaWireFixtures.ts",
	"lib/media/__tests__/bmpFixtures.ts",
	"lib/media/__tests__/builtFixtures.ts",
	"lib/media/__tests__/fixtures/tiny-video.mp4",
	"lib/media/__tests__/fixtures/tone.m4a",
	"lib/media/__tests__/fixtures/tone.flac",
	"lib/media/__tests__/fixtures/tone-vorbis.ogg",
	"lib/media/__tests__/fixtures/tone-opus.ogg",
	"lib/media/__tests__/fixtures/pattern-vp8.webm",
	"lib/media/__tests__/fixtures/pattern-png.ico",
	"lib/media/__tests__/fixtures/pattern.avif",
	"lib/media/__tests__/fixtures/tone.aac",
	"lib/media/__tests__/fixtures/pattern-hevc.mp4",
	"lib/media/__tests__/fixtures/pattern-mpeg4.mp4",
	"lib/media/__tests__/fixtures/pattern-vp8.mkv",
	SVG_FILE,
	"lib/commcare/compiler.ts",
	"lib/commcare/expander.ts",
	"lib/commcare/multimedia/bundle.ts",
	"lib/commcare/multimedia/bulkUploadZip.ts",
	"lib/commcare/multimedia/mediaSuiteXml.ts",
	"lib/commcare/multimedia/itextMedia.ts",
	"lib/commcare/multimedia/navMenuMedia.ts",
	"lib/commcare/multimedia/logoEntry.ts",
	"proof/native/producers/emit-media-evidence.ts",
	"proof/native/core/MediaRuntimeTest.java",
	"lib/commcare/hqJson/caseList.ts",
	"lib/commcare/suite/case-list/columns.ts",
	"lib/commcare/validator/mediaSuiteOracle.ts",
];
write(
	"media-source-hashes.json",
	JSON.stringify(
		Object.fromEntries(
			paths.map((path) => [
				path,
				createHash("sha256")
					.update(readFileSync(new URL(`../../../${path}`, import.meta.url)))
					.digest("hex"),
			]),
		),
	),
);
console.log(output);
