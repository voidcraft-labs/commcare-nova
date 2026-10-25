import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	mediaIds,
	mediaWireFixture,
} from "../../../lib/commcare/__tests__/mediaWireFixtures";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { buildMediaBulkUploadZip } from "../../../lib/commcare/multimedia/bulkUploadZip";
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
for (const mediaOnly of [false, true])
	for (const enabled of [false, true]) {
		// The family's scenario holds one file of each format defect 11's first
		// half accepts, each in a slot of its kind, beside the corpus's media.
		const { doc, assets } = mediaWireFixture(mediaOnly, "every-platform");
		const name = `media-${mediaOnly ? "only" : "rich"}-${enabled ? "on" : "off"}`;
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
		for (const [source, target] of [
			["suite.xml", `${name}.suite.xml`],
			["media_suite.xml", `${name}.media-suite.xml`],
			["profile.ccpr", `${name}.profile.xml`],
			["default/app_strings.txt", `${name}.strings.properties`],
			["modules-0/forms-0.xml", `${name}.xml`],
		])
			write(target, zip.readAsText(source));
		if (enabled) {
			write(`${name}.multimedia.zip`, buildMediaBulkUploadZip(assets));
			for (const asset of assets.values()) {
				if (!asset.bytes) throw new Error("Missing bytes");
				write(asset.wirePath, asset.bytes);
			}
		}
	}
const { assets } = mediaWireFixture(false, "every-platform");
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
	"lib/media/__tests__/fixtures/tiny-video.mp4",
	"lib/media/__tests__/fixtures/tone.m4a",
	"lib/media/__tests__/fixtures/tone.flac",
	"lib/media/__tests__/fixtures/tone-vorbis.ogg",
	"lib/media/__tests__/fixtures/tone-opus.ogg",
	"lib/media/__tests__/fixtures/pattern-vp8.webm",
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
