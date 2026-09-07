import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { validateSuite } from "@/lib/commcare/validator/suiteOracle";
import { lookupAppFixture } from "./lookupAppFixtures";

// Native LookupRuntimeTest owns installed global fixtures, replacement, menu
// relevance, selected-case column evaluation and both paths' live itemsets.
describe("lookup artifacts from an admitted app", () => {
	it.each([false, true])(
		"embeds the measured generation and declares each consumer (reversed=%s)",
		(reversed) => {
			const { doc, naming, fixtures } = lookupAppFixture(reversed);
			const hq = expandDoc(doc, { lookupNaming: naming });
			const zip = new AdmZip(
				compileCcz(hq, doc.appName, doc, { lookup: { naming, fixtures } }),
			);
			const xml = zip.readAsText("suite.xml");
			new SaxesParser({ xmlns: true }).write(xml).close();
			const tree = parseDocument(xml, { xmlMode: true });
			const suite = findAll((node) => node.name === "suite", tree.children);
			expect(suite).toHaveLength(1);
			const children = suite[0].children.filter(isTag);
			const embedded = children.filter((node) => node.name === "fixture");
			expect(embedded).toHaveLength(1);
			expect(embedded[0].attribs).toEqual({ id: "item-list:regions" });
			expect(xml).toContain(fixtures.fixtures[0].xml);
			expect(children.indexOf(embedded[0])).toBeGreaterThan(
				children.findLastIndex((node) => node.name === "menu"),
			);
			const menus = children.filter(
				(node) => node.name === "menu" && node.attribs.id === "m0",
			);
			expect(menus).toHaveLength(1);
			expect(menus[0].attribs.relevant).toBe(
				"instance('item-list:regions')/regions_list/regions[1]/label = 'Northland'",
			);
			for (const consumer of [
				menus[0],
				...children.filter((node) => node.name === "entry"),
			]) {
				const declarations = consumer.children
					.filter(isTag)
					.filter(
						(node) =>
							node.name === "instance" &&
							node.attribs.id === "item-list:regions",
					);
				expect(
					declarations,
					`${consumer.name} ${consumer.attribs.id}`,
				).toHaveLength(1);
				expect(declarations[0].attribs.src).toBe(
					"jr://fixture/item-list:regions",
				);
			}
		},
	);
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
