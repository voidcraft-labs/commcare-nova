// A lookup table's tag and a column's wire name may hold a hyphen. The
// plausible failures: an emitter that alters or refuses a hyphenated element,
// sheet or step, and a read written into a slot CommCare HQ's build rewrites
// as text (a case list filter, a form's display condition) that the build
// would rewrite. Each carrier is read back independently: the fixture with
// Nova's XML parser, the workbook from its archive, each read with the
// generated XPath parser, and each HQ JSON string with a port of HQ's own
// `xpath.py::dot_interpolate`.

import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { buildLookupWorkbook } from "@/lib/commcare/lookup/workbook";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseXml } from "@/lib/commcare/xmlParse";
import { NameTest, parser } from "@/lib/commcare/xpath";
import { proseText } from "@/lib/domain";
import {
	eq,
	literal,
	matchAll,
	prop,
	tableColumn,
	tableLookup,
} from "@/lib/domain/expression";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { wireRow, wireTable } from "./lookupWireCorpus";

const MODULE = testUuid("lookup-names-module");
const VISIT = testUuid("lookup-names-visit");
const FEEDBACK = testUuid("lookup-names-feedback");

function namesApp() {
	const table = wireTable("health-facility", [
		{ name: "facility-name", type: "text" },
		{ name: "district-code", type: "text" },
	]);
	const [facilityName, districtCode] = table.columns;
	const rows = [
		wireRow(table, "north", {
			"facility-name": "North clinic",
			"district-code": "n-1",
		}),
	];
	const naming = lookupWireNaming([table]);
	const read = (where: Parameters<typeof tableLookup>[2]) =>
		tableLookup(table.id, facilityName.id, where);
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "district", label: proseText("District") },
					{ name: "facility", label: proseText("Facility") },
				],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					filter: eq(
						prop("patient", "facility"),
						read(
							eq(
								tableColumn(table.id, districtCode.id),
								prop("patient", "district"),
							),
						),
					),
				},
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						displayCondition: eq(read(matchAll()), literal("North clinic")),
						fields: [
							f({
								kind: "hidden",
								id: "facility_label",
								calculate: read(matchAll()),
							}),
						],
					},
					{
						uuid: FEEDBACK,
						name: "Feedback",
						type: "survey",
						displayCondition: eq(read(matchAll()), literal("North clinic")),
						fields: [
							f({
								kind: "text",
								id: "comment",
								label: proseText("Comment"),
							}),
						],
					},
				],
			},
		],
	});
	const findings = runValidation(doc, {
		kind: "available",
		projectId: "project-lookup-names",
		projectRevision: parseLookupRevision("1"),
		definitions: [table],
	});
	if (findings.length > 0) throw new Error(JSON.stringify(findings));
	return { doc, table, rows, naming };
}

/** The element children of `node`. */
function childElements(node: { readonly children: readonly unknown[] }) {
	return node.children.filter((child): child is Element =>
		isTag(child as Element),
	);
}

/** Every element named `name` in an XML text, in document order. */
function elementsNamed(xml: string, name: string): Element[] {
	return findAll((node) => node.name === name, parseXml(xml).children);
}

/**
 * HQ's `xpath.py::dot_interpolate`, character for character: a `.` outside
 * a quoted string whose neighbours are not both digits on one side is read
 * as the current case. Run with an empty replacement, an unchanged result
 * is the test `_ensure_no_case_references` makes, and also what the build
 * leaves of a case form's filter.
 */
