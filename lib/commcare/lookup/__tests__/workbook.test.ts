/**
 * The fixture workbook, against CommCare HQ's own byte oracle.
 *
 * The workbook shape is documented nowhere. What IS authoritative is that
 * `corehq/apps/fixtures/download.py::_prepare_fixture` writes the workbooks
 * `corehq/apps/fixtures/upload/workbook.py` reads back, so these assert the
 * exact strings that round trip:
 *
 *   - `_prepare_fixture` writes a `types` sheet headed
 *     `Delete(Y/N)`, `table_id`, `is_global?`, `field 1`, `field 2`, …
 *     and one sheet per table named by its tag, headed `UID`,
 *     `Delete(Y/N)`, `field: <name>`, …
 *   - `_FixtureWorkbook.get_types_sheet` refuses a workbook with no `types`
 *     sheet, and `::get_data_sheet(tag)` looks each table's rows up by its
 *     tag, so both names are the contract rather than labels.
 *   - `util/workbook_json/excel.py::IteratorJSONReader.set_field_value`
 *     reads `a N` as a list, `a: b` as a nested key, and `a?` as a boolean,
 *     which is why `field 1` collects and `field: age` addresses a column.
 *
 * The values go through `lookupFixtureCellText`, the same projection the
 * `.ccz` fixtures use, so a decimal or an empty cell cannot mean two things
 * depending on how the table reached the device.
 */

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupFixtureRow,
	LookupRevision,
	LookupRowId,
	LookupRowValues,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { lookupWireNaming } from "../naming";
import {
	buildLookupWorkbook,
	MAX_HQ_FIXTURE_SHEET_NAME_LENGTH,
} from "../workbook";

const CODE_COL = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const NAME_COL = "018f0000-0000-7000-8000-0000000000c2" as LookupColumnId;
const QTY_COL = "018f0000-0000-7000-8000-0000000000c3" as LookupColumnId;

function tableId(seed: string): LookupTableId {
	return `018f0000-0000-7000-8000-table${seed}` as LookupTableId;
}

let rowSeq = 0;
function row(values: LookupRowValues): LookupFixtureRow {
	rowSeq += 1;
	return { id: `018f0000-0000-7000-8000-row${rowSeq}` as LookupRowId, values };
}

function table(
	tag: string,
	columns: LookupTableDefinition["columns"],
): LookupTableDefinition {
	return {
		id: tableId(tag),
		name: tag,
		tag,
		definitionRevision: "1" as LookupRevision,
		columns,
	};
}

const DEMO = table("demo", [
	{ id: CODE_COL, wireName: "code", label: "Code", dataType: "text" },
	{ id: NAME_COL, wireName: "name", label: "Name", dataType: "text" },
	{ id: QTY_COL, wireName: "qty", label: "Qty", dataType: "int" },
]);

/** Read one sheet back as the array of rows CommCare HQ's reader walks. */
function sheetRows(bytes: Uint8Array, name: string): unknown[][] {
	const book = XLSX.read(bytes, { type: "buffer" });
	const sheet = book.Sheets[name];
	if (sheet === undefined) {
		throw new Error(`the workbook has no sheet named '${name}'`);
	}
	return XLSX.utils.sheet_to_json(sheet, {
		header: 1,
		raw: false,
		defval: "",
	}) as unknown[][];
}

function sheetNames(bytes: Uint8Array): string[] {
	return XLSX.read(bytes, { type: "buffer" }).SheetNames;
}

describe("the types sheet", () => {
	it("carries CommCare HQ's own header grammar, in its own order", () => {
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO]),
			new Map([[DEMO.id, []]]),
		);
		expect(sheetRows(workbook.bytes, "types")[0]).toEqual([
			"Delete(Y/N)",
			"table_id",
			"is_global?",
			"field 1",
			"field 2",
			"field 3",
		]);
	});

	it("names each table once, global, with its columns in authored order", () => {
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO]),
			new Map([[DEMO.id, []]]),
		);
		expect(sheetRows(workbook.bytes, "types")[1]).toEqual([
			"N",
			"demo",
			"yes",
			"code",
			"name",
			"qty",
		]);
	});

	it("pads a narrower table to the widest field list", () => {
		/* A sheet has ONE header row, so `field 3` exists for every table
		 * once any table has three columns. `IteratorJSONReader` drops the
		 * empty cells from the list rather than reading a column named "". */
		const narrow = table("places", [
			{ id: CODE_COL, wireName: "code", label: "Code", dataType: "text" },
		]);
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO, narrow]),
			new Map([
				[DEMO.id, []],
				[narrow.id, []],
			]),
		);
		const rows = sheetRows(workbook.bytes, "types");
		expect(rows[0]).toHaveLength(6);
		expect(rows.find((entry) => entry[1] === "places")).toEqual([
			"N",
			"places",
			"yes",
			"code",
			"",
			"",
		]);
	});
});

