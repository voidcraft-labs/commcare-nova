import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	entrySessionDatums,
	formFrameChildren,
	formLinkProjectionContext,
	moduleDestinationFrameChildren,
	previousFrameChildren,
	projectFormLinks,
	selectedCaseDatumId,
} from "@/lib/commcare/formLinkProjection";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	matchAll,
	prop,
	tableLookup,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision } from "@/lib/lookup/types";

const REGIONS = "018f3e8a-7b2c-7def-8abc-0000000000a1" as LookupTableId;
const REGION_NAME = "018f3e8a-7b2c-7def-8abc-0000000000b1" as LookupColumnId;
const lookupNaming = lookupWireNaming([
	{
		id: REGIONS,
		name: "Regions",
		tag: "regions",
		definitionRevision: "1" as LookupRevision,
		columns: [
			{
				id: REGION_NAME,
				wireName: "name",
				label: "Name",
				dataType: "text",
			},
		],
	},
]);
const lookupFixtures = buildLookupFixtures(
	lookupNaming,
	new Map([[REGIONS, []]]),
);

function directChildren(element: Element, name: string): Element[] {
	return getChildren(element).filter(
		(child): child is Element => isTag(child) && child.name === name,
	);
}

function entryByCommand(suite: string, commandId: string): Element {
	const entry = findAll(
		(element) =>
			element.name === "entry" &&
			directChildren(element, "command").some(
				(command) => getAttributeValue(command, "id") === commandId,
			),
		parseDocument(suite, { xmlMode: true }).children,
	)[0];
	if (entry === undefined) throw new Error(`missing entry ${commandId}`);
	return entry;
}

/** Copied from CommCare HQ at 6a1c4ba8a93e0c4446e7cfa1a27e6aee63c9563e:
 * `tests/data/suite/child-module-entry-datums-added-basic.xml` and
 * `child-module-form-workflow-previous.xml`. These are semantic DOM values;
 * serializer-only quote escaping is asserted separately through compiled XML. */
const HQ_CHILD_ENTRY_DATUM_ORACLE = [
	{
		id: "case_id",
		caseType: "gold-fish",
		nodeset:
			"instance('casedb')/casedb/case[@case_type='gold-fish'][@status='open']",
		function: undefined,
		detailSelect: "m0_case_short",
		detailConfirm: undefined,
	},
	{
		id: "case_id_new_guppy_0",
		caseType: "guppy",
		nodeset: undefined,
		function: "uuid()",
		detailSelect: undefined,
		detailConfirm: undefined,
	},
	{
		id: "case_id_guppy",
		caseType: "guppy",
		nodeset:
			"instance('casedb')/casedb/case[@case_type='guppy'][@status='open'][index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/case_id]",
		function: undefined,
		detailSelect: "m1_case_short",
		detailConfirm: "m1_case_long",
	},
] as const;

const HQ_CHILD_PREVIOUS_FRAME_ORACLE = [
	{ type: "command", id: "m0" },
	{ type: "command", id: "m1" },
	{
		type: "datum",
		id: "case_id",
		value: "instance('commcaresession')/session/data/case_id",
	},
	{ type: "datum", id: "case_id_new_guppy_0", value: "uuid()" },
	{ type: "command", id: "m1-f0" },
] as const;

function nestSecondModule(doc: BlueprintDoc): {
	root: Uuid;
	child: Uuid;
	childForm?: Uuid;
} {
	const [root, child] = doc.moduleOrder;
	if (root === undefined || child === undefined) {
		throw new Error("nested-menu fixture needs two modules");
	}
	doc.modules[child].parentModuleUuid = root;
	return { root, child, childForm: doc.formOrder[child]?.[0] };
}

