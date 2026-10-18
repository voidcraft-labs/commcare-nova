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
	entryFrameDatums,
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
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { eq, literal, matchAll, tableLookup } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { wireTable } from "../lookup/__tests__/lookupWireCorpus";
import { serializeXml } from "../serializeXml";
import { buildStackElement, derivePostSubmitStack } from "../session";
import { runValidation } from "../validator/runner";
import { w } from "../xpath/wire/builders";
import {
	admitNestedDoc,
	followupNestedDoc,
	nestSecondModule,
	registrationNestedDoc,
	sameTypeFormlessRootDoc,
	setSharedFormAnswers,
} from "./nestedMenuWireFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

const regions = wireTable("regions", [{ name: "name", type: "text" }]);
const REGIONS = regions.id,
	REGION_NAME = regions.columns[0].id;
const lookupNaming = lookupWireNaming([regions]);
const lookupContext = {
	kind: "available" as const,
	projectId: "nested-wire",
	projectRevision: regions.definitionRevision,
	definitions: [regions],
};
const lookupFixtures = buildLookupFixtures(
	lookupNaming,
	new Map([[REGIONS, []]]),
);

function directChildren(element: Element, name: string): Element[] {
	return getChildren(element).filter(
		(child): child is Element => isTag(child) && child.name === name,
	);
}

