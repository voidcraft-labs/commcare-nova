/**
 * The supply point text as CommCare HQ's substring test finds it in a stored
 * source (`entries.py::EntriesHelper.entry_for_module`), read from the
 * decoded text a form-builder save can leave: a near miss, or the text split
 * across two nodes, is no match, since HQ's test would find neither.
 */
import { describe, expect, it } from "vitest";
import {
	formSourceHoldsSupplyPointText,
	SUPPLY_POINT_SESSION_TEXT,
} from "../supplyPointText";

const form = (body: string) =>
	`<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data><q/></data></instance>${body}</model></h:head><h:body/></h:html>`;

const escaped = SUPPLY_POINT_SESSION_TEXT.replaceAll("'", "&apos;");

describe("formSourceHoldsSupplyPointText", () => {
	it("finds the text in an attribute value", () => {
		expect(
			formSourceHoldsSupplyPointText(
				form(
					`<bind nodeset="/data/q" calculate="${SUPPLY_POINT_SESSION_TEXT}"/>`,
				),
			),
		).toBe(true);
	});

	it("finds the text in a text node", () => {
		expect(
			formSourceHoldsSupplyPointText(
				form(
					`<itext><translation lang="en"><text id="q-label"><value>${SUPPLY_POINT_SESSION_TEXT}</value></text></translation></itext>`,
				),
			),
		).toBe(true);
	});

	it("finds the text decoded from &apos; in an attribute and a text node", () => {
		expect(
			formSourceHoldsSupplyPointText(
				form(`<bind nodeset="/data/q" calculate="'${escaped}'"/>`),
			),
		).toBe(true);
		expect(
			formSourceHoldsSupplyPointText(
				form(
					`<itext><translation lang="en"><text id="q-label"><value>Read ${escaped} here</value></text></translation></itext>`,
				),
			),
		).toBe(true);
	});

	it("does not find a near miss", () => {
		expect(
			formSourceHoldsSupplyPointText(
				form(
					`<bind nodeset="/data/q" calculate="instance('commcaresession')/session/data/supply_point"/>`,
				),
			),
		).toBe(false);
		expect(
			formSourceHoldsSupplyPointText(
				form(
					`<bind nodeset="/data/q" calculate="instance('commcaresession')/session/user/data/supply_point_id"/>`,
				),
			),
		).toBe(false);
	});

	it("does not find the text split across two nodes", () => {
		expect(
			formSourceHoldsSupplyPointText(
				form(
					`<itext><translation lang="en"><text id="q-label"><value>instance('commcaresession')/session/<output value="/data/q"/>data/supply_point_id</value></text></translation></itext>`,
				),
			),
		).toBe(false);
		expect(
			formSourceHoldsSupplyPointText(
				form(
					`<bind nodeset="/data/q" calculate="instance('commcaresession')/session" relevant="data/supply_point_id"/>`,
				),
			),
		).toBe(false);
	});
});
