/**
 * `caseListOnly` browse-entry emission on the local `.ccz` path.
 *
 * A `caseListOnly` module has no forms, so without a standalone case-list
 * command its `<menu>` carries zero commands and the case list is
 * unreachable on a directly-installed archive. CCHQ, regenerating the
 * suite from the same `HqApplication` JSON on upload, emits a case-list
 * command + entry from its `if module.case_list.show:` block
 * (`commcare-hq/.../app_manager/suite_xml/sections/entries.py`). These
 * tests pin Nova's local compiler to that same shape so the two artifacts
 * agree:
 *
 *   - `<menu id="m0">` references `<command id="m0-case-list"/>`.
 *   - An `<entry>` with `<command id="m0-case-list">`, NO `<form>`, the
 *     `casedb` instance, and a `<datum id="case_id" ...
 *     detail-select="m0_case_short" detail-confirm="m0_case_long"/>` that
 *     browses the case list (both the list and the detail screen).
 *   - With case-list-link menu media, the command renders a `<display>`
 *     carrying `<text form="image"><locale id="case_lists.m0.icon"/></text>`
 *     resolving to the icon's jr:// path — the render target the
 *     expander's `case_list.media_*` stamping always implied but the local
 *     path previously had nowhere to land.
 *
 * The whole suite passes the compiler's own suite oracle (a thrown error
 * is the failure mode), so reaching the assertions already proves the
 * emitted entry resolves its menu→command ref, its datum→detail refs, its
 * instance refs, and its locale ids.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import { asUuid, plainColumn } from "@/lib/domain";
import { asAssetId } from "@/lib/domain/multimedia";
import { eq, literal, sessionUser, term } from "@/lib/domain/predicate";

const ICON_HASH = "c".repeat(64);
const ICON_BYTES = Buffer.from("CASE-LIST-ICON-PNG-BYTES");

/** A manifest carrying one resolved image for the case-list link icon. */
function manifest(): AssetManifest {
	const id = asAssetId("cl-icon");
	const asset: ResolvedMediaAsset = {
		assetId: id,
		wirePath: `commcare/${ICON_HASH}.png`,
		kind: "image",
		mimeType: "image/png",
		contentHash: ICON_HASH,
		extension: ".png",
		bytes: ICON_BYTES,
	};
	return new Map([[id, asset]]);
}

/**
 * A single `caseListOnly` module (no forms) with a case type and a
 * minimal case-list column. `caseListConfig` is built inline (not via the
 * `caseListConfig` helper) so the media case can seed an `icon` slot at
 * construction — passing it here keeps the config fully typed without a
 * post-construction non-null mutation.
 */
function caseListOnlyDoc(caseListIcon?: string) {
	return buildDoc({
		appName: "Browse app",
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListOnly: true,
				forms: [],
				caseListConfig: {
					columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
					searchInputs: [],
					...(caseListIcon !== undefined && { icon: caseListIcon }),
				},
			},
		],
	});
}

/** Read every archive entry into a name→Buffer map. */
function entries(buf: Buffer): Map<string, Buffer> {
	const zip = new AdmZip(buf);
	return new Map(zip.getEntries().map((e) => [e.entryName, e.getData()]));
}

/** Compile a doc to its `suite.xml` text, optionally media-ON. */
function suiteXml(
	doc: ReturnType<typeof caseListOnlyDoc>,
	assets?: AssetManifest,
): string {
	// Pass the SAME manifest to both `expandDoc` and `compileCcz` — the
	// compiler's contract requires it so jr:// references and bundled
	// bytes can't diverge.
	const hqJson = assets ? expandDoc(doc, { assets }) : expandDoc(doc);
	const ccz = assets
		? compileCcz(hqJson, doc.appName, doc, { assets })
		: compileCcz(hqJson, doc.appName, doc);
	return entries(ccz).get("suite.xml")?.toString("utf-8") ?? "";
}

