/**
 * A case list icon that submits a form, from the destinations it may name to
 * both export boundaries. A form's real automatic-submission label is the
 * same witness the HQ Case List editor uses.
 */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingErrors } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	type Column,
	entryPointByUuid,
	entryPointInventory,
	imageMapColumn,
	imageMapEntry,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	tileCell,
	type Uuid,
} from "@/lib/domain";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import {
	createListIconDestination,
	listIconActionIssue,
	listIconCaseType,
	listIconDestinations,
} from "../listIconAction";
import { projectSpaceCompatibilityProbePlan } from "../projectSpaceCompatibility";
import {
	closedCodes,
	listOf,
	readLists,
} from "../reader/caseList/__tests__/listReading";
import { runValidation } from "../validator/runner";
import { mediaIds, mediaManifest, mediaRecords } from "./mediaWireFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

const VISITS = testUuid("icon-visits");
const RECORD = testUuid("icon-record-visit");
const LABEL = testUuid("icon-visit-state");
const REGISTER = testUuid("icon-register-visit");
const HOUSEHOLD_FORM = testUuid("icon-household-visit");
const ICON = testUuid("icon-column");
const LINK = testUuid("icon-record-link");
const REGISTER_LINK = testUuid("icon-register-link");
const HOUSEHOLD_LINK = testUuid("icon-household-link");

/** A web-apps app whose Visits list shows an image that submits Record
 * visit for the tapped visit, beside two deep links an icon on that list
 * may not name: a registration, and a household's follow-up. */
function visits(
	icon: { readonly entryPointUuid?: Uuid; readonly action?: false } = {},
): BlueprintDoc {
	const columns: Column[] = [
		plainColumn(testUuid("icon-name"), "case_name", "Visit"),
		imageMapColumn(
			ICON,
			"visit_state",
			"Record",
			[{ ...imageMapEntry("ready", mediaIds.label), match: "exact" }],
			icon.action === false
				? {}
				: { entryPointUuid: icon.entryPointUuid ?? LINK },
		),
	];
	const doc = buildDoc({
		appName: "Visit actions",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "visit",
				parent_type: "household",
				properties: [{ name: "visit_state", label: proseText("State") }],
			},
			{ name: "household", properties: [] },
		],
		modules: [
			{
				uuid: "icon-visits",
				name: "Visits",
				caseType: "visit",
				caseListConfig: {
					columns,
					listColumnOrder: columns.map((column) => column.uuid),
					detailColumnOrder: columns.map((column) => column.uuid),
					searchInputs: [],
				},
				forms: [
					{
						uuid: "icon-record-visit",
						name: "Record visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "state",
								uuid: LABEL,
								label: proseText("Record this visit"),
								hint: proseText("Confirm the visit record"),
								default_value: "'visited'",
								caseWrite: { caseType: "visit", property: "visit_state" },
							}),
						],
					},
					{
						uuid: "icon-register-visit",
						name: "Register visit",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "icon-household-visit",
						name: "Visit household",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	doc.forms[RECORD].entryPoint = { uuid: LINK, id: "record-visit" };
	doc.forms[RECORD].automaticSubmissionText = {
		carrier: { role: "field-label", field: LABEL },
	};
	doc.forms[REGISTER].entryPoint = { uuid: REGISTER_LINK, id: "register" };
	doc.forms[HOUSEHOLD_FORM].entryPoint = {
		uuid: HOUSEHOLD_LINK,
		id: "household-visit",
	};
	return doc;
}

function iconOf(doc: BlueprintDoc): Extract<Column, { kind: "image-map" }> {
	const column = doc.modules[VISITS].caseListConfig?.columns.find(
		(candidate) => candidate.uuid === ICON,
	);
	if (column?.kind !== "image-map") throw new Error("The list has no icon.");
	return column;
}

function findings(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE, {
		mediaAssets: mediaRecords(mediaManifest()),
	});
}

function iconFindings(doc: BlueprintDoc): string[] {
	const icon = findings(doc).filter(
		(error) => error.code === "CASE_LIST_ICON_ACTION_INVALID",
	);
	// The Builder's copy is built from the finding's details, and reads the same.
	expect(userFacingErrors(icon)).toEqual(icon.map((error) => error.message));
	return icon.map((error) => error.message);
}

const descend = (node: XmlEvidence): XmlEvidence[] =>
	node.children.flatMap((child) => [child, ...descend(child)]);