function dotInterpolate(text: string, replacement: string): string {
	let quote = "";
	let out = "";
	let i = 0;
	const nonDigit = (character: string | undefined) =>
		character !== undefined && /\D/.test(character);
	while (i < text.length) {
		if (text[i] === "\\") {
			out += text.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (quote) {
			if (text[i] === quote) quote = "";
			out += text[i];
		} else if (text[i] === '"' || text[i] === "'") {
			quote = text[i];
			out += text[i];
		} else {
			if (
				text[i] === "." &&
				(i === 0 || nonDigit(text[i - 1])) &&
				(i === text.length - 1 || nonDigit(text[i + 1]))
			) {
				out += replacement;
				i += 1;
				continue;
			}
			out += text[i];
		}
		i += 1;
	}
	return out;
}

/** Whether the generated XPath parser reads `text` with no error node. */
function parsesCleanly(text: string): boolean {
	let clean = true;
	parser.parse(text).iterate({
		enter: (node) => {
			if (node.type.isError) clean = false;
		},
	});
	return clean;
}

/** The text of every name step the generated parser reads in `text`. */
function nameTests(text: string): string[] {
	const names: string[] = [];
	parser.parse(text).iterate({
		enter: (node) => {
			if (node.type.id === NameTest) names.push(text.slice(node.from, node.to));
		},
	});
	return names;
}

const FIXTURE_PATH = "/health-facility_list/health-facility";
/** A form names the table's instance by its tag. */
const FIXTURE_READ = `instance('health-facility')${FIXTURE_PATH}`;
/** A suite slot names it by its fixture id. */
const SUITE_FIXTURE_READ = `instance('item-list:health-facility')${FIXTURE_PATH}`;

describe("hyphenated lookup names on the wire", () => {
	it("the port of HQ's dot reading rewrites what it should", () => {
		// The port is the oracle below, so it must catch what HQ catches.
		expect(dotInterpolate("./name = 'a.b'", "X")).toBe("X/name = 'a.b'");
		expect(dotInterpolate("geo.lat = 1.5", "")).toBe("geolat = 1.5");
		expect(dotInterpolate("health-facility = 2", "")).toBe(
			"health-facility = 2",
		);
	});

	it("writes the fixture's elements under the names Nova holds", () => {
		const { table, rows, naming } = namesApp();
		const [fixture] = buildLookupFixtures(
			naming,
			new Map([[table.id, rows]]),
		).fixtures;
		const [root] = childElements(parseXml(fixture.xml));
		expect(root.attribs.id).toBe("item-list:health-facility");
		const [list] = childElements(root);
		expect(list.name).toBe("health-facility_list");
		const [row] = childElements(list);
		expect(row.name).toBe("health-facility");
		expect(childElements(row).map((cell) => cell.name)).toEqual([
			"facility-name",
			"district-code",
		]);
	});

	it("names the workbook's sheet and headers by the tag and the wire names", () => {
		const { table, rows, naming } = namesApp();
		const workbook = buildLookupWorkbook(naming, new Map([[table.id, rows]]));
		const zip = new AdmZip(Buffer.from(workbook.bytes));
		const sheets = elementsNamed(
			zip.readAsText("xl/workbook.xml"),
			"sheet",
		).map((sheet) => sheet.attribs.name);
		expect(sheets).toEqual(["types", "health-facility"]);
		const cells = (path: string) =>
			elementsNamed(zip.readAsText(path), "row").map((row) =>
				childElements(row).map((cell) => textContent(cell)),
			);
		expect(cells("xl/worksheets/sheet1.xml")[1]).toEqual([
			"N",
			"health-facility",
			"yes",
			"facility-name",
			"district-code",
		]);
		expect(cells("xl/worksheets/sheet2.xml")[0]).toEqual([
			"UID",
			"Delete(Y/N)",
			"field: facility-name",
			"field: district-code",
		]);
	});

	it("prints every read as one parseable path over the hyphenated names, which HQ's build leaves alone", () => {
		const { doc, naming } = namesApp();
		const hq = expandDoc(doc, { lookupNaming: naming });
		const [module] = hq.modules;
		const [visit, feedback] = module.forms;

		const source = hq._attachments[`${visit.unique_id}.xml`];
		if (typeof source !== "string") throw new Error("No source for Visit.");
		const calculate = elementsNamed(source, "bind")
			.map((bind) => bind.attribs.calculate)
			.find((value) => value?.includes("health-facility"));
		expect(calculate).toBe(
			`if(count(${FIXTURE_READ}) > 0, ${FIXTURE_READ}[1]/facility-name, '')`,
		);

		const filter = module.case_details.short.filter;
		const formFilters = [visit.form_filter, feedback.form_filter];
		expect(parsesCleanly(calculate ?? "")).toBe(true);
		// Each hyphenated name is one step, never a subtraction.
		expect(nameTests(calculate ?? "")).toEqual(
			expect.arrayContaining([
				"health-facility_list",
				"health-facility",
				"facility-name",
			]),
		);
		expect(nameTests(String(filter))).toEqual(
			expect.arrayContaining(["district-code", "facility-name"]),
		);
		for (const text of [filter, ...formFilters]) {
			if (typeof text !== "string") throw new Error("A read was not written.");
			expect(text).toContain(`${SUITE_FIXTURE_READ}`);
			expect(text).toContain("/facility-name");
			expect(parsesCleanly(text)).toBe(true);
			expect(dotInterpolate(text, "")).toBe(text);
		}
	});
});
