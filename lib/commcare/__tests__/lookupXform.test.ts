import { type Element, isTag } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { buildXForm } from "@/lib/commcare/xform";
import { asUuid, type Uuid } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	eq,
	formField,
	sessionUser,
	tableColumn,
} from "@/lib/domain/predicate";
import type { LookupRevision } from "@/lib/lookup/types";

const REGIONS = "018f3e8a-7b2c-7def-8abc-0000000000a1" as LookupTableId;
const VALUE = "018f3e8a-7b2c-7def-8abc-0000000000b1" as LookupColumnId;
const LABEL = "018f3e8a-7b2c-7def-8abc-0000000000b2" as LookupColumnId;

const naming = lookupWireNaming([
	{
		id: REGIONS,
		name: "Regions",
		tag: "regions",
		definitionRevision: "1" as LookupRevision,
		columns: [
			{ id: VALUE, wireName: "value", label: "Value", dataType: "text" },
			{ id: LABEL, wireName: "label", label: "Label", dataType: "text" },
		],
	},
]);

const XMLNS = "http://openrosa.org/formdesigner/lookup";

function firstFormUuid(doc: ReturnType<typeof buildDoc>): Uuid {
	return Object.keys(doc.forms)[0] as Uuid;
}

/** Every element with a matching name anywhere in the parsed tree. XML mode
 *  keeps the XForm's custom elements (`select1`, `itemset`) in their authored
 *  nesting — HTML recovery would reparent them. */
function allNamed(xml: string, name: string): Element[] {
	const root = parseDocument(xml, { xmlMode: true });
	return findAll((el) => el.name === name, root.children);
}

function directChildren(el: Element, name: string): Element[] {
	return getChildren(el).filter(
		(child): child is Element => isTag(child) && child.name === name,
	);
}

/** A minimal survey form whose only field is a lookup-backed select. */
function selectForm(
	kind: "single_select" | "multi_select",
	optionsSource: Record<string, unknown>,
): { xml: string } {
	const doc = buildDoc({
		appName: "Lookup form",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind,
								id: "region",
								label: "Region",
								options: [
									{ value: "manual", label: "Manual" },
									{ value: "other", label: "Other" },
								],
								optionsSource,
							}),
						],
					},
				],
			},
		],
	});
	return {
		xml: buildXForm(doc, firstFormUuid(doc), {
			xmlns: XMLNS,
			lookupNaming: naming,
		}),
	};
}

describe("buildXForm — lookup-backed select itemset", () => {
	it("emits exactly one filterless itemset and no inline items", () => {
		const { xml } = selectForm("single_select", {
			kind: "lookup-table",
			tableId: REGIONS,
			valueColumnId: VALUE,
			labelColumnId: LABEL,
		});

		const selects = allNamed(xml, "select1");
		expect(selects).toHaveLength(1);
		const [select] = selects;
		expect(directChildren(select, "itemset")).toHaveLength(1);
		expect(directChildren(select, "item")).toHaveLength(0);

		const [itemset] = directChildren(select, "itemset");
		const nodeset = getAttributeValue(itemset, "nodeset");
		expect(nodeset).toBe("instance('item-list:regions')/regions_list/regions");
		expect(nodeset).not.toContain("[");
		expect(getAttributeValue(directChildren(itemset, "label")[0], "ref")).toBe(
			"label",
		);
		expect(getAttributeValue(directChildren(itemset, "value")[0], "ref")).toBe(
			"value",
		);
	});

	it("declares the fixture instance and drops the inline option itext", () => {
		const { xml } = selectForm("single_select", {
			kind: "lookup-table",
			tableId: REGIONS,
			valueColumnId: VALUE,
			labelColumnId: LABEL,
		});

		const fixtureInstances = allNamed(xml, "instance").filter(
			(instance) => getAttributeValue(instance, "id") === "item-list:regions",
		);
		expect(fixtureInstances).toHaveLength(1);
		expect(getAttributeValue(fixtureInstances[0], "src")).toBe(
			"jr://fixture/item-list:regions",
		);

		// The inline fallback options register no `-optN-label` itext.
		const optionItext = allNamed(xml, "text").filter((textEl) =>
			(getAttributeValue(textEl, "id") ?? "").includes("-opt"),
		);
		expect(optionItext).toHaveLength(0);
	});

	it("emits a <select> for a multi_select lookup source", () => {
		const { xml } = selectForm("multi_select", {
			kind: "lookup-table",
			tableId: REGIONS,
			valueColumnId: VALUE,
			labelColumnId: LABEL,
		});

		expect(allNamed(xml, "select1")).toHaveLength(0);
		const selects = allNamed(xml, "select");
		expect(selects).toHaveLength(1);
		expect(directChildren(selects[0], "itemset")).toHaveLength(1);
	});

	it("passes the XForm oracle", () => {
		const { xml } = selectForm("single_select", {
			kind: "lookup-table",
			tableId: REGIONS,
			valueColumnId: VALUE,
			labelColumnId: LABEL,
		});
		expect(validateXForm(xml, "Visit", "Survey")).toEqual([]);
	});
});