describe("the forms an icon may submit", () => {
	it("offers exactly a form that opens with one case of the list's type", () => {
		const doc = visits();
		expect(findings(doc)).toEqual([]);
		expect(
			listIconDestinations(doc, doc.modules[VISITS], iconOf(doc)).map(
				(destination) => destination.entryPointId,
			),
		).toEqual(["record-visit"]);
		const resolve = createListIconDestination(doc);
		const item = entryPointByUuid(doc, LINK);
		if (item === undefined) throw new Error("Missing the deep link.");
		expect(resolve("household", item)).toBeUndefined();
		expect(resolve(undefined, item)).toBeUndefined();
	});

	it("offers none while no form submits as soon as it opens", () => {
		const doc = visits();
		delete doc.forms[RECORD].automaticSubmissionText;
		expect(listIconDestinations(doc, doc.modules[VISITS], iconOf(doc))).toEqual(
			[],
		);
		expect(iconFindings(doc)).toEqual([
			'"Record" needs a form that opens with one visit case and submits as soon as it opens, and no form in this app does. You can remove the icon\'s action.',
		]);
	});

	it("requires the editor's question-label pragma, including when that label shares it", () => {
		const doc = visits();
		const carrier = { role: "field-hint" as const, field: LABEL };
		doc.forms[RECORD].automaticSubmissionText = { carrier };
		expect(listIconDestinations(doc, doc.modules[VISITS], iconOf(doc))).toEqual(
			[],
		);
		doc.forms[RECORD].automaticSubmissionText = {
			carrier,
			alsoUsedBy: [{ role: "field-label", field: LABEL }],
		};
		expect(
			listIconDestinations(doc, doc.modules[VISITS], iconOf(doc)),
		).toHaveLength(1);
	});

	it("offers a form off the menu only through a deep link that ignores display conditions", () => {
		const doc = visits();
		doc.forms[RECORD].hiddenFromMenu = true;
		expect(listIconDestinations(doc, doc.modules[VISITS], iconOf(doc))).toEqual(
			[],
		);
		const link = doc.forms[RECORD].entryPoint;
		if (link === undefined) throw new Error("Missing the deep link.");
		doc.forms[RECORD].entryPoint = { ...link, ignoreDisplayConditions: true };
		expect(
			listIconDestinations(doc, doc.modules[VISITS], iconOf(doc)),
		).toHaveLength(1);
	});

	it("refuses a registration, another type's form and a removed deep link", () => {
		// Record visit qualifies, so the finding offers it as another form.
		for (const entryPointUuid of [REGISTER_LINK, HOUSEHOLD_LINK])
			expect(iconFindings(visits({ entryPointUuid }))).toEqual([
				'"Record" needs a form that opens with one visit case and submits as soon as it opens. You can choose another form for the icon or remove its action.',
			]);
		const removed = visits();
		delete removed.forms[RECORD].entryPoint;
		expect(iconFindings(removed)).toHaveLength(1);
	});

	it("refuses an icon in an app that runs on Android, which shows the image's path", () => {
		for (const runsOnlyOn of [undefined, "android"] as const) {
			const doc = visits();
			doc.appSettings = {
				...NEW_APP_SETTINGS,
				...(runsOnlyOn !== undefined && { runsOnlyOn }),
			};
			expect(
				listIconDestinations(doc, doc.modules[VISITS], iconOf(doc)),
			).toEqual([]);
			expect(findings(doc)).toContainEqual(
				expect.objectContaining({
					code: "PLATFORM_FEATURE_UNAVAILABLE",
					details: expect.objectContaining({
						feature: "case-list-icon-actions",
						platform: "android",
					}),
				}),
			);
		}
	});

	it("refuses an icon hidden from Results", () => {
		const doc = visits();
		iconOf(doc).visibleInList = false;
		expect(listIconDestinations(doc, doc.modules[VISITS], iconOf(doc))).toEqual(
			[],
		);
		expect(iconFindings(doc)).toEqual([
			'"Record" needs to show on Results for a worker to tap its icon. You can show it on Results or remove the icon\'s action.',
		]);
	});

	it("passes a grouped tile's header case and refuses an icon in a group's body", () => {
		const doc = visits();
		const module = doc.modules[VISITS];
		const config = module.caseListConfig;
		if (config === undefined) throw new Error("The menu has no list.");
		const icon = iconOf(doc);
		config.tile = { grouping: { identifier: "parent", headerRows: 1 } };
		icon.tile = tileCell(0, 0, 1, 1);
		expect(listIconCaseType(doc, module, icon)).toBe("household");
		icon.tile = tileCell(0, 1, 1, 1);
		expect(listIconCaseType(doc, module, icon)).toBeUndefined();
		expect(listIconActionIssue(doc, module, icon)).toEqual({
			reason: "grouped-body",
		});
	});
});