describe("a data sheet", () => {
	it("is named for its tag, which is how CommCare HQ finds it", () => {
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO]),
			new Map([[DEMO.id, []]]),
		);
		expect(sheetNames(workbook.bytes)).toEqual(["types", "demo"]);
	});

	it("heads each column `field: <wire name>` after UID and Delete", () => {
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO]),
			new Map([[DEMO.id, []]]),
		);
		expect(sheetRows(workbook.bytes, "demo")[0]).toEqual([
			"UID",
			"Delete(Y/N)",
			"field: code",
			"field: name",
			"field: qty",
		]);
	});

	it("leaves UID empty and projects cells exactly as the fixtures do", () => {
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO]),
			new Map([
				[
					DEMO.id,
					[
						row({
							[CODE_COL]: "a1",
							[NAME_COL]: "Anna",
							[QTY_COL]: 7,
						} as LookupRowValues),
						/* An absent cell and a stored empty one both project to
						 * blank: the wire emits every defined column, so the two
						 * are only distinguishable in storage. */
						row({ [CODE_COL]: "b2", [QTY_COL]: 0.5 } as LookupRowValues),
					],
				],
			]),
		);
		const rows = sheetRows(workbook.bytes, "demo");
		expect(rows[1]).toEqual(["", "N", "a1", "Anna", "7"]);
		expect(rows[2]).toEqual(["", "N", "b2", "", "0.5"]);
	});

	it("survives a column set that changed since the last push", () => {
		/* `run_upload.py::table_key` includes the fields, so CommCare HQ
		 * deletes and recreates a table whose columns moved. Harmless under
		 * `replace`, and nothing here has to notice: the workbook simply
		 * describes the table as it is now. */
		const widened = table("demo", [
			...DEMO.columns,
			{
				id: "018f0000-0000-7000-8000-0000000000c4" as LookupColumnId,
				wireName: "note",
				label: "Note",
				dataType: "text",
			},
		]);
		const workbook = buildLookupWorkbook(
			lookupWireNaming([widened]),
			new Map([[widened.id, [row({ [CODE_COL]: "a1" } as LookupRowValues)]]]),
		);
		expect(sheetRows(workbook.bytes, "demo")[0]).toEqual([
			"UID",
			"Delete(Y/N)",
			"field: code",
			"field: name",
			"field: qty",
			"field: note",
		]);
		expect(sheetRows(workbook.bytes, "demo")[1]).toEqual([
			"",
			"N",
			"a1",
			"",
			"",
			"",
		]);
	});
});

describe("the whole workbook", () => {
	it("orders sheets by tag so a diff against the ccz reads one way", () => {
		const beta = table("beta", [
			{ id: CODE_COL, wireName: "code", label: "Code", dataType: "text" },
		]);
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO, beta]),
			new Map([
				[DEMO.id, []],
				[beta.id, []],
			]),
		);
		expect(sheetNames(workbook.bytes)).toEqual(["types", "beta", "demo"]);
		expect(workbook.tables.map((entry) => entry.tag)).toEqual(["beta", "demo"]);
	});

	it("counts every sheet's rows with their headers, as CommCare HQ does", () => {
		/* `WorkbookJSONReader.__init__` accumulates `worksheet.max_row` across
		 * every sheet, headers included, before comparing to
		 * `MAX_FIXTURE_ROWS`. */
		const workbook = buildLookupWorkbook(
			lookupWireNaming([DEMO]),
			new Map([
				[
					DEMO.id,
					[
						row({ [CODE_COL]: "a" } as LookupRowValues),
						row({ [CODE_COL]: "b" } as LookupRowValues),
					],
				],
			]),
		);
		// types: header + 1 table. demo: header + 2 rows.
		expect(workbook.totalWorkbookRows).toBe(5);
		expect(workbook.tables).toEqual([
			{ tableId: DEMO.id, tag: "demo", columnCount: 3, rowCount: 2 },
		]);
	});

	it("refuses a tag no sheet could be named for", () => {
		/* Unreachable through the export boundary, which refuses the tag
		 * first (`LOOKUP_TAG_TOO_LONG_FOR_HQ`). Asserted so the builder stays
		 * a total function of what it is handed rather than quietly writing a
		 * sheet CommCare HQ would never find. */
		const long = table("a".repeat(MAX_HQ_FIXTURE_SHEET_NAME_LENGTH + 1), [
			{ id: CODE_COL, wireName: "code", label: "Code", dataType: "text" },
		]);
		expect(() =>
			buildLookupWorkbook(lookupWireNaming([long]), new Map([[long.id, []]])),
		).toThrow(/cannot exceed 31/);
	});

	it("refuses a table whose rows never arrived in the snapshot", () => {
		expect(() =>
			buildLookupWorkbook(lookupWireNaming([DEMO]), new Map()),
		).toThrow(/no rows entry/);
	});
});
