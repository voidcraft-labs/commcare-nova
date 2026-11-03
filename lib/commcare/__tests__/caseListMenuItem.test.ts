/**
 * The case list menu item (`Module.caseListMenuItem`) on both wire paths.
 *
 * Contract, at the pins in `~/code/commcare-hq`:
 *   - `suite_xml/sections/menus.py`: the module's `<menu>` lists the case
 *     list command (`m{N}-case-list`) after its form commands, wherever
 *     `case_list.show` is set.
 *   - `suite_xml/sections/entries.py::EntriesHelper.entry_for_module`: the
 *     case list entry holds no form; for a basic module its datums are
 *     those `configure_entry_module_form` gives a case-loading form of the
 *     module (with `add_remote_query_datums`' inline query where the forms
 *     read the search), and for an advanced module the one
 *     `case_id_case_<type>` datum over the module's case type.
 *   - The entry's label is the item's own label when it has one, else the
 *     module's name, and its media are the item's.
 *
 * Catches: the entry dropped beside forms, listed before the forms, given
 * datums a form of its module would not take, labelled or illustrated from
 * anything but the item, and a bare case list's bytes moving.
 */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type CaseListMenuItem,
	makeTranslationUnitId,
	NEW_APP_SETTINGS,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { compileCcz } from "../compiler";
import { caseListMenuItemLabelUnit } from "../emissionPlan";
import { expandDoc } from "../expander";
import { runValidation } from "../validator/runner";
import { mediaIds, mediaManifest } from "./mediaWireFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import {
	onlyXml,
	readXmlEvidence,
	type XmlEvidence,
	xmlChildren,
} from "./xmlEvidence";

const PATIENTS = testUuid("menu-item-patients");

