import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import {
	caseListEmissionFixture,
	caseListEmissionScenarios,
} from "@/lib/commcare/__tests__/caseListEmissionFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";

function children(parent: Element, name: string) {
	return parent.children.filter(
		(node): node is Element => isTag(node) && node.name === name,
	);
}
function descendant(parent: Element, name: string) {
	return findAll((node) => node.name === name, parent.children);
}
function only(nodes: Element[]) {
	expect(nodes).toHaveLength(1);
	return nodes[0];
}

describe("admitted case-list archives", () => {
	it.each(caseListEmissionScenarios)(
		"%s carries independently ordered surfaces and reachable entries",
		(scenario) => {
			const { doc, assets } = caseListEmissionFixture(scenario);
			assertAdmittedDoc(doc);
			const runtimeTarget = {
				server: "production",
				domain: "nova-search-evidence",
				appId: "search-evidence",
			} as const;
			const options = { assets, runtimeTarget };
			const hq = expandDoc(doc, options);
			const zip = new AdmZip(compileCcz(hq, doc.appName, doc, options));
			const suite = only(
				findAll(
					(node) => node.name === "suite",
					parseDocument(zip.readAsText("suite.xml"), { xmlMode: true })
						.children,
				),
			);
			const details = children(suite, "detail");
			const short = only(
				details.filter((d) => d.attribs.id === "m0_case_short"),
			);
			const fields = children(short, "field");
			expect(fields).toHaveLength(9);
			expect(
				fields.map((field) => only(children(field, "template")).attribs),
			).toEqual([
				{},
				{},
				{},
				{ form: "markdown" },
				{},
				{ form: "image" },
				{},
				{},
				{ width: "0" },
			]);
			expect(
				fields.flatMap((field) =>
					children(field, "sort").map((sort) => sort.attribs),
				),
			).toEqual([
				{ type: "string", order: "3", direction: "ascending" },
				{ type: "int", order: "1", direction: "descending" },
				{ type: "double", order: "2", direction: "ascending" },
			]);
			const long = details.filter((d) => d.attribs.id === "m0_case_long");
			if (scenario === "no-details")
				expect(children(only(long), "field")).toEqual([]);
			else {
				expect(children(only(long), "field")).toHaveLength(9);
				expect(descendant(only(long), "sort")).toEqual([]);
				expect(
					children(only(long), "field").map(
						(field) => only(children(field, "template")).attribs.form ?? "text",
					),
				).toEqual([
					"text",
					"text",
					"text",
					"image",
					"text",
					"markdown",
					"phone",
					"text",
					"text",
				]);
			}
			const browse = scenario === "browse" || scenario === "no-details";
			const command = browse ? "m0-case-list" : "m0-f0";
			const entry = only(
				children(suite, "entry").filter((e) =>
					children(e, "command").some((c) => c.attribs.id === command),
				),
			);
			expect(children(entry, "form")).toHaveLength(browse ? 0 : 1);
			const datum = only(
				descendant(entry, "datum").filter(
					(d) => d.attribs.id === "case_id" && d.attribs.nodeset !== undefined,
				),
			);
			expect(datum.attribs["detail-select"]).toBe("m0_case_short");
			expect(datum.attribs["detail-confirm"]).toBe(
				scenario === "no-details" ? undefined : "m0_case_long",
			);
			if (browse) {
				const menu = only(
					children(suite, "menu").filter((m) => m.attribs.id === "m0"),
				);
				expect(children(menu, "command").map((c) => c.attribs.id)).toEqual([
					command,
				]);
				expect(
					descendant(only(children(entry, "command")), "text").some(
						(t) => t.attribs.form === "image",
					),
				).toBe(true);
			}
			// Native CaseListRuntimeTest evaluates these exact artifacts through HQ/Core,
			// including format values, typed sorting, filtering and browse navigation.
		},
	);
	it("inline calculated sort binds to its remote supporting cases", () => {
		const { doc, assets } = caseListEmissionFixture("inline");
		assertAdmittedDoc(doc);
		const options = {
			assets,
			runtimeTarget: {
				server: "production",
				domain: "nova-search-evidence",
				appId: "search-evidence",
			} as const,
		};
		const zip = new AdmZip(
			compileCcz(expandDoc(doc, options), doc.appName, doc, options),
		);
		const detail = only(
			findAll(
				(node) => node.name === "detail" && node.attribs.id === "m0_case_short",
				parseDocument(zip.readAsText("suite.xml"), { xmlMode: true }).children,
			),
		);
		const sort = only(
			descendant(detail, "sort").filter((s) => s.attribs.order === "1"),
		);
		expect(descendant(sort, "xpath").map((x) => x.attribs.function)).toEqual([
			"$calculated_property",
			"instance('results:inline')/results/case[@case_id=current()/index/parent and @case_type='household']/rank",
		]);
	});
});