function followupNestedDoc(
	options: {
		readonly sameCaseType?: boolean;
		readonly parentSelect?: boolean;
		readonly caseListOnly?: boolean;
		readonly parentFirstSurvey?: boolean;
		readonly parentCreatesChild?: boolean;
		readonly childPostSubmitPrevious?: boolean;
		readonly childFilter?: boolean;
	} = {},
): BlueprintDoc {
	const childType = options.sameCaseType ? "gold-fish" : "guppy";
	const doc = buildDoc({
		appName: "Nested care",
		caseTypes: [
			{
				name: "gold-fish",
				properties: [{ name: "status", label: proseText("Status") }],
			},
			...(options.sameCaseType
				? []
				: [
						{
							name: "guppy",
							...(options.parentSelect && { parent_type: "gold-fish" }),
							properties: [
								{ name: "status", label: proseText("Status") },
								{ name: "case_name", label: proseText("Name") },
							],
						},
					]),
		],
		modules: [
			{
				name: "Parents",
				caseType: "gold-fish",
				caseListConfig: caseListConfig([{ field: "status", header: "Status" }]),
				forms: [
					...(options.parentFirstSurvey
						? [{ name: "Parent survey", type: "survey" as const }]
						: []),
					{
						name: "Parent visit",
						type: "followup",
						fields: options.parentCreatesChild
							? [
									f({
										kind: "text",
										id: "child_name",
										label: proseText("Child name"),
										caseWrite: {
											caseType: childType,
											property: "case_name",
										},
									}),
								]
							: [],
					},
				],
			},
			{
				name: "Child care",
				caseType: childType,
				caseListOnly: options.caseListOnly,
				caseListConfig: {
					...caseListConfig([{ field: "status", header: "Status" }]),
					...(options.childFilter !== false && {
						filter: eq(prop(childType, "status"), literal("active")),
					}),
				},
				forms: options.caseListOnly
					? []
					: [
							{
								name: "Child visit",
								type: "followup",
								...(options.childPostSubmitPrevious && {
									postSubmit: "previous" as const,
								}),
								displayCondition: eq(
									prop(childType, "status"),
									literal("active"),
								),
								fields: [
									f({
										kind: "hidden",
										id: "copied_status",
										calculate: `#${childType}/status`,
									}),
								],
							},
						],
			},
		],
	});
	nestSecondModule(doc);
	return doc;
}

function registrationNestedDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Nested registration",
		caseTypes: [
			{ name: "plan", properties: [] },
			{
				name: "service",
				parent_type: "plan",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Plans",
				caseType: "plan",
				forms: [{ name: "Plan visit", type: "followup" }],
			},
			{
				name: "Services",
				caseType: "service",
				forms: [
					{
						name: "Create service",
						type: "registration",
						postSubmit: "previous",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "service",
									property: "case_name",
								},
							}),
						],
					},
				],
			},
		],
	});
	nestSecondModule(doc);
	return doc;
}

function sameTypeFormlessRootDoc(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Shared case menu",
		caseTypes: [
			{
				name: "gold-fish",
				properties: [{ name: "status", label: proseText("Status") }],
			},
		],
		modules: [
			{
				name: "All fish",
				caseType: "gold-fish",
				caseListOnly: true,
				caseListConfig: caseListConfig([{ field: "status", header: "Status" }]),
				forms: [],
			},
			{
				name: "Fish care",
				caseType: "gold-fish",
				caseListConfig: caseListConfig([{ field: "status", header: "Status" }]),
				forms: [
					{
						name: "Fish visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "copied_status",
								calculate: "#gold-fish/status",
							}),
						],
					},
				],
			},
		],
	});
	nestSecondModule(doc);
	return doc;
}

