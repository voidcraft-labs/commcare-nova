import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { buildXForm } from "@/lib/commcare/xform";
import { lookupAppFixture } from "./lookupAppFixtures";

const XMLNS = "http://openrosa.org/formdesigner/lookup-proof";
function emitted() {
	const fixture = lookupAppFixture();
	const formUuid = fixture.doc.formOrder[fixture.doc.moduleOrder[0]][0];
	const xml = buildXForm(fixture.doc, formUuid, {
		xmlns: XMLNS,
		lookupNaming: fixture.naming,
	});
	new SaxesParser({ xmlns: true }).write(xml).close();
	return { ...fixture, formUuid, xml };
}
function named(xml: string, name: string) {
	return findAll(
		(element) => element.name === name,
		parseDocument(xml, { xmlMode: true }).children,
	);
}
function children(element: Element, name: string) {
	return element.children
		.filter(isTag)
		.filter((element) => element.name === name);
}

// LookupRuntimeTest executes current emitted itemsets through Core's real form
// prompts after SuiteParser installation, with changing root/repeat/session data.
describe("lookup XForm structure", () => {
	it("joins each admitted choice source to its instance, filter, label and value", () => {
		const { xml } = emitted();
		const instances = named(xml, "instance").filter(
			(element) => element.attribs.id === "regions",
		);
		expect(instances).toHaveLength(1);
		expect(instances[0].attribs).toEqual({
			id: "regions",
			src: "jr://fixture/item-list:regions",
		});
		const expected = new Map([
			["/data/all_regions", "instance('regions')/regions_list/regions"],
			[
				"/data/filtered",
				"instance('regions')/regions_list/regions[province = /data/province]",
			],
			[
				"/data/session_filtered",
				"instance('regions')/regions_list/regions[value = instance('commcaresession')/session/context/username]",
			],
			["/data/many", "instance('regions')/regions_list/regions"],
			[
				"/data/visits/repeat_filtered",
				"instance('regions')/regions_list/regions[province = current()/../zone]",
			],
		]);
		const controls = [...named(xml, "select1"), ...named(xml, "select")];
		expect(controls).toHaveLength(expected.size);
		for (const control of controls) {
			expect(control.name).toBe(
				control.attribs.ref === "/data/many" ? "select" : "select1",
			);
			expect(children(control, "item")).toEqual([]);
			const itemsets = children(control, "itemset");
			expect(itemsets).toHaveLength(1);
			expect(itemsets[0].attribs.nodeset).toBe(
				expected.get(control.attribs.ref),
			);
			expect(
				children(itemsets[0], "label").map((node) => node.attribs),
			).toEqual([{ ref: "label" }]);
			expect(
				children(itemsets[0], "value").map((node) => node.attribs),
			).toEqual([{ ref: "value" }]);
		}
		expect(
			named(xml, "text").filter((node) =>
				(node.attribs.id ?? "").includes("-opt"),
			),
		).toEqual([]);
		expect(validateXForm(xml, "Visit", "Patients")).toEqual([]);
	});
	it("refuses a caller that omits the admitted app's lookup naming", () => {
		const { doc, formUuid } = emitted();
		expect(() => buildXForm(doc, formUuid, { xmlns: XMLNS })).toThrow(
			/no lookup wire naming/i,
		);
	});
	it("refuses an unknown secondary instance if a caller bypasses admission", () => {
		const { doc, formUuid, naming } = emitted();
		const field = Object.values(doc.fields).find(
			(field) => field.id === "province",
		);
		if (field?.kind !== "text") throw new Error("Missing province field");
		field.default_value = xp("instance('missing')/items/item[1]/value");
		expect(() =>
			buildXForm(doc, formUuid, { xmlns: XMLNS, lookupNaming: naming }),
		).toThrow(
			"XForm XPath references an undeclared secondary instance. Validation must reject it before emission.",
		);
	});
});

describe("Nova's lookup select shape guard", () => {
	it("rejects mixing static and dynamic choices in one select", () => {
		const { xml } = emitted();
		const broken = xml.replace(
			"</select1>",
			"<item><label>Manual</label><value>manual</value></item></select1>",
		);
		expect(broken).not.toBe(xml);
		expect(
			validateXForm(broken, "Visit", "Patients").map((error) => error.code),
		).toContain("XFORM_SELECT_ITEMS_AND_ITEMSET");
	});
	it("rejects an itemset without a value binding", () => {
		const { xml } = emitted();
		const broken = xml.replace('<value ref="value"/>', "");
		expect(broken).not.toBe(xml);
		expect(
			validateXForm(broken, "Visit", "Patients").map((error) => error.code),
		).toContain("XFORM_ITEMSET_INVALID");
	});
});
