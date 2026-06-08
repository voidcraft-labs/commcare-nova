/**
 * Compiler-side media bundling: `compileCcz` with a resolved manifest
 * writes the media files into the archive, emits the media_suite.xml
 * descriptor, stamps the app-logo profile property, and renders the
 * module home-tile icon in suite.xml + app_strings. The media-OFF path
 * produces a media-free archive (empty media_suite, no logo property,
 * no bundled media bytes).
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { asAssetId } from "@/lib/domain/multimedia";

const ICON_HASH = "a".repeat(64);
const LOGO_HASH = "b".repeat(64);
const ICON_BYTES = Buffer.from("ICON-PNG-BYTES");
const LOGO_BYTES = Buffer.from("LOGO-PNG-BYTES");

function manifest(): AssetManifest {
	const entry = (
		id: string,
		hash: string,
		bytes: Buffer,
	): [ReturnType<typeof asAssetId>, ResolvedMediaAsset] => [
		asAssetId(id),
		{
			assetId: asAssetId(id),
			wirePath: `commcare/${hash}.png`,
			kind: "image",
			mimeType: "image/png",
			contentHash: hash,
			extension: ".png",
			bytes,
		},
	];
	return new Map([
		entry("icon", ICON_HASH, ICON_BYTES),
		entry("logo", LOGO_HASH, LOGO_BYTES),
	]);
}

function mediaDoc() {
	const doc = buildDoc({
		appName: "Media app",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[doc.moduleOrder[0]].icon = "icon";
	doc.logo = "logo";
	return doc;
}

function entries(buf: Buffer): Map<string, Buffer> {
	const zip = new AdmZip(buf);
	return new Map(zip.getEntries().map((e) => [e.entryName, e.getData()]));
}

describe("compileCcz media bundling", () => {
	it("bundles bytes, media_suite, logo property, and the module-icon display", () => {
		const doc = mediaDoc();
		const hqJson = expandDoc(doc, { assets: manifest() });
		const ccz = compileCcz(hqJson, "Media app", doc, { assets: manifest() });
		const files = entries(ccz);

		// The icon + logo bytes land at their wire paths, byte-for-byte.
		expect(files.get(`commcare/${ICON_HASH}.png`)).toEqual(ICON_BYTES);
		expect(files.get(`commcare/${LOGO_HASH}.png`)).toEqual(LOGO_BYTES);

		// media_suite.xml declares both as local-authority resources.
		const mediaSuite = files.get("media_suite.xml")?.toString("utf-8") ?? "";
		expect(mediaSuite).toContain('descriptor="Media Suite File"');
		expect(mediaSuite).toContain(
			`<location authority="local">./commcare/${ICON_HASH}.png</location>`,
		);

		// profile.ccpr carries the web-apps logo property.
		const profile = files.get("profile.ccpr")?.toString("utf-8") ?? "";
		expect(profile).toContain(
			`<property key="brand-banner-web-apps" value="jr://file/commcare/${LOGO_HASH}.png" force="true"/>`,
		);

		// suite.xml renders the module menu as a <display> with the icon locale.
		const suite = files.get("suite.xml")?.toString("utf-8") ?? "";
		expect(suite).toContain(
			'<text form="image"><locale id="modules.m0.icon"/></text>',
		);

		// app_strings resolves that locale to the icon's jr:// path.
		const appStrings =
			files.get("default/app_strings.txt")?.toString("utf-8") ?? "";
		expect(appStrings).toContain(
			`modules.m0.icon=jr://file/commcare/${ICON_HASH}.png`,
		);
	});

	it("produces a media-free archive when no manifest is provided", () => {
		const doc = mediaDoc();
		const hqJson = expandDoc(doc);
		const ccz = compileCcz(hqJson, "Media app", doc);
		const files = entries(ccz);

		expect(files.has(`commcare/${ICON_HASH}.png`)).toBe(false);
		expect(files.get("media_suite.xml")?.toString("utf-8")).toBe(
			'<?xml version="1.0"?>\n<suite version="1"/>',
		);
		const profile = files.get("profile.ccpr")?.toString("utf-8") ?? "";
		expect(profile).not.toContain("brand-banner-web-apps");
		const suite = files.get("suite.xml")?.toString("utf-8") ?? "";
		expect(suite).not.toContain('form="image"');
	});
});