describe("ordinary nested-menu wire projection", () => {
	it("emits root identity while preserving the child's own filter", () => {
		const doc = followupNestedDoc();
		const { root, child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const hq = expandDoc(doc);
		expect(hq.modules[1].root_module_id).toBe(hq.modules[0].unique_id);
		expect(hq.modules[1].put_in_root).toBe(false);
		expect(hq.modules[1].module_filter).toBeNull();

		const ctx = formLinkProjectionContext(doc);
		const datums = entrySessionDatums(doc, ctx, child, childForm);
		expect(datums.map((datum) => datum.id)).toEqual(["case_id_guppy"]);
		expect(datums[0]?.nodeset).toContain("[@status = 'active']");
		expect(selectedCaseDatumId(doc, ctx, child, childForm)).toBe(
			"case_id_guppy",
		);

		const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		const suite = zip.readAsText("suite.xml");
		expect(suite).toContain('<menu root="m0" id="m1">');
		expect(suite).toContain('id="case_id_guppy"');
		expect(suite).toContain(
			"session/data/case_id_guppy]/@status = &apos;active&apos;",
		);
		const xform = zip.readAsText("modules-1/forms-0.xml");
		expect(xform).toContain("session/data/case_id_guppy");
		expect(doc.modules[child].parentModuleUuid).toBe(root);
	});

	it("reuses case_id when root and child select the same case type", () => {
		const doc = followupNestedDoc({ sameCaseType: true });
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const ctx = formLinkProjectionContext(doc);
		expect(
			entrySessionDatums(doc, ctx, child, childForm).map((datum) => datum.id),
		).toEqual(["case_id"]);
		expect(selectedCaseDatumId(doc, ctx, child, childForm)).toBe("case_id");
	});

	it("emits a same-type child under a form-less case-list-only root", () => {
		const doc = sameTypeFormlessRootDoc();
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const ctx = formLinkProjectionContext(doc);
		expect(
			entrySessionDatums(doc, ctx, child, childForm).map((datum) => datum.id),
		).toEqual(["case_id"]);

		const hq = expandDoc(doc);
		expect(hq.modules[1].root_module_id).toBe(hq.modules[0].unique_id);
		const suite = new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
			"suite.xml",
		);
		expect(suite).toContain('<menu root="m0" id="m1">');
		const entry = entryByCommand(suite, "m1-f0");
		expect(
			findAll((element) => element.name === "datum", entry.children).map(
				(datum) => getAttributeValue(datum, "id"),
			),
		).toContain("case_id");
	});

	it("aligns against the root's first form, not a later mixed-type form", () => {
		const doc = followupNestedDoc({ parentFirstSurvey: true });
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const ctx = formLinkProjectionContext(doc);
		expect(
			entrySessionDatums(doc, ctx, child, childForm).map((datum) => datum.id),
		).toEqual(["case_id"]);
	});

	it("aligns the parent-select chain and refreshes the child relation filter", () => {
		const doc = followupNestedDoc({ parentSelect: true });
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const ctx = formLinkProjectionContext(doc);
		const datums = entrySessionDatums(doc, ctx, child, childForm);
		expect(datums.map((datum) => [datum.id, datum.caseType])).toEqual([
			["case_id", "gold-fish"],
			["case_id_guppy", "guppy"],
		]);
		expect(datums[1]?.nodeset).toContain(
			"[index/*[not(@relationship='extension')]=instance('commcaresession')/session/data/case_id]",
		);
		const hq = expandDoc(doc);
		expect(hq.modules[1].parent_select).toEqual({
			active: true,
			relationship: "parent",
			module_id: hq.modules[0].unique_id,
		});
	});

	it("carries ancestor lookup dependencies into the child CCZ entry", () => {
		const doc = followupNestedDoc({ parentSelect: true });
		const { root, child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const parentConfig = doc.modules[root].caseListConfig;
		if (parentConfig === undefined) throw new Error("missing parent case list");
		parentConfig.filter = eq(
			tableLookup(REGIONS, REGION_NAME, matchAll()),
			literal("North"),
		);

		const ctx = formLinkProjectionContext(doc, { lookupNaming });
		const parentDatum = entrySessionDatums(doc, ctx, child, childForm).find(
			(datum) => datum.caseType === "gold-fish",
		);
		expect(parentDatum?.instanceIds).toContain("item-list:regions");

		const hq = expandDoc(doc, { lookupNaming });
		const suite = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				lookup: { naming: lookupNaming, fixtures: lookupFixtures },
			}),
		).readAsText("suite.xml");
		const entry = entryByCommand(suite, "m1-f0");
		expect(
			directChildren(entry, "instance").some(
				(instance) =>
					getAttributeValue(instance, "id") === "item-list:regions" &&
					getAttributeValue(instance, "src") ===
						"jr://fixture/item-list:regions",
			),
		).toBe(true);
	});

	it("projects root-aware datums for a case-list-only child", () => {
		const doc = followupNestedDoc({ parentSelect: true, caseListOnly: true });
		const hq = expandDoc(doc);
		const suite = new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
			"suite.xml",
		);
		expect(suite).toContain('<menu root="m0" id="m1">');
		expect(suite).toContain('id="m1-case-list"');
		expect(suite).toContain('id="case_id_guppy"');
		expect(suite).toContain('detail-confirm="m1_case_long"');
	});

	it("omits detail-confirm for a nested case list with no Details fields", () => {
		const doc = followupNestedDoc({ parentSelect: true, caseListOnly: true });
		const child = doc.moduleOrder[1];
		const config = doc.modules[child].caseListConfig;
		if (config === undefined) throw new Error("missing child case list");
		for (const column of config.columns) column.visibleInDetail = false;
		const hq = expandDoc(doc);
		const suite = new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
			"suite.xml",
		);
		const entry = entryByCommand(suite, "m1-case-list");
		const datums = findAll(
			(element) => element.name === "datum",
			entry.children,
		);
		expect(
			datums.some((datum) => getAttributeValue(datum, "detail-confirm")),
		).toBe(false);
	});
});

