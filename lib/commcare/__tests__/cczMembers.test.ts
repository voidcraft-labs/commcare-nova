/**
 * Every member of a `.ccz` is written once, under a name no other member
 * shares in any letter case, and a media file never takes a name the
 * compiler gives its own files.
 *
 * The plausible failure: a zip writer that keeps the later of two members of
 * one name (adm-zip's `addFile` updates an entry it already holds), so a
 * media file a project space keeps at `default/app_strings.txt` or
 * `modules-0/forms-0.xml` replaces the file the oracles validated; and a
 * reservation made against the app's current languages, which a language
 * added later walks past. The archive is read back through the zip library
 * and every generated member compared with the compiler's own text.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import {
	appStringsMemberPath,
	formMemberPath,
	isGeneratedMemberPath,
	memberKey,
} from "../cczMembers";
import { compileCcz, compileCczParts } from "../compiler";
import { expandDoc } from "../expander";
import { localeFileText } from "../localeFile";
import type { AssetManifest } from "../multimedia/assetWirePath";
import { zipMembers } from "../zipMembers";
import { mediaIds, mediaWireFixture } from "./mediaWireFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

describe("isGeneratedMemberPath", () => {
	it("reserves every name the compiler gives its own files, and names under them, in any letter case", () => {
		for (const path of [
			"profile.ccpr",
			"suite.xml",
			"media_suite.xml",
			"Suite.XML/x.png",
			appStringsMemberPath("default"),
			appStringsMemberPath("fra"),
			"FRA/App_Strings.txt",
			"en/app_strings.txt/x.png",
			formMemberPath(0, 0),
			formMemberPath(12, 3),
			"Modules-0/Forms-0.XML",
			"modules-0/forms-0.xml/a.png",
		])
			expect(isGeneratedMemberPath(path), path).toBe(true);
	});

	it("holds every other name, the directories the compiler writes into among them", () => {
		for (const path of [
			"commcare/image/a.png",
			"media/logo.png",
			"default/logo.png",
			"modules-0/x.png",
			"a/b/app_strings.txt",
			"modules-0/forms-0.xml.png",
			"modules-x/forms-0.xml",
			"modules-0/forms-.xml",
			"suite.xml.png/a.png",
		])
			expect(isGeneratedMemberPath(path), path).toBe(false);
	});
});

describe("zipMembers", () => {
	const bytes = (text: string) => Buffer.from(text, "utf8");

	it("writes each member once and reads each back as written", () => {
		const zip = new AdmZip(
			zipMembers(
				[
					{ path: "suite.xml", bytes: bytes("<suite/>") },
					{ path: "default/app_strings.txt", bytes: bytes("a=b") },
					{ path: "media/logo.png", bytes: bytes("png") },
				],
				"test",
			),
		);
		expect(
			zip
				.getEntries()
				.map((entry) => [entry.entryName, entry.getData()])
				.sort(([a], [b]) => String(a).localeCompare(String(b))),
		).toEqual([
			["default/app_strings.txt", bytes("a=b")],
			["media/logo.png", bytes("png")],
			["suite.xml", bytes("<suite/>")],
		]);
	});

	it.each([
		["the same name", "default/app_strings.txt", "default/app_strings.txt"],
		[
			"one name in two letter cases",
			"default/app_strings.txt",
			"DEFAULT/App_Strings.TXT",
		],
		["a name under another member", "suite.xml", "suite.xml/x.png"],
		[
			"a member over another's directory",
			"en/app_strings.txt/x.png",
			"en/app_strings.txt",
		],
		[
			"a member named as a directory in another letter case",
			"Media/a.png",
			"media",
		],
	])(
		"throws for two members that are one file to a phone: %s",
		(_, first, second) => {
			expect(() =>
				zipMembers(
					[
						{ path: first, bytes: bytes("one") },
						{ path: second, bytes: bytes("two") },
					],
					"test",
				),
			).toThrow(/two archive members that are one file to a phone/);
		},
	);

	it("keys a name by its letters lowered", () => {
		expect(memberKey("FRA/App_Strings.TXT")).toBe("fra/app_strings.txt");
	});
});

/** The fixture's manifest with each asset's path replaced by `paths[id]`. */
function heldAt(
	assets: AssetManifest,
	paths: Readonly<Record<string, string>>,
): AssetManifest {
	return new Map(
		[...assets].map(([id, asset]) => [
			id,
			paths[id] === undefined ? asset : { ...asset, wirePath: paths[id] },
		]),
	);
}

describe("a .ccz whose media stand at paths a project space keeps", () => {
	it("holds every generated member as the compiler writes it, beside each media file, and nothing else", () => {
		const { doc, assets } = mediaWireFixture();
		doc.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fra" },
			translations: {},
		};
		/* Paths in the directories the compiler writes into, each beside a member
		 * of its own and none of one: a language's directory, a form's menu. */
		const held = heldAt(assets, {
			[mediaIds.label]: "fra/label.png",
			[mediaIds.option]: "modules-0/option.png",
			[mediaIds.icon]: "default/icon.png",
		});
		const options = { assets: held, runtimeTarget: TEST_RUNTIME_TARGET };
		const hq = expandDoc(doc, { assets: held });
		const zip = new AdmZip(compileCcz(hq, doc.appName, doc, options));
		const parts = compileCczParts(hq, doc.appName, doc, options);
		const generated = new Map<string, string>(Object.entries(parts.files));
		for (const [dir, table] of Object.entries(parts.tables))
			generated.set(appStringsMemberPath(dir), localeFileText(table));
		const media = new Map(
			[...held.values()].map((asset) => [asset.wirePath, asset.bytes]),
		);

		const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
		expect(entries).toHaveLength(generated.size + media.size);
		expect(
			new Set(entries.map((entry) => memberKey(entry.entryName))).size,
		).toBe(entries.length);
		for (const [path, text] of generated)
			expect(zip.readAsText(path), path).toBe(text);
		for (const [path, data] of media)
			expect(zip.readFile(path), path).toEqual(data);
		expect([...generated.keys()]).toContain(appStringsMemberPath("fra"));
		expect([...generated.keys()]).toContain(formMemberPath(0, 0));
	});

	it.each([
		appStringsMemberPath("default"),
		"FRA/App_Strings.txt",
		formMemberPath(0, 0),
	])(
		"refuses to write a media file over the compiler's own file %s",
		(path) => {
			const { doc, assets } = mediaWireFixture();
			doc.localization = {
				sourceLanguage: "eng",
				defaultLanguage: "eng",
				languageOrder: ["eng", "fra"],
				wireCodes: { eng: "en", fra: "fra" },
				translations: {},
			};
			const held = heldAt(assets, { [mediaIds.label]: path });
			expect(() =>
				compileCcz(expandDoc(doc, { assets: held }), doc.appName, doc, {
					assets: held,
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			).toThrow(/two archive members that are one file to a phone/);
		},
	);
});
