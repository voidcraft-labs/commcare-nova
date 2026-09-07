/** XLSX structure is decoded independently here; native HQ owns upload compatibility. */
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { lookupWireNaming } from "../naming";
import { buildLookupWorkbook } from "../workbook";
import { lookupWireCorpus, wireRow, wireTable } from "./lookupWireCorpus";

function sheets(bytes: Uint8Array) {
	const zip = new AdmZip(Buffer.from(bytes));
	const parse = (path: string) => {
		const xml = zip.readAsText(path);
		new SaxesParser({ xmlns: true }).write(xml).close();
		return parseDocument(xml, { xmlMode: true });
	};
	const relationships = new Map(
		findAll(
			(node) => node.name === "Relationship",
			parse("xl/_rels/workbook.xml.rels").children,
		).map((node) => [node.attribs.Id, node.attribs.Target]),
	);
	return findAll(
		(node) => node.name === "sheet",
		parse("xl/workbook.xml").children,
	).map((sheet) => {
		const target = relationships.get(sheet.attribs["r:id"]);
		if (!target) throw new Error("Missing worksheet relationship");
		const tree = parse(`xl/${target}`);
		const rows = findAll((node) => node.name === "row", tree.children).map(
			(row) =>
				row.children.filter(isTag).map((cell) => {
					expect(cell.name).toBe("c");
					// Values must remain text: numeric-looking codes and formula-looking data
					// are deliberately not numbers or formulas in the exported workbook.
					expect(cell.attribs.t).toBe("inlineStr");
					expect(findAll((node) => node.name === "f", cell.children)).toEqual(
						[],
					);
					return textContent(cell);
				}),
		);
		return { name: sheet.attribs.name, rows };
	});
}

describe("lookup XLSX artifact", () => {
	it("carries complete typed rows, empty tables and padded field definitions in tag order", () => {
		const corpus = lookupWireCorpus();
		const before = structuredClone(corpus);
		const result = buildLookupWorkbook(
			lookupWireNaming(corpus.definitions),
			corpus.rowsByTable,
		);
		const decoded = sheets(result.bytes);
		expect(decoded.map((sheet) => sheet.name)).toEqual([
			"types",
			"empty",
			"records",
		]);
		expect(decoded[0].rows).toEqual([
			[
				"Delete(Y/N)",
				"table_id",
				"is_global?",
				...Array.from({ length: 7 }, (_, index) => `field ${index + 1}`),
			],
			["N", "empty", "yes", "code", "", "", "", "", "", ""],
			[
				"N",
				"records",
				"yes",
				"code",
				"text",
				"qty",
				"ratio",
				"day",
				"time",
				"instant",
			],
		]);
		for (const [index, table] of corpus.expected.entries()) {
			expect(decoded[index + 1].rows).toEqual([
				[
					"UID",
					"Delete(Y/N)",
					...table.columns.map((column) => `field: ${column}`),
				],
				...table.rows.map((row) => ["", "N", ...row]),
			]);
		}
		expect(result.totalWorkbookRows).toBe(
			decoded.reduce((sum, sheet) => sum + sheet.rows.length, 0),
		);
		expect(result.tables).toEqual(
			corpus.expected.map((table) => ({
				tableId: corpus.definitions.find(
					(definition) => definition.tag === table.tag,
				)?.id,
				tag: table.tag,
				columnCount: table.columns.length,
				rowCount: table.rows.length,
			})),
		);
		expect(corpus).toEqual(before);
	});
	it("addresses the complete fifty-column storage limit across Excel column letters", () => {
		const table = wireTable(
			"columns",
			Array.from({ length: 50 }, (_, index) => ({
				name: `c${index}`,
				type: "text",
			})),
		);
		const values = Object.fromEntries(
			Array.from({ length: 50 }, (_, index) => [`c${index}`, `v${index}`]),
		);
		const result = buildLookupWorkbook(
			lookupWireNaming([table]),
			new Map([[table.id, [wireRow(table, "r", values)]]]),
		);
		const xml = new AdmZip(Buffer.from(result.bytes)).readAsText(
			"xl/worksheets/sheet2.xml",
		);
		const tree = parseDocument(xml, { xmlMode: true });
		const cells = findAll((node) => node.name === "c", tree.children);
		const byAddress = new Map(
			cells.map((cell) => [cell.attribs.r, textContent(cell)]),
		);
		expect(byAddress.get("Z2")).toBe("v23");
		expect(byAddress.get("AA2")).toBe("v24");
		expect(byAddress.get("AZ2")).toBe("v49");
		expect(sheets(result.bytes)[1].rows[1]).toEqual([
			"",
			"N",
			...Object.values(values),
		]);
	});

	it("derives renamed and reordered columns from this generation", () => {
		const table = wireTable("renamed", [
			{ name: "second", type: "text" },
			{ name: "first", type: "text" },
		]);
		const row = wireRow(table, "r", { first: "one", second: "two" });
		const result = buildLookupWorkbook(
			lookupWireNaming([table]),
			new Map([[table.id, [row]]]),
		);
		expect(sheets(result.bytes)[1].rows).toEqual([
			["UID", "Delete(Y/N)", "field: second", "field: first"],
			["", "N", "two", "one"],
		]);
	});
	it.each(["types", "Types", "a".repeat(32)])(
		"defensively refuses an HQ-unaddressable tag %s",
		(tag) => {
			const table = wireTable(tag, [{ name: "value", type: "text" }]);
			expect(() =>
				buildLookupWorkbook(
					lookupWireNaming([table]),
					new Map([[table.id, []]]),
				),
			).toThrow(/mandatory types sheet|cannot exceed 31/);
		},
	);
	it("defensively refuses a snapshot missing its rows", () => {
		const table = wireTable("data", [{ name: "value", type: "text" }]);
		expect(() =>
			buildLookupWorkbook(lookupWireNaming([table]), new Map()),
		).toThrow(/no rows entry/);
	});
});