function patientsDoc(
	options: {
		readonly item?: CaseListMenuItem;
		readonly forms?: boolean;
		readonly formsReadSearch?: boolean;
		readonly heldAdvanced?: boolean;
	} = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	if (options.formsReadSearch === true)
		config.searchInputs = [
			simpleSearchInputDef(
				testUuid("menu-item-name"),
				"patient_name",
				"Name",
				"text",
				"case_name",
			),
		];
	const doc = buildDoc({
		appName: "Clinic",
		// A menu whose forms read the search runs in Web Apps alone.
		...(options.formsReadSearch === true && {
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" as const },
		}),
		modules: [
			{
				uuid: PATIENTS,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				...(options.formsReadSearch === true && {
					caseSearchConfig: { formsReadSearch: true as const },
				}),
				...(options.item !== undefined && { caseListMenuItem: options.item }),
				forms:
					options.forms === false
						? []
						: [
								{
									name: "Visit",
									type: "followup",
									fields: [f({ kind: "text", id: "note" })],
								},
								...(options.formsReadSearch === true
									? []
									: [
											{
												name: "Register",
												type: "registration" as const,
												fields: [
													f({
														kind: "text",
														id: "case_name",
														label: proseText("Name"),
														caseWrite: {
															caseType: "patient",
															property: "case_name",
														},
													}),
												],
											},
										]),
							],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	if (options.heldAdvanced === true)
		doc.modules[PATIENTS] = { ...doc.modules[PATIENTS], heldKind: "advanced" };
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

function exported(doc: BlueprintDoc) {
	const assets = mediaManifest();
	const hq = expandDoc(doc, { runtimeTarget: TEST_RUNTIME_TARGET, assets });
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget: TEST_RUNTIME_TARGET,
			assets,
		}),
	);
	return {
		hq,
		suite: readXmlEvidence(zip.readAsText("suite.xml")),
		strings: zip.readAsText("default/app_strings.txt").split("\n"),
	};
}

const one = (node: XmlEvidence, name: string) =>
	onlyXml(xmlChildren(node, name));

function entry(suite: XmlEvidence, command: string): XmlEvidence {
	return onlyXml(
		xmlChildren(suite, "entry").filter(
			(node) => one(node, "command").attributes.id === command,
		),
	);
}

/** Each datum or query of an entry's session, by name and attributes. */
function sessionOf(node: XmlEvidence) {
	return xmlChildren(node, "session").flatMap((session) =>
		session.children.map((child) => [child.name, child.attributes] as const),
	);
}

function menuCommands(suite: XmlEvidence, menuId: string): string[] {
	return xmlChildren(
		onlyXml(
			xmlChildren(suite, "menu").filter(
				(menu) => menu.attributes.id === menuId,
			),
		),
		"command",
	).map((command) => command.attributes.id ?? "");
}

describe("a case list menu item beside forms", () => {
	const item: CaseListMenuItem = {
		label: "All patients",
		icon: mediaIds.icon,
		audioLabel: mediaIds.audio,
	};

	it("shows the case list in HQ JSON with the item's label and media", () => {
		const { hq } = exported(patientsDoc({ item }));
		const caseList = hq.modules[0].case_list;
		expect(caseList.show).toBe(true);
		expect(caseList.label).toEqual({ en: "All patients" });
		// The item's media, in the dict shape a module's own media takes.
		const twin = patientsDoc({ item });
		twin.modules[PATIENTS] = {
			...twin.modules[PATIENTS],
			icon: mediaIds.icon,
			audioLabel: mediaIds.audio,
		};
		const module = exported(twin).hq.modules[0];
		expect(caseList.media_image).toEqual(module.media_image);
		expect(caseList.media_audio).toEqual(module.media_audio);
		expect(Object.values(caseList.media_image)).not.toEqual([]);
	});

	it("names the item's own label unit, else the module's name", () => {
		expect(
			caseListMenuItemLabelUnit({ uuid: PATIENTS, caseListMenuItem: item }),
		).toBe(
			makeTranslationUnitId("module", PATIENTS, "case-list-menu-item-label"),
		);
		expect(
			caseListMenuItemLabelUnit({ uuid: PATIENTS, caseListMenuItem: {} }),
		).toBe(makeTranslationUnitId("module", PATIENTS, "name"));
		const { hq } = exported(patientsDoc({ item: {} }));
		expect(hq.modules[0].case_list.label).toEqual({ en: "Patients" });
	});

	it("lists the local case list command after the form commands", () => {
		const { suite } = exported(patientsDoc({ item }));
		expect(menuCommands(suite, "m0")).toEqual([
			"m0-f0",
			"m0-f1",
			"m0-case-list",
		]);
	});

	it("gives the entry the datums a case-loading form of the module takes", () => {
		const { suite, strings } = exported(patientsDoc({ item }));
		const caseList = entry(suite, "m0-case-list");
		expect(xmlChildren(caseList, "form")).toEqual([]);
		expect(xmlChildren(caseList, "post")).toEqual([]);
		expect(sessionOf(caseList)).toEqual(sessionOf(entry(suite, "m0-f0")));
		const display = one(one(caseList, "command"), "display");
		expect(
			xmlChildren(display, "text").map((text) => [
				text.attributes.form,
				one(text, "locale").attributes.id,
			]),
		).toEqual([
			[undefined, "case_lists.m0"],
			["image", "case_lists.m0.icon"],
			["audio", "case_lists.m0.audio"],
		]);
		expect(strings).toContain("case_lists.m0=All patients");
	});

	it("carries the inline query where the menu's forms read the search", () => {
		const { suite } = exported(
			patientsDoc({ item: {}, formsReadSearch: true }),
		);
		const caseList = sessionOf(entry(suite, "m0-case-list"));
		expect(caseList.map(([name]) => name)).toEqual(["query", "datum"]);
		expect(caseList).toEqual(sessionOf(entry(suite, "m0-f0")));
		expect(caseList[1]?.[1].nodeset).toContain("instance('results:inline')");
	});

	it("gives an advanced menu's entry its one case datum", () => {
		const { hq, suite } = exported(
			patientsDoc({ item: {}, heldAdvanced: true }),
		);
		expect(hq.modules[0].doc_type).toBe("AdvancedModule");
		expect(hq.modules[0].case_list.show).toBe(true);
		expect(menuCommands(suite, "m0")).toEqual([
			"m0-f0",
			"m0-f1",
			"m0-case-list",
		]);
		expect(
			sessionOf(entry(suite, "m0-case-list")).map(([name, attributes]) => [
				name,
				attributes.id,
				attributes.nodeset,
			]),
		).toEqual([
			[
				"datum",
				"case_id_case_patient",
				"instance('casedb')/casedb/case[@case_type = 'patient'][@status = 'open']",
			],
		]);
	});
});

describe("a bare case list", () => {
	it("keeps its bytes: the module name's label and the browse entry alone", () => {
		const { hq, suite, strings } = exported(
			patientsDoc({ item: {}, forms: false }),
		);
		expect(hq.modules[0].case_list).toMatchObject({
			show: true,
			label: { en: "Patients" },
			media_image: {},
			media_audio: {},
		});
		expect(menuCommands(suite, "m0")).toEqual(["m0-case-list"]);
		expect(sessionOf(entry(suite, "m0-case-list"))).toEqual([
			[
				"datum",
				{
					id: "case_id",
					nodeset:
						"instance('casedb')/casedb/case[@case_type = 'patient'][@status = 'open']",
					value: "./@case_id",
					"detail-select": "m0_case_short",
					"detail-confirm": "m0_case_long",
				},
			],
		]);
		const display = one(entry(suite, "m0-case-list"), "command");
		expect(xmlChildren(display, "display")).toEqual([]);
		expect(strings).toContain("case_lists.m0=Patients");
	});

	it("has no case list entry without the item", () => {
		const { hq, suite } = exported(patientsDoc());
		expect(hq.modules[0].case_list.show).toBe(false);
		expect(menuCommands(suite, "m0")).toEqual(["m0-f0", "m0-f1"]);
	});
});