describe("nested-menu navigation frames", () => {
	it("matches the pinned HQ child-entry and previous-frame fixture values", () => {
		const doc = followupNestedDoc({
			parentSelect: true,
			parentCreatesChild: true,
			childPostSubmitPrevious: true,
			childFilter: false,
		});
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const ctx = formLinkProjectionContext(doc);
		const datums = entrySessionDatums(doc, ctx, child, childForm).map(
			(datum) => ({
				id: datum.id,
				caseType: datum.caseType,
				nodeset: datum.nodeset,
				function: datum.function,
				detailSelect: datum.detailSelect,
				detailConfirm: datum.detailConfirm,
			}),
		);
		expect(datums).toEqual(HQ_CHILD_ENTRY_DATUM_ORACLE);
		expect(previousFrameChildren(doc, ctx, child, childForm)).toEqual(
			HQ_CHILD_PREVIOUS_FRAME_ORACLE,
		);

		const hq = expandDoc(doc);
		const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		expect(zip.readAsText("suite.xml")).toContain('<menu root="m0" id="m1">');
		// Exact selected-case anchor copied from HQ's
		// `data/suite/basic_submodule_xform.xml` and
		// `form_preparation_v2_advanced/child_module_adjusted_case_id_basic.xml`.
		expect(zip.readAsText("modules-1/forms-0.xml")).toContain(
			"session/data/case_id_guppy",
		);
	});

	it("matches HQ's root-aware previous, module, and form-target shapes", () => {
		const doc = registrationNestedDoc();
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const ctx = formLinkProjectionContext(doc);
		expect(previousFrameChildren(doc, ctx, child, childForm)).toEqual([
			{ type: "command", id: "m0" },
			{ type: "command", id: "m1" },
			{
				type: "datum",
				id: "case_id",
				value: "instance('commcaresession')/session/data/case_id",
			},
		]);
		expect(moduleDestinationFrameChildren(doc, ctx, child)).toEqual([
			{ type: "command", id: "m0" },
			{
				type: "datum",
				id: "case_id",
				value: "instance('commcaresession')/session/data/case_id",
			},
			{ type: "command", id: "m1" },
		]);
		expect(
			formFrameChildren(doc, ctx, child, childForm).map((child) =>
				child.type === "command"
					? child.id
					: `${child.datum.id}:${child.datum.caseType ?? ""}`,
			),
		).toEqual([
			"m0",
			"case_id:plan",
			"m1",
			"case_id_new_service_0:service",
			"m1-f0",
		]);
	});

	it("projects a form link through the root frame and matches its parent datum", () => {
		const doc = registrationNestedDoc();
		const { root, child, childForm } = nestSecondModule(doc);
		const sourceForm = doc.formOrder[root]?.[0];
		if (sourceForm === undefined || childForm === undefined) {
			throw new Error("missing nested form-link fixture forms");
		}
		doc.forms[sourceForm].formLinks = [
			{
				uuid: testUuid("nested-form-link"),
				target: { type: "form", moduleUuid: child, formUuid: childForm },
			},
		];
		const projected = projectFormLinks(
			doc,
			formLinkProjectionContext(doc),
			sourceForm,
		);
		expect(projected?.links[0]?.children).toEqual([
			{ type: "command", id: "m0" },
			{
				type: "datum",
				id: "case_id",
				value: "instance('commcaresession')/session/data/case_id",
			},
			{ type: "command", id: "m1" },
			{
				type: "datum",
				id: "case_id_new_service_0",
				value: "uuid()",
			},
			{ type: "command", id: "m1-f0" },
		]);
	});
});
