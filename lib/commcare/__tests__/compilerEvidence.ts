import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AdmZip from "adm-zip";
import { assert, type IProperty, type Parameters } from "fast-check";
import { expect } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { validateBindingResolution } from "@/lib/commcare/validator/bindingResolutionOracle";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { validateMediaSuite } from "@/lib/commcare/validator/mediaSuiteOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { rebuildFieldParent, toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";

import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

// Real, small media. Multiple asset IDs sharing content exercise bundle dedup.
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWOYJhLwHwAEOAH6SipT6gAAAABJRU5ErkJggg==",
	"base64",
);
const wav = Buffer.alloc(46);
wav.write("RIFF");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
const media = {
	image: { bytes: png, extension: ".png", mimeType: "image/png" },
	audio: { bytes: wav, extension: ".wav", mimeType: "audio/wav" },
	video: {
		bytes: readFileSync(
			new URL("../../media/__tests__/fixtures/tiny-video.mp4", import.meta.url),
		),
		extension: ".mp4",
		mimeType: "video/mp4",
	},
};

function manifestFor(doc: BlueprintDoc): AssetManifest {
	const manifest = new Map<ResolvedMediaAsset["assetId"], ResolvedMediaAsset>();
	for (const ref of walkAssetRefs(doc)) {
		const fixture = media[ref.slotKind];
		const contentHash = createHash("sha256")
			.update(fixture.bytes)
			.digest("hex");
		manifest.set(ref.assetId, {
			assetId: ref.assetId,
			kind: ref.slotKind,
			...fixture,
			contentHash,
			wirePath: `commcare/${contentHash}${fixture.extension}`,
		});
	}
	return manifest;
}

// Select fast-check's synchronous overload explicitly. This boundary cannot
// accept asyncProperty, and must not create an artificial async test lifetime.
export const assertGenerated: <Ts>(
	property: IProperty<Ts>,
	parameters: Parameters<Ts>,
) => void = assert;

/**
 * One expansion and archive per sample, shared by two different corpora.
 * Nova's oracles check their supported syntax, not native CommCare execution.
 * Additional checks join actual suite entries to archived forms by namespace,
 * and verify complete resource cardinality and media bytes independently.
 */
export function checkCompilerEvidence(doc: BlueprintDoc): void {
	rebuildFieldParent(doc);
	const schema = blueprintDocSchema.safeParse(toPersistableDoc(doc));
	if (!schema.success)
		throw new Error(`Invalid generated schema: ${schema.error.message}`);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const manifest = manifestFor(doc);
	const manifestPaths = new Set(
		Array.from(manifest.values(), (a) => a.wirePath),
	);
	const hq = expandDoc(doc, { assets: manifest });
	expect(validateHqJson(hq)).toEqual([]);
	const sources = Object.entries(hq._attachments).filter(([path]) =>
		path.endsWith(".xml"),
	);
	expect(sources).toHaveLength(Object.keys(doc.forms).length);
	for (const [path, source] of sources) {
		if (typeof source !== "string")
			throw new Error(`Missing XForm source ${path}`);
		expect(validateXForm(source, path, doc.appName, manifestPaths)).toEqual([]);
	}
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { assets: manifest }),
	);
	const read = (path: string): string => {
		const entry = zip.getEntry(path);
		if (!entry) throw new Error(`Archive is missing ${path}`);
		return entry.getData().toString("utf8");
	};
	const suiteXml = read("suite.xml");
	const strings = new Map<string, string>();
	for (const line of read("default/app_strings.txt").split("\n")) {
		const eq = line.indexOf("=");
		if (eq >= 0) strings.set(line.slice(0, eq), line.slice(eq + 1));
	}
	expect(
		validateSuite(suiteXml, new Set(strings.keys()), {
			appStringValues: strings,
			manifest: manifestPaths,
		}),
	).toEqual([]);
	const bundled = zip
		.getEntries()
		.filter((e) => !e.isDirectory && e.entryName.startsWith("commcare/"));
	expect(new Set(bundled.map((e) => e.entryName))).toEqual(manifestPaths);
	expect(validateMediaSuite(read("media_suite.xml"), manifestPaths)).toEqual(
		[],
	);
	for (const asset of manifest.values())
		expect(zip.getEntry(asset.wirePath)?.getData()).toEqual(asset.bytes);

	const suite = readXmlEvidence(suiteXml);
	const forms = new Map<string, { path: string; xml: string }>();
	const resources = xmlChildren(suite, "xform");
	expect(resources).toHaveLength(Object.keys(doc.forms).length);
	const resourcePaths = new Set<string>();
	for (const xform of resources) {
		const resource = onlyXml(xmlChildren(xform, "resource"));
		const local = onlyXml(
			xmlChildren(resource, "location").filter(
				(e) => e.attributes.authority === "local",
			),
		);
		const path = local.text.replace(/^\.\//, "");
		expect(resourcePaths.has(path)).toBe(false);
		resourcePaths.add(path);
		const xml = read(path);
		const root = readXmlEvidence(xml);
		const head = onlyXml(xmlChildren(root, "head"));
		const model = onlyXml(
			head.children.filter(
				(node) =>
					node.name === "model" && node.uri === "http://www.w3.org/2002/xforms",
			),
		);
		const main = onlyXml(
			xmlChildren(model, "instance").filter((e) => !e.attributes.src),
		);
		const namespace = onlyXml(main.children).uri;
		expect(namespace).toBeTruthy();
		expect(forms.has(namespace)).toBe(false);
		forms.set(namespace, { path, xml });
	}
	const archivedForms = zip
		.getEntries()
		.filter((e) => /^modules-\d+\/forms-\d+\.xml$/.test(e.entryName));
	expect(new Set(archivedForms.map((e) => e.entryName))).toEqual(resourcePaths);
	const visited = new Set<string>();
	for (const entry of xmlChildren(suite, "entry")) {
		const formElements = xmlChildren(entry, "form");
		if (formElements.length === 0) continue; // Case-list browsing is formless.
		const namespace = onlyXml(formElements).text;
		expect(visited.has(namespace)).toBe(false);
		visited.add(namespace);
		const form = forms.get(namespace);
		if (!form) throw new Error(`Suite entry names an absent form ${namespace}`);
		const sessions = xmlChildren(entry, "session");
		expect(sessions.length).toBeLessThanOrEqual(1);
		const datums = sessions.flatMap((session) => xmlChildren(session, "datum"));
		const datumIds = new Set(datums.map((d) => d.attributes.id));
		expect(datumIds.size).toBe(datums.length);
		expect(
			validateBindingResolution(form.xml, form.path, doc.appName, datumIds),
		).toEqual([]);
	}
	expect(visited).toEqual(new Set(forms.keys()));
}