function wireElement(
	xml: string,
	name: string,
	attribute: string,
	value: string,
): Element {
	const elements = findAll(
		(element) => element.name === name && element.attribs[attribute] === value,
		parseDocument(xml, { xmlMode: true }).children,
	);
	expect(elements).toHaveLength(1);
	return elements[0];
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
 * expression whitespace follows Nova's canonical print; XML parsing verifies
 * the emitted attribute values. */
const HQ_CHILD_ENTRY_DATUM_ORACLE = [
	{
		id: "case_id",
		nodeset:
			"instance('casedb')/casedb/case[@case_type = 'gold-fish'][@status = 'open']",
		function: undefined,
		detailSelect: "m0_case_short",
		detailConfirm: undefined,
	},
	{
		id: "case_id_new_guppy_0",
		nodeset: undefined,
		function: "uuid()",
		detailSelect: undefined,
		detailConfirm: undefined,
	},
	{
		id: "case_id_guppy",
		nodeset:
			"instance('casedb')/casedb/case[@case_type = 'guppy'][@status = 'open'][index/*[not(@relationship = 'extension')] = instance('commcaresession')/session/data/case_id]",
		function: undefined,
		detailSelect: "m1_case_short",
		detailConfirm: "m1_case_long",
	},
] as const;

const HQ_CHILD_PREVIOUS_FRAME_ORACLE = [
	{ type: "command", value: "'m0'" },
	{ type: "command", value: "'m1'" },
	{
		type: "datum",
		id: "case_id",
		value: "instance('commcaresession')/session/data/case_id",
	},
	{ type: "datum", id: "case_id_new_guppy_0", value: "uuid()" },
	{ type: "command", value: "'m1-f0'" },
] as const;

function rootRegistrationPlaceholderDoc(): {
	readonly doc: BlueprintDoc;
	readonly root: Uuid;
	readonly child: Uuid;
	readonly sourceForm: Uuid;
} {
	const root = testUuid("mod-placeholder-root");
	const child = testUuid("mod-placeholder-child");
	const rootFollowup = testUuid("frm-placeholder-target");
	const sourceForm = testUuid("frm-placeholder-source");
	const doc = buildDoc({
		appName: "Placeholder matching",
		caseTypes: [
			{
				name: "frog",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "visit",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: "mod-placeholder-root",
				name: "Frogs",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register frog",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "frog_name",
								label: proseText("Name"),
								caseWrite: { caseType: "frog", property: "case_name" },
							}),
						],
					},
					{
						uuid: "frm-placeholder-target",
						name: "Frog visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "frog_copy",
								calculate: "#frog/case_name",
							}),
						],
					},
				],
			},
			{
				uuid: "mod-placeholder-child",
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-placeholder-source",
						name: "Visit update",
						type: "followup",

						fields: [
							f({
								kind: "hidden",
								id: "visit_copy",
								calculate: "#visit/case_name",
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[child].parentModuleUuid = root;
	admitNestedDoc(doc);
	doc.forms[sourceForm].formLinks = [
		{
			uuid: testUuid("lnk-placeholder-target"),
			target: {
				type: "form",
				moduleUuid: root,
				formUuid: rootFollowup,
			},
		},
	];
	return { doc, root, child, sourceForm };
}

describe("ordinary nested-menu wire projection", () => {
	it("emits root identity while preserving the child's own filter", () => {
		const doc = followupNestedDoc();
		const { root, child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		admitNestedDoc(doc);
		const hq = expandDoc(doc);
		expect(hq.modules[1].root_module_id).toBe(hq.modules[0].unique_id);
		expect(hq.modules[1].put_in_root).toBe(false);
		expect(hq.modules[1].module_filter).toBeNull();

		admitNestedDoc(doc);
		const ctx = formLinkProjectionContext(doc);
		const datums = entrySessionDatums(doc, ctx, child, childForm);
		expect(datums.map((datum) => datum.id)).toEqual(["case_id_guppy"]);
		expect(selectedCaseDatumId(doc, ctx, child, childForm)).toBe(
			"case_id_guppy",
		);

		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const suite = zip.readAsText("suite.xml");
		const menu = wireElement(suite, "menu", "id", "m1");
		expect(menu.attribs.root).toBe("m0");
		expect(directChildren(menu, "command")[0].attribs.relevant).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id_guppy]/care_status = 'active'",
		);
		const emittedDatums = directChildren(
			entryByCommand(suite, "m1-f0"),
			"session",
		)[0].children.filter(isTag);
		expect(emittedDatums.map((datum) => datum.attribs.id)).toEqual([
			"case_id_guppy",
		]);
		expect(emittedDatums[0].attribs.nodeset).toContain(
			"[care_status = 'active']",
		);
		const xform = zip.readAsText("modules-1/forms-0.xml");
		expect(
			wireElement(xform, "bind", "nodeset", "/data/copied_status").attribs
				.calculate,
		).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id_guppy]/care_status",
		);
		expect(doc.modules[child].parentModuleUuid).toBe(root);
	});

	it("reuses case_id when root and child select the same case type", () => {
		const doc = followupNestedDoc({ sameCaseType: true });
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		admitNestedDoc(doc);
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
		admitNestedDoc(doc);
		const ctx = formLinkProjectionContext(doc);
		expect(
			entrySessionDatums(doc, ctx, child, childForm).map((datum) => datum.id),
		).toEqual(["case_id"]);

		admitNestedDoc(doc);
		const hq = expandDoc(doc);
		expect(hq.modules[1].root_module_id).toBe(hq.modules[0].unique_id);
		const suite = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		).readAsText("suite.xml");
		expect(suite).toContain('<menu root="m0" id="m1">');
		const entry = entryByCommand(suite, "m1-f0");
		expect(
			findAll((element) => element.name === "datum", entry.children).map(
				(datum) => getAttributeValue(datum, "id"),
			),
		).toContain("case_id");
	});

	it("carries a form-less root's complete set into a compatible same-type child", () => {
		const doc = sameTypeFormlessRootDoc();
		const { root, child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const rootConfig = doc.modules[root].caseListConfig;
		const childConfig = doc.modules[child].caseListConfig;
		if (rootConfig === undefined || childConfig === undefined) {
			throw new Error("missing case list config");
		}
		rootConfig.selection = { kind: "multiple", maximum: 5 };
		childConfig.selection = { kind: "multiple", maximum: 8 };
		setSharedFormAnswers(doc, child);

		admitNestedDoc(doc);
		const ctx = formLinkProjectionContext(doc);
		const datums = entrySessionDatums(doc, ctx, child, childForm);
		expect(datums.map((datum) => datum.id)).toEqual(["selected_cases"]);
		expect(datums[0]?.maxSelectValue).toBe(8);

		admitNestedDoc(doc);
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).readAsText("suite.xml");
		const rootEntry = entryByCommand(suite, "m0-case-list");
		const childEntry = entryByCommand(suite, "m1-f0");
		for (const entry of [rootEntry, childEntry]) {
			expect(
				findAll(
					(element) => element.name === "instance-datum",
					entry.children,
				).some((datum) => getAttributeValue(datum, "id") === "selected_cases"),
			).toBe(true);
		}
	});

	it("does not reinterpret a larger authored parent set as a smaller child set", () => {
		let doc = followupNestedDoc({ sameCaseType: true });
		const { root, child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const rootConfig = doc.modules[root].caseListConfig;
		const childConfig = doc.modules[child].caseListConfig;
		if (rootConfig === undefined || childConfig === undefined) {
			throw new Error("missing case list config");
		}
		rootConfig.selection = { kind: "multiple", maximum: 5 };
		childConfig.selection = { kind: "multiple", maximum: 4 };
		setSharedFormAnswers(doc, child);

		doc = admitNestedDoc(doc);
		const datums = entrySessionDatums(
			doc,
			formLinkProjectionContext(doc),
			child,
			childForm,
		);
		expect(datums.map((datum) => datum.id)).toEqual([
			"selected_cases_gold-fish",
		]);
	});

	it("aligns against the root's first form, not a later mixed-type form", () => {
		const doc = followupNestedDoc({ parentFirstSurvey: true });
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		admitNestedDoc(doc);
		const ctx = formLinkProjectionContext(doc);
		expect(
			entrySessionDatums(doc, ctx, child, childForm).map((datum) => datum.id),
		).toEqual(["case_id"]);
	});

	it("aligns the parent-select chain and refreshes the child relation filter", () => {
		const doc = followupNestedDoc({ parentSelect: true });
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		admitNestedDoc(doc);
		const ctx = formLinkProjectionContext(doc);
		const datums = entrySessionDatums(doc, ctx, child, childForm);
		expect(datums.map((datum) => [datum.id, datum.caseType])).toEqual([
			["case_id", "gold-fish"],
			["case_id_guppy", "guppy"],
		]);
		admitNestedDoc(doc);
		const hq = expandDoc(doc);
		expect(hq.modules[1].parent_select).toEqual({
			active: true,
			relationship: "parent",
			module_id: hq.modules[0].unique_id,
		});
		const suite = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		).readAsText("suite.xml");
		const emitted = directChildren(
			directChildren(entryByCommand(suite, "m1-f0"), "session")[0],
			"datum",
		);
		expect(emitted[1].attribs.nodeset).toContain(
			"[index/*[not(@relationship = 'extension')] = instance('commcaresession')/session/data/case_id]",
		);
	});

	it("filters a different-type child through the root's complete selected set", () => {
		const doc = followupNestedDoc({ parentSelect: true });
		const { root, child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const rootConfig = doc.modules[root].caseListConfig;
		if (rootConfig === undefined) throw new Error("missing root case list");
		rootConfig.selection = { kind: "multiple", maximum: 5 };

		admitNestedDoc(doc);
		const datums = entrySessionDatums(
			doc,
			formLinkProjectionContext(doc),
			child,
			childForm,
		);
		expect(datums.map((datum) => [datum.id, datum.caseType])).toEqual([
			["selected_cases", "gold-fish"],
			["case_id", "guppy"],
		]);

		admitNestedDoc(doc);
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).readAsText("suite.xml");
		const childEntry = entryByCommand(suite, "m1-f0");
		const emittedSelectors = directChildren(
			childEntry,
			"session",
		)[0].children.filter(isTag);
		expect(emittedSelectors[1].attribs.nodeset).toContain(
			"[count(index/*[not(@relationship = 'extension')][selected(join(' ', instance('selected_cases')/results/value), .)]) > 0]",
		);
		expect(
			directChildren(childEntry, "instance").some(
				(instance) =>
					getAttributeValue(instance, "id") === "selected_cases" &&
					getAttributeValue(instance, "src") ===
						"jr://instance/selected-entities/selected_cases",
			),
		).toBe(true);
	});

	it("declares each selected-entities source where its values are read", () => {
		const doc = followupNestedDoc({ parentSelect: true });
		const { root, child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const rootConfig = doc.modules[root].caseListConfig;
		const childConfig = doc.modules[child].caseListConfig;
		if (rootConfig === undefined || childConfig === undefined) {
			throw new Error("missing case list config");
		}
		rootConfig.selection = { kind: "multiple", maximum: 5 };
		childConfig.selection = { kind: "multiple", maximum: 5 };
		setSharedFormAnswers(doc, child);
		const sharedAnswer = doc.fields[doc.fieldOrder[childForm][0]];
		if (sharedAnswer?.kind !== "hidden")
			throw new Error("Missing shared answer");
		sharedAnswer.caseWrite = { caseType: "guppy", property: "care_status" };

		admitNestedDoc(doc);
		const datums = entrySessionDatums(
			doc,
			formLinkProjectionContext(doc),
			child,
			childForm,
		);
		expect(datums.map((datum) => [datum.id, datum.caseType])).toEqual([
			["selected_cases", "gold-fish"],
			["selected_cases_guppy", "guppy"],
		]);

		admitNestedDoc(doc);
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const suite = zip.readAsText("suite.xml");
		const childEntry = entryByCommand(suite, "m1-f0");
		const emittedSelectors = directChildren(
			childEntry,
			"session",
		)[0].children.filter(isTag);
		expect(emittedSelectors[1].attribs.nodeset).toContain(
			"[count(index/*[not(@relationship = 'extension')][selected(join(' ', instance('selected_cases')/results/value), .)]) > 0]",
		);
		expect(
			directChildren(childEntry, "instance").map((instance) => ({
				id: getAttributeValue(instance, "id"),
				src: getAttributeValue(instance, "src"),
			})),
		).toEqual([
			{ id: "casedb", src: "jr://instance/casedb" },
			{
				id: "selected_cases",
				src: "jr://instance/selected-entities/selected_cases",
			},
		]);
		const xform = zip.readAsText("modules-1/forms-0.xml");
		expect(
			wireElement(xform, "instance", "id", "selected_cases_guppy").attribs.src,
		).toBe("jr://instance/selected-entities/selected_cases_guppy");
		expect(
			findAll(
				(element) => element.name === "setvalue",
				parseDocument(xform, { xmlMode: true }).children,
			).some((element) =>
				element.attribs.value?.includes(
					"instance('selected_cases_guppy')/results/value",
				),
			),
		).toBe(true);
	});

	it("carries ancestor lookup dependencies into the child CCZ entry", () => {
		const doc = followupNestedDoc({ parentSelect: true });
		const { root, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		const parentConfig = doc.modules[root].caseListConfig;
		if (parentConfig === undefined) throw new Error("missing parent case list");
		parentConfig.filter = eq(
			tableLookup(REGIONS, REGION_NAME, matchAll()),
			literal("North"),
		);

		admitNestedDoc(doc, lookupContext);

		const hq = expandDoc(doc, { lookupNaming });
		const suite = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
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
		admitNestedDoc(doc);
		const hq = expandDoc(doc);
		const suite = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		).readAsText("suite.xml");
		expect(wireElement(suite, "menu", "id", "m1").attribs.root).toBe("m0");
		const entry = entryByCommand(suite, "m1-case-list");
		const datums = directChildren(directChildren(entry, "session")[0], "datum");
		expect(datums.map((datum) => datum.attribs.id)).toEqual([
			"case_id",
			"case_id_guppy",
		]);
		expect(datums[1].attribs["detail-confirm"]).toBe("m1_case_long");
	});

	it("omits detail-confirm for a nested case list with no Details fields", () => {
		const doc = followupNestedDoc({ parentSelect: true, caseListOnly: true });
		const child = doc.moduleOrder[1];
		const config = doc.modules[child].caseListConfig;
		if (config === undefined) throw new Error("missing child case list");
		for (const column of config.columns) column.visibleInDetail = false;
		admitNestedDoc(doc);
		const hq = expandDoc(doc);
		const suite = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		).readAsText("suite.xml");
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
	it("does not auto-match a root registration placeholder from a child source", () => {
		const { doc, child, sourceForm } = rootRegistrationPlaceholderDoc();
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).toContain("FORM_LINK_DATUMS_INCOMPLETE");
		const ctx = formLinkProjectionContext(doc);
		const sourceDatums = entryFrameDatums(doc, ctx, child, sourceForm);
		expect(sourceDatums[0]).toMatchObject({
			id: "case_id_new_frog_0",
			caseType: "frog",
			function: w.call("uuid"),
			fromParentModule: true,
		});

		const projected = projectFormLinks(doc, ctx, sourceForm);
		expect(projected?.links[0]?.unmatched.map((datum) => datum.id)).toEqual([
			"case_id",
		]);
	});

	it("matches the pinned HQ child-entry and previous-frame fixture values", () => {
		const doc = followupNestedDoc({
			parentSelect: true,
			parentCreatesChild: true,
			childPostSubmitPrevious: true,
			childFilter: false,
		});
		const { childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		admitNestedDoc(doc);
		const hq = expandDoc(doc);
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const entry = entryByCommand(zip.readAsText("suite.xml"), "m1-f0");
		const emitted = directChildren(
			directChildren(entry, "session")[0],
			"datum",
		);
		expect(
			emitted.map((datum) => ({
				id: datum.attribs.id,
				nodeset: datum.attribs.nodeset,
				function: datum.attribs.function,
				detailSelect: datum.attribs["detail-select"],
				detailConfirm: datum.attribs["detail-confirm"],
			})),
		).toEqual(HQ_CHILD_ENTRY_DATUM_ORACLE);
		const operation = directChildren(
			directChildren(entry, "stack")[0],
			"create",
		)[0];
		expect(
			operation.children
				.filter(isTag)
				.map((child) => ({ type: child.name, ...child.attribs })),
		).toEqual(HQ_CHILD_PREVIOUS_FRAME_ORACLE);
		expect(
			wireElement(zip.readAsText("suite.xml"), "menu", "id", "m1").attribs.root,
		).toBe("m0");
		// Exact selected-case anchor copied from HQ's
		// `data/suite/basic_submodule_xform.xml` and
		// `form_preparation_v2_advanced/child_module_adjusted_case_id_basic.xml`.
		expect(
			wireElement(
				zip.readAsText("modules-1/forms-0.xml"),
				"bind",
				"nodeset",
				"/data/copied_status",
			).attribs.calculate,
		).toBe(
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id_guppy]/care_status",
		);
	});

	it("matches HQ's root-aware previous, module, and form-target shapes", () => {
		const doc = registrationNestedDoc();
		const { child, childForm } = nestSecondModule(doc);
		if (childForm === undefined) throw new Error("missing child form");
		admitNestedDoc(doc);
		const ctx = formLinkProjectionContext(doc);
		expect(previousFrameChildren(doc, ctx, child, childForm)).toEqual([
			{ type: "command", id: "m0" },
			{ type: "command", id: "m1" },
		]);
		const moduleStack = buildStackElement(
			derivePostSubmitStack(
				"module",
				1,
				[],
				moduleDestinationFrameChildren(doc, ctx, child),
			),
		);
		if (moduleStack === null)
			throw new Error("Missing module destination stack");
		expect(
			findAll(
				(element) => element.name === "create",
				parseDocument(serializeXml(moduleStack), { xmlMode: true }).children,
			)[0]
				.children.filter(isTag)
				.map((node) => [node.name, node.attribs]),
		).toEqual([
			["command", { value: "'m0'" }],
			[
				"datum",
				{
					id: "case_id",
					value: "instance('commcaresession')/session/data/case_id",
				},
			],
			["command", { value: "'m1'" }],
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
		admitNestedDoc(doc);
		const suite = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		).readAsText("suite.xml");
		const sourceEntry = entryByCommand(suite, "m0-f0");
		const operation = directChildren(
			directChildren(sourceEntry, "stack")[0],
			"create",
		)[0];
		expect(
			operation.children.filter(isTag).map((node) => [node.name, node.attribs]),
		).toEqual([
			["command", { value: "'m0'" }],
			[
				"datum",
				{
					id: "case_id",
					value: "instance('commcaresession')/session/data/case_id",
				},
			],
			["command", { value: "'m1'" }],
			["datum", { id: "case_id_new_service_0", value: "uuid()" }],
			["command", { value: "'m1-f0'" }],
		]);
	});
});