describe("buildXForm — lookup itemset filters", () => {
	it("prints a root form-field filter as an absolute /data path", () => {
		const province = asUuid("018f3e8a-7b2c-7def-8abc-0000000000c1");
		const doc = buildDoc({
			appName: "Filtered lookup",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "province",
									label: "Province",
									uuid: province,
								}),
								f({
									kind: "single_select",
									id: "region",
									label: "Region",
									options: [{ value: "manual", label: "Manual" }],
									optionsSource: {
										kind: "lookup-table",
										tableId: REGIONS,
										valueColumnId: VALUE,
										labelColumnId: LABEL,
										filter: eq(
											tableColumn(REGIONS, VALUE),
											formField(province),
										),
									},
								}),
							],
						},
					],
				},
			],
		});
		const xml = buildXForm(doc, firstFormUuid(doc), {
			xmlns: XMLNS,
			lookupNaming: naming,
		});
		const [itemset] = allNamed(xml, "itemset");
		expect(getAttributeValue(itemset, "nodeset")).toBe(
			"instance('item-list:regions')/regions_list/regions[value = /data/province]",
		);
	});

	it("prints a same-repeat form-field filter through current()/..", () => {
		const zone = asUuid("018f3e8a-7b2c-7def-8abc-0000000000c2");
		const doc = buildDoc({
			appName: "Repeated lookup",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "visits",
									label: "Visits",
									children: [
										f({ kind: "text", id: "zone", label: "Zone", uuid: zone }),
										f({
											kind: "single_select",
											id: "region",
											label: "Region",
											options: [{ value: "manual", label: "Manual" }],
											optionsSource: {
												kind: "lookup-table",
												tableId: REGIONS,
												valueColumnId: VALUE,
												labelColumnId: LABEL,
												filter: eq(
													tableColumn(REGIONS, VALUE),
													formField(zone),
												),
											},
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const xml = buildXForm(doc, firstFormUuid(doc), {
			xmlns: XMLNS,
			lookupNaming: naming,
		});
		const [itemset] = allNamed(xml, "itemset");
		expect(getAttributeValue(itemset, "nodeset")).toBe(
			"instance('item-list:regions')/regions_list/regions[value = current()/../zone]",
		);
	});

	it("declares commcaresession for a session-user filter term", () => {
		const { xml } = selectForm("single_select", {
			kind: "lookup-table",
			tableId: REGIONS,
			valueColumnId: VALUE,
			labelColumnId: LABEL,
			filter: eq(tableColumn(REGIONS, VALUE), sessionUser("region")),
		});
		const [itemset] = allNamed(xml, "itemset");
		expect(getAttributeValue(itemset, "nodeset")).toBe(
			"instance('item-list:regions')/regions_list/regions[value = instance('commcaresession')/session/user/data/region]",
		);
		const sessionInstances = allNamed(xml, "instance").filter(
			(instance) => getAttributeValue(instance, "id") === "commcaresession",
		);
		expect(sessionInstances).toHaveLength(1);
		expect(getAttributeValue(sessionInstances[0], "src")).toBe(
			"jr://instance/session",
		);
	});
});

describe("validateXForm — malformed select shapes", () => {
	const validXform = selectForm("single_select", {
		kind: "lookup-table",
		tableId: REGIONS,
		valueColumnId: VALUE,
		labelColumnId: LABEL,
	}).xml;

	function codes(xml: string): string[] {
		return validateXForm(xml, "Visit", "Survey").map((error) => error.code);
	}

	it("flags a select carrying both inline items and an itemset", () => {
		const withBoth = validXform.replace(
			"</select1>",
			`<item><label ref="jr:itext('region-label')"/><value>manual</value></item></select1>`,
		);
		expect(codes(withBoth)).toContain("XFORM_SELECT_ITEMS_AND_ITEMSET");
	});

	it("flags an itemset missing its value ref", () => {
		const withoutValue = validXform.replace('<value ref="value"/>', "");
		expect(withoutValue).not.toBe(validXform);
		expect(codes(withoutValue)).toContain("XFORM_ITEMSET_INVALID");
	});
});
