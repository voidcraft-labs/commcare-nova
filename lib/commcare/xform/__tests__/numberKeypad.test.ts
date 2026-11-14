/**
 * The Phone Number question on the wire: a Text question holding
 * `keypad: "numbers"` is `<input appearance="numeric">` with the bind every
 * Text question has, `xsd:string`, the one shape HQ's form builder reads as
 * its Phone Number or Numeric ID question (Vellum
 * `src/parser.js::buildControlNodeAdaptorMap`: bind type `string`, the whole
 * appearance `numeric`).
 *
 * The emitted source passes the XForm oracle and is read back through
 * `parseXml`, so `numeric` written on another element (the bind, a sibling's
 * control), a bind typed as a number, or a second token beside `numeric`
 * fails here, beside a Text question without the keypad that carries none.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { expandDoc } from "../../expander";
import { validateXForm } from "../../validator/xformOracle";
import { parseXml } from "../../xmlParse";

function elements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (element: Element) => {
		out.push(element);
		for (const child of element.children.filter(isTag)) walk(child);
	};
	walk(root);
	return out;
}

function phoneSource(): { xml: string; all: Element[] } {
	const doc = buildDoc({
		modules: [
			{
				name: "Contacts",
				forms: [
					{
						uuid: testUuid("contact-form"),
						name: "Contact",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: testUuid("phone"),
								id: "phone",
								label: proseText("Phone number"),
								keypad: "numbers",
							}),
							f({
								kind: "text",
								uuid: testUuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	const sources = Object.values(expandDoc(doc)._attachments).filter(
		(value): value is string => typeof value === "string",
	);
	expect(sources).toHaveLength(1);
	const xml = sources[0];
	return {
		xml,
		all: parseXml(xml).children.filter(isTag).flatMap(elements),
	};
}

describe("a Text question with a number keypad", () => {
	it("passes the XForm oracle", () => {
		expect(validateXForm(phoneSource().xml, "Contact", "Contacts")).toEqual([]);
	});

	it("writes numeric on its own input alone, over a string bind", () => {
		const { all } = phoneSource();
		const carriers = all.filter(
			(element) => element.attribs.appearance !== undefined,
		);
		expect(
			carriers.map((element) => [
				element.name,
				element.attribs.ref,
				element.attribs.appearance,
			]),
		).toEqual([["input", "/data/phone", "numeric"]]);
		const note = all.find(
			(element) =>
				element.name === "input" && element.attribs.ref === "/data/note",
		);
		expect(note?.attribs.appearance).toBeUndefined();
		const bind = all.find(
			(element) =>
				element.name === "bind" && element.attribs.nodeset === "/data/phone",
		);
		expect(bind?.attribs.type).toBe("xsd:string");
	});
});
