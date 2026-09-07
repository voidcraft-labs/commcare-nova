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

const output = resolve(process.argv[2] ?? "/tmp/nova-media-evidence");
mkdirSync(output, { recursive: true });
const write = (path: string, bytes: string | Uint8Array) => {
	const file = resolve(output, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, bytes);
};
for (const mediaOnly of [false, true])
	for (const enabled of [false, true]) {
		const { doc, assets } = mediaWireFixture(mediaOnly);
		const name = `media-${mediaOnly ? "only" : "rich"}-${enabled ? "on" : "off"}`;
		const options = enabled ? { assets } : {};
		const hq = expandDoc(doc, options);
		const ccz = compileCcz(hq, doc.appName, doc, options);
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
const { assets } = mediaWireFixture();
write(
	"media-paths.properties",
	Object.entries(mediaIds)
		.map(([key, id]) => `${key}=jr://file/${assets.get(id)?.wirePath}`)
		.join("\n"),
);
const paths = [
	"lib/commcare/__tests__/mediaWireFixtures.ts",
	"lib/commcare/compiler.ts",
	"lib/commcare/expander.ts",
	"lib/commcare/multimedia/bundle.ts",
	"lib/commcare/multimedia/bulkUploadZip.ts",
	"lib/commcare/multimedia/mediaSuiteXml.ts",
	"lib/commcare/multimedia/itextMedia.ts",
	"lib/commcare/multimedia/navMenuMedia.ts",
	"lib/commcare/multimedia/logoEntry.ts",
	"scripts/fixtures/hq/emit-media-evidence.ts",
	"scripts/fixtures/javarosa/MediaRuntimeTest.java",
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
				createHash("sha256").update(readFileSync(path)).digest("hex"),
			]),
		),
	),
);
console.log(output);