describe("an icon at both export boundaries", () => {
	it("is a clickable icon on Results naming the form's current deep link, and an image on Details", () => {
		const doc = visits();
		const link = doc.forms[RECORD].entryPoint;
		if (link === undefined) throw new Error("Missing the deep link.");
		doc.forms[RECORD].entryPoint = { ...link, id: "record-next-visit" };
		expect(findings(doc)).toEqual([]);
		const assets = mediaManifest();
		const hq = expandDoc(doc, { assets });
		const { short, long } = hq.modules[0].case_details;
		expect(short.columns[1]).toMatchObject({
			format: "clickable-icon",
			endpoint_action_id: "record-next-visit",
		});
		expect(long.columns[1]).toMatchObject({ format: "enum-image" });
		expect(long.columns[1]).not.toHaveProperty("endpoint_action_id");

		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				assets,
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const suite = readXmlEvidence(zip.readAsText("suite.xml"));
		const detail = (id: string) =>
			descend(suite).find(
				(node) => node.name === "detail" && node.attributes.id === id,
			);
		const iconField = (id: string) =>
			detail(id)?.children.filter((node) => node.name === "field")[1];
		const listed = iconField("m0_case_short");
		// HQ's field order: template, then its action, then sort and alt text
		// (`xml_models.py::Field.ORDER`).
		expect(listed?.children.map((node) => node.name)).toEqual([
			"header",
			"template",
			"endpoint_action",
			"sort",
			"alt_text",
		]);
		expect(
			listed?.children.find((node) => node.name === "template")?.attributes
				.form,
		).toBe("clickable-icon");
		expect(
			listed?.children.find((node) => node.name === "endpoint_action")
				?.attributes,
		).toEqual({ endpoint_id: "record-next-visit", background: "true" });
		const shown = iconField("m0_case_long");
		expect(shown?.children.map((node) => node.name)).not.toContain(
			"endpoint_action",
		);
		expect(
			shown?.children.find((node) => node.name === "template")?.attributes.form,
		).toBe("image");
	});
});

it("reads HQ’s action and its plain detail image as one column tied to the form identity", async () => {
	const reading = await readLists(visits(), { media: true });
	expect(closedCodes(reading)).toEqual([]);
	const read = reading.ctx.doc;
	if (!read) throw new Error("Expected a readable app.");
	const target = entryPointInventory(read).find(
		(one) => one.entryPoint.id === "record-visit",
	);
	if (target?.target.kind !== "form")
		throw new Error("Expected the form’s entry point.");
	const list = listOf(reading);
	expect(list.columns.filter((column) => column.kind === "image-map")).toEqual([
		expect.objectContaining({ entryPointUuid: target.entryPoint.uuid }),
	]);
	const icon = list.columns.find((column) => column.kind === "image-map");
	expect(list.listColumnOrder).toContain(icon?.uuid);
	expect(list.detailColumnOrder).toContain(icon?.uuid);
});

describe("what the icon asks of a project space and the tools", () => {
	it("asks for CommCare HQ's clickable icon setting", () => {
		const plan = projectSpaceCompatibilityProbePlan(visits());
		const icon = plan.capabilities.find(
			(capability) => capability.capability.id === "case-list-icon-actions",
		);
		expect(icon?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-list-icon-actions",
		]);
	});

	it("lists each image column's forms by deep link in getModule", async () => {
		const doc = visits();
		const read = await getModuleTool.execute({ moduleUuid: VISITS }, {
			snapshot: { doc },
		} as never);
		expect(read).toMatchObject({
			data: {
				listIconDestinations: [
					{
						columnUuid: ICON,
						deepLinks: [{ id: "record-visit", form: "Visits / Record visit" }],
					},
				],
			},
		});
		delete doc.forms[RECORD].automaticSubmissionText;
		const none = await getModuleTool.execute({ moduleUuid: VISITS }, {
			snapshot: { doc },
		} as never);
		expect(none).not.toHaveProperty("data.listIconDestinations");
	});

	it("is authored by deep link ID through the shared tools and refused for a form that can't run it", async () => {
		const h = makeAuthoringHarness({}, visits({ action: false }));
		const column = (entryPointUuid: string) => ({
			moduleUuid: "Visits",
			columnUuid: "Record",
			column: {
				kind: "image-map",
				field: "visit_state",
				header: "Record",
				entryPointUuid,
				mapping: [{ value: "ready", match: "exact", assetId: mediaIds.label }],
			},
		});
		expect(
			await h.call("updateCaseListColumn", column("register")),
		).toMatchObject({
			error: expect.stringContaining(
				"needs a form that opens with one visit case",
			),
		});
		expect(iconOf(h.currentDoc()).entryPointUuid).toBeUndefined();
		expect(
			await h.call("updateCaseListColumn", column("record-visit")),
		).toMatchObject({ ok: true });
		expect(iconOf(h.currentDoc()).entryPointUuid).toBe(LINK);
		expect(await h.call("getModule", { moduleUuid: "Visits" })).toMatchObject({
			listIconDestinations: [{ deepLinks: [{ id: "record-visit" }] }],
		});
	});
});
