import AdmZip from "adm-zip";
import { type Document, type Element, isTag } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { asUuid, calculatedColumn, plainColumn } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	matchAll,
	prop,
	tableColumn,
	tableLookup,
} from "@/lib/domain/predicate";
import type { LookupRevision, LookupRowId } from "@/lib/lookup/types";

const REGIONS = "018f3e8a-7b2c-7def-8abc-0000000000a1" as LookupTableId;
const VALUE = "018f3e8a-7b2c-7def-8abc-0000000000b1" as LookupColumnId;
const LABEL = "018f3e8a-7b2c-7def-8abc-0000000000b2" as LookupColumnId;
const NAME = "018f3e8a-7b2c-7def-8abc-0000000000b3" as LookupColumnId;

const naming = lookupWireNaming([
	{
		id: REGIONS,
		name: "Regions",
		tag: "regions",
		definitionRevision: "1" as LookupRevision,
		columns: [
			{ id: VALUE, wireName: "value", label: "Value", dataType: "text" },
			{ id: LABEL, wireName: "label", label: "Label", dataType: "text" },
			{ id: NAME, wireName: "name", label: "Name", dataType: "text" },
		],
	},
]);

const fixtures = buildLookupFixtures(
	naming,
	new Map([
		[
			REGIONS,
			[
				{
					id: "018f3e8a-7b2c-7def-8abc-0000000000d1" as LookupRowId,
					values: { [VALUE]: "north", [LABEL]: "North", [NAME]: "Northland" },
				},
				{
					id: "018f3e8a-7b2c-7def-8abc-0000000000d2" as LookupRowId,
					values: { [VALUE]: "south", [LABEL]: "South", [NAME]: "Southland" },
				},
			],
		],
	]),
);

/** A case-managed module whose module relevance, a calc case-list column, and
 *  a form select all carry lookup wire references. */
function lookupApp() {
	return buildDoc({
		appName: "Regions app",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "region", label: "Region" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				displayCondition: eq(
					tableLookup(REGIONS, NAME, matchAll()),
					literal("North"),
				),
				caseListConfig: {
					columns: [
						plainColumn(
							asUuid("018f3e8a-7b2c-7def-8abc-0000000000e1"),
							"case_name",
							"Name",
						),
						calculatedColumn(
							asUuid("018f3e8a-7b2c-7def-8abc-0000000000e2"),
							"Region",
							tableLookup(
								REGIONS,
								NAME,
								eq(tableColumn(REGIONS, VALUE), prop("patient", "region")),
							),
						),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "single_select",
								id: "region_select",
								label: "Region",
								options: [{ value: "manual", label: "Manual" }],
								optionsSource: {
									kind: "lookup-table",
									tableId: REGIONS,
									valueColumnId: VALUE,
									labelColumnId: LABEL,
								},
							}),
						],
					},
				],
			},
		],
	});
}

function compile() {
	const doc = lookupApp();
	const hqJson = expandDoc(doc, { lookupNaming: naming });
	const ccz = compileCcz(hqJson, doc.appName, doc, {
		lookup: { naming, fixtures },
	});
	return new AdmZip(ccz);
}

function directChildren(el: Element, name: string): Element[] {
	return getChildren(el).filter(
		(child): child is Element => isTag(child) && child.name === name,
	);
}

function parse(xml: string): Document {
	return parseDocument(xml, { xmlMode: true });
}

describe("compileCcz — lookup wire embedding", () => {
	it("embeds the fixture after the menus with the exact serialized body", () => {
		const suiteXml = compile().readAsText("suite.xml");
		expect(suiteXml).toContain(fixtures.fixtures[0].xml);

		const suite = findAll(
			(el) => el.name === "suite",
			parse(suiteXml).children,
		)[0];
		const topLevel = getChildren(suite).filter(isTag);
		const lastMenuIndex = topLevel.reduce(
			(last, el, index) => (el.name === "menu" ? index : last),
			-1,
		);
		const fixtureIndex = topLevel.findIndex((el) => el.name === "fixture");
		expect(lastMenuIndex).toBeGreaterThanOrEqual(0);
		expect(fixtureIndex).toBeGreaterThan(lastMenuIndex);
	});

	it("gives the module menu the lowered lookup relevance and its instance", () => {
		const suiteXml = compile().readAsText("suite.xml");
		const menu = findAll(
			(el) => el.name === "menu" && getAttributeValue(el, "id") === "m0",
			parse(suiteXml).children,
		)[0];
		expect(getAttributeValue(menu, "relevant")).toBe(
			"instance('item-list:regions')/regions_list/regions[1]/name = 'North'",
		);
		const menuFixtureInstances = directChildren(menu, "instance").filter(
			(instance) => getAttributeValue(instance, "id") === "item-list:regions",
		);
		expect(menuFixtureInstances).toHaveLength(1);
		expect(getAttributeValue(menuFixtureInstances[0], "src")).toBe(
			"jr://fixture/item-list:regions",
		);
	});

	it("declares the fixture instance on the case-loading entry", () => {
		const suiteXml = compile().readAsText("suite.xml");
		const entries = findAll(
			(el) => el.name === "entry",
			parse(suiteXml).children,
		);
		const declaringEntries = entries.filter((entry) =>
			directChildren(entry, "instance").some(
				(instance) => getAttributeValue(instance, "id") === "item-list:regions",
			),
		);
		expect(declaringEntries.length).toBeGreaterThan(0);
	});

	it("emits the select itemset and its instance in the form XML", () => {
		const formXml = compile().readAsText("modules-0/forms-0.xml");
		const root = parse(formXml);
		const itemsets = findAll((el) => el.name === "itemset", root.children);
		expect(itemsets).toHaveLength(1);
		expect(getAttributeValue(itemsets[0], "nodeset")).toBe(
			"instance('item-list:regions')/regions_list/regions",
		);
		const formFixtureInstances = findAll(
			(el) => el.name === "instance",
			root.children,
		).filter(
			(instance) => getAttributeValue(instance, "id") === "item-list:regions",
		);
		expect(formFixtureInstances).toHaveLength(1);
	});
});

describe("validateSuite — embedded lookup fixtures", () => {
	function codes(suiteXml: string): string[] {
		return validateSuite(suiteXml, new Set()).map((error) => error.code);
	}

	it("flags a declared fixture instance with no embedded fixture", () => {
		const suiteXml =
			'<suite version="1"><instance src="jr://fixture/item-list:x"/></suite>';
		expect(codes(suiteXml)).toContain("SUITE_FIXTURE_INVALID");
	});

	it("flags a fixture with more than one body element", () => {
		const suiteXml =
			'<suite version="1"><fixture id="item-list:x"><a/><b/></fixture></suite>';
		expect(codes(suiteXml)).toContain("SUITE_FIXTURE_INVALID");
	});

	it("flags duplicate fixture ids", () => {
		const suiteXml =
			'<suite version="1"><fixture id="item-list:x"><x_list/></fixture><fixture id="item-list:x"><x_list/></fixture></suite>';
		expect(codes(suiteXml)).toContain("SUITE_FIXTURE_INVALID");
	});

	it("flags a fixture carrying a user_id", () => {
		const suiteXml =
			'<suite version="1"><fixture id="item-list:x" user_id="u"><x_list/></fixture></suite>';
		expect(codes(suiteXml)).toContain("SUITE_FIXTURE_INVALID");
	});
});