describe("caseListOnly browse-entry emission (local .ccz)", () => {
	it("emits a case-list command in the menu and a form-less browse entry", () => {
		const suite = suiteXml(caseListOnlyDoc());

		// The menu references the case-list command — without this the
		// menu is empty and the case list is unreachable on-device.
		expect(suite).toContain('<menu id="m0">');
		expect(suite).toMatch(
			/<menu id="m0">[\s\S]*<command id="m0-case-list"\/>[\s\S]*<\/menu>/,
		);

		// The browse entry carries the case-list command with its locale.
		expect(suite).toContain('<command id="m0-case-list">');
		expect(suite).toContain('<locale id="case_lists.m0"/>');

		// Isolate the case-list entry to assert its internal shape without
		// the menu/detail noise. CCHQ's case-list entry is the only `<entry>`
		// in a formless module, so a single match is unambiguous.
		const entryMatch = suite.match(
			/<entry>(?:(?!<\/entry>)[\s\S])*<command id="m0-case-list">[\s\S]*?<\/entry>/,
		);
		expect(entryMatch).not.toBeNull();
		const entry = entryMatch?.[0] ?? "";

		// No `<form>` — the browse entry launches no form (CCHQ's
		// `case_list.show` entry carries none).
		expect(entry).not.toContain("<form>");

		// The casedb instance the datum's nodeset reads from.
		expect(entry).toContain(
			'<instance id="casedb" src="jr://instance/casedb"/>',
		);

		// The browse datum: both detail-select (list screen) AND
		// detail-confirm (detail screen). A pure browse has no follow-on
		// form, so the confirm screen IS the destination.
		expect(entry).toMatch(
			/<datum id="case_id"[^>]*detail-select="m0_case_short"[^>]*detail-confirm="m0_case_long"\/>/,
		);
		// The nodeset loads open patient cases. The serializer renders
		// `'` as `&apos;`, so the on-wire string carries the escaped form.
		expect(entry).toContain(
			"instance(&apos;casedb&apos;)/casedb/case[@case_type=&apos;patient&apos;][@status=&apos;open&apos;]",
		);
	});

	it("renders the case-list command as a media <display> when the link carries an icon", () => {
		// Seed the case-list-link icon at construction (resolved by the
		// manifest above) so the config stays fully typed.
		const doc = caseListOnlyDoc("cl-icon");

		const suite = suiteXml(doc, manifest());

		// The command's display wraps the base text plus the image media
		// locale — the same `<display>` shape `buildNavMenuNode` produces
		// for any media-carrying nav carrier.
		expect(suite).toContain('<command id="m0-case-list">');
		expect(suite).toContain(
			'<text form="image"><locale id="case_lists.m0.icon"/></text>',
		);

		// app_strings resolves that media locale to the icon's jr:// path.
		const hqJson = expandDoc(doc, { assets: manifest() });
		const ccz = compileCcz(hqJson, doc.appName, doc, { assets: manifest() });
		const appStrings =
			entries(ccz).get("default/app_strings.txt")?.toString("utf-8") ?? "";
		expect(appStrings).toContain(
			`case_lists.m0.icon=jr://file/commcare/${ICON_HASH}.png`,
		);
		// The base label resolves to the module name (CCHQ's
		// `case_list.label = { en: mod.name }`).
		expect(appStrings).toContain("case_lists.m0=Patients");
	});

	it("declares the search-button display condition's instances on the browse entry", () => {
		// A `caseListOnly` module may still carry a `caseSearchConfig`
		// (the combo is a valid, silent authoring state). Its
		// `searchButtonDisplayCondition` lowers to the `<action relevant>`
		// on `m0_case_short` — and in a formless module the browse entry is
		// the SOLE loader of that detail (`detail-select="m0_case_short"`),
		// so it's the only place the condition's instances can be declared.
		//
		// The condition references a session-user property, which must pull
		// the `commcaresession` instance onto the browse entry. This explicit
		// `<instance>` assertion is the LOAD-BEARING guard for that: the suite
		// oracle's detail→entry instance check is inert for `commcaresession`
		// / `casedb` (both are runtime-seeded ids in its `RUNTIME_INSTANCE_IDS`
		// set), so a dropped declaration neither trips the oracle nor crashes
		// the device — it only silently diverges from CCHQ's wire shape. The
		// oracle will not catch a regression here; do not weaken this assertion.
		const doc = caseListOnlyDoc();
		const mod = doc.modules[doc.moduleOrder[0]];
		mod.caseSearchConfig = {
			searchButtonDisplayCondition: eq(sessionUser("role"), literal("nurse")),
		};

		const suite = suiteXml(doc);

		// Isolate the browse entry and assert it declares the session
		// instance the display condition reaches.
		const entryMatch = suite.match(
			/<entry>(?:(?!<\/entry>)[\s\S])*<command id="m0-case-list">[\s\S]*?<\/entry>/,
		);
		expect(entryMatch).not.toBeNull();
		const entry = entryMatch?.[0] ?? "";
		expect(entry).toContain(
			'<instance id="commcaresession" src="jr://instance/session"/>',
		);
	});

	it("applies an owner-only availability rule without emitting a Search action", () => {
		const doc = caseListOnlyDoc();
		const mod = doc.modules[doc.moduleOrder[0]];
		mod.caseSearchConfig = {
			searchActionEnabled: false,
			excludedOwnerIds: term(literal("owner-a owner-b")),
		};

		const suite = suiteXml(doc);
		const entryMatch = suite.match(
			/<entry>(?:(?!<\/entry>)[\s\S])*<command id="m0-case-list">[\s\S]*?<\/entry>/,
		);
		const entry = entryMatch?.[0] ?? "";

		// The raw owner rule narrows the ordinary casedb nodeset. The
		// internal false marker means this rule did not author a Search action,
		// so neither a remote request nor an action is invented on export.
		expect(entry).toContain(
			"[normalize-space(&apos;owner-a owner-b&apos;) = &apos;&apos; or not(selected(normalize-space(&apos;owner-a owner-b&apos;), @owner_id))]",
		);
		expect(suite).not.toContain("<remote-request");
		expect(suite).not.toContain("<action");
	});

	it("emits a manual Search action when zero inputs are intentional", () => {
		const doc = caseListOnlyDoc();
		const mod = doc.modules[doc.moduleOrder[0]];
		mod.caseSearchConfig = {};

		const suite = suiteXml(doc);

		expect(suite).toContain("<remote-request>");
		expect(suite).toContain('auto_launch="false()"');
		expect(suite).toMatch(/<action auto_launch="false\(\)"[^>]*>/);
	});
});
