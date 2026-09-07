/** The small XLSX subset HQ reads: worksheets containing only inline text.
 * SheetJS escapes CR as `_x000d_`, which HQ's openpyxl reader leaves literal.
 * Native XML references preserve CR without spreadsheet scalar coercion. */
import AdmZip from "adm-zip";
import { el, text } from "../elementBuilders";
import { serializeXml } from "../serializeXml";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL =
	"http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES =
	"http://schemas.openxmlformats.org/package/2006/content-types";

function columnName(index: number): string {
	let name = "";
	for (
		let column = index + 1;
		column > 0;
		column = Math.floor((column - 1) / 26)
	)
		name = String.fromCharCode(65 + ((column - 1) % 26)) + name;
	return name;
}

export function buildTextWorkbook(
	sheets: readonly { name: string; rows: readonly (readonly string[])[] }[],
): Uint8Array {
	const zip = new AdmZip();
	const addXml = (name: string, element: ReturnType<typeof el>) => {
		zip.addFile(
			name,
			Buffer.from(
				`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${serializeXml(element)}`,
			),
		);
		const entry = zip.getEntry(name);
		if (!entry) throw new Error(`Workbook archive omitted ${name}`);
		entry.header.time = new Date(2000, 0, 1);
	};
	addXml(
		"[Content_Types].xml",
		el("Types", { xmlns: CONTENT_TYPES }, [
			el("Default", {
				Extension: "rels",
				ContentType: "application/vnd.openxmlformats-package.relationships+xml",
			}),
			el("Default", { Extension: "xml", ContentType: "application/xml" }),
			el("Override", {
				PartName: "/xl/workbook.xml",
				ContentType:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
			}),
			...sheets.map((_, index) =>
				el("Override", {
					PartName: `/xl/worksheets/sheet${index + 1}.xml`,
					ContentType:
						"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
				}),
			),
		]),
	);
	addXml(
		"_rels/.rels",
		el("Relationships", { xmlns: PACKAGE_REL }, [
			el("Relationship", {
				Id: "rId1",
				Type: `${REL}/officeDocument`,
				Target: "xl/workbook.xml",
			}),
		]),
	);
	addXml(
		"xl/workbook.xml",
		el("workbook", { xmlns: MAIN, "xmlns:r": REL }, [
			el(
				"sheets",
				{},
				sheets.map((sheet, index) =>
					el("sheet", {
						name: sheet.name,
						sheetId: String(index + 1),
						"r:id": `rId${index + 1}`,
					}),
				),
			),
		]),
	);
	addXml(
		"xl/_rels/workbook.xml.rels",
		el(
			"Relationships",
			{ xmlns: PACKAGE_REL },
			sheets.map((_, index) =>
				el("Relationship", {
					Id: `rId${index + 1}`,
					Type: `${REL}/worksheet`,
					Target: `worksheets/sheet${index + 1}.xml`,
				}),
			),
		),
	);
	sheets.forEach((sheet, index) => {
		const width = sheet.rows.reduce((max, row) => Math.max(max, row.length), 1);
		const rowElements = sheet.rows.map((row, rowIndex) => {
			const cells = row.map((value, columnIndex) =>
				el(
					"c",
					{
						r: `${columnName(columnIndex)}${rowIndex + 1}`,
						t: "inlineStr",
					},
					[el("is", {}, [el("t", { "xml:space": "preserve" }, [text(value)])])],
				),
			);
			return el("row", { r: String(rowIndex + 1) }, cells);
		});
		addXml(
			`xl/worksheets/sheet${index + 1}.xml`,
			el("worksheet", { xmlns: MAIN }, [
				el("dimension", {
					ref: `A1:${columnName(width - 1)}${Math.max(1, sheet.rows.length)}`,
				}),
				el("sheetData", {}, rowElements),
			]),
		);
	});
	return zip.toBuffer();
}
