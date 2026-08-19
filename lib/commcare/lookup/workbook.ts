/**
 * Nova's lookup tables as the workbook CommCare HQ's fixture upload reads.
 *
 * CommCare HQ has no REST endpoint that takes a table's rows in bulk. The
 * row resource keys rows by a server-minted UUID with no natural key, so a
 * JSON row sync would force Nova to keep per-row remote-id bookkeeping for
 * data whose whole identity is its content. The Excel endpoint takes a
 * table definition and its rows together and replaces them wholesale,
 * which is exactly the shape Nova has: one Project table, pushed whole.
 *
 * **The byte oracle is CommCare HQ's own exporter.** The workbook shape is
 * not documented anywhere; what is authoritative is that
 * `corehq/apps/fixtures/download.py::_prepare_fixture` writes workbooks
 * that `corehq/apps/fixtures/upload/workbook.py` reads back. This module
 * emits what that exporter emits, and the tests assert against it column
 * for column.
 *
 * Two sheets, and the shapes are not interchangeable:
 *
 *   * a mandatory `types` sheet, one row per table, carrying the tag and
 *     the field NAMES. A workbook without it is rejected outright
 *     (`_FixtureWorkbook.get_types_sheet` → `no_types_sheet`), and this is
 *     the sheet that creates or updates the table definition — which is
 *     why the JSON `lookup_table` resource is not on the write path at
 *     all.
 *   * one data sheet per table, NAMED BY ITS TAG, carrying the values.
 *
 * The header strings are a small grammar rather than labels
 * (`corehq/apps/fixtures/upload/../../util/workbook_json/excel.py::IteratorJSONReader.set_field_value`):
 * `a: b` nests, `a N` with a space makes a list, `a?` is a yes/no boolean,
 * and anything else is a flat key. So `field 1` and `field 2` collect into
 * a list of field names on the types sheet, `field: age` addresses one
 * column on a data sheet, and `is_global?` is a boolean. Renaming any of
 * them silently changes what CommCare HQ reads.
 */

import * as XLSX from "xlsx";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupFixtureRow } from "@/lib/lookup/types";
import { lookupFixtureCellText } from "./cellText";
import type { LookupTableWireNaming, LookupWireNaming } from "./naming";

/**
 * `upload/const.py::DELETE_HEADER`. Carries parentheses and a slash, none
 * of which are grammar characters, so it reads as one flat key.
 */
const DELETE_HEADER = "Delete(Y/N)";

/** The types sheet's name is itself the contract. */
/**
 * The name of the mandatory sheet listing every table in the upload.
 *
 * Exported because it is a name a data sheet may not also take, and the
 * export boundary has to refuse such a tag BEFORE the builder runs: a tag
 * of `types` is authorable in Nova, and appending a second sheet under
 * this name throws. CommCare HQ has the same collision from the other
 * side, reading its types sheet with `get_data_sheet("types")`.
 */
export const TYPES_SHEET = "types";

/**
 * CommCare HQ's whole-workbook row ceiling
 * (`upload/const.py::MAX_FIXTURE_ROWS`), enforced across every sheet
 * together rather than per table
 * (`util/workbook_json/excel.py::WorkbookJSONReader.__init__` accumulates
 * `worksheet.max_row`). Nova's own 5,000-row cap per table means only an
 * app referencing about a hundred tables could approach it, but an app
 * that did would be refused by CommCare HQ with a message about a limit
 * nobody set, so Nova measures it first.
 */
export const MAX_HQ_FIXTURE_WORKBOOK_ROWS = 500_000;

/**
 * How long a data sheet's name may be, which is how long a pushable tag
 * may be.
 *
 * CommCare HQ finds each table's rows by the sheet NAMED FOR ITS TAG
 * (`upload/workbook.py::_FixtureWorkbook.get_data_sheet` →
 * `get_worksheet(tag)`), and a spreadsheet sheet name cannot exceed 31
 * characters. CommCare HQ's own exporter silently truncates past that
 * (`couchexport/writers.py::Excel2007ExportWriter.max_table_name_size`
 * = 31, applied through `ExportWriter.open`'s `UniqueHeaderGenerator`),
 * so its own download does not round-trip through its own upload — while
 * its `LookupTable.tag` column takes 32. Nova's tag cap is the same 32,
 * so exactly one authorable tag length is unpushable, and the export
 * boundary refuses it by name rather than letting CommCare HQ answer
 * "worksheet not found".
 */
export const MAX_HQ_FIXTURE_SHEET_NAME_LENGTH = 31;

/**
 * A table as CommCare HQ will hold it, and how big it is.
 *
 * Row counts include the header row of each sheet, because that is what
 * CommCare HQ counts.
 */
export interface LookupWorkbookTable {
	readonly tableId: LookupTableId;
	readonly tag: string;
	readonly columnCount: number;
	readonly rowCount: number;
}

export interface LookupWorkbook {
	/** `.xlsx` bytes, ready to post to the fixture upload endpoint. */
	readonly bytes: Uint8Array;
	/** The tables it carries, in the order their sheets appear. */
	readonly tables: readonly LookupWorkbookTable[];
	/** Every sheet's rows, headers included: what CommCare HQ counts. */
	readonly totalWorkbookRows: number;
}

function typesSheetRows(tables: readonly LookupTableWireNaming[]): string[][] {
	/* Every table's row must be as wide as the widest table's field list,
	 * because a sheet has one header row. A narrower table pads with empty
	 * cells, which `IteratorJSONReader` drops from the list rather than
	 * reading as a field named "". */
	const widest = tables.reduce(
		(max, table) => Math.max(max, table.columns.length),
		0,
	);
	const header = [
		DELETE_HEADER,
		"table_id",
		"is_global?",
		...Array.from({ length: widest }, (_, index) => `field ${index + 1}`),
	];
	const rows = tables.map((table) => [
		"N",
		table.tag,
		/* Nova's tables are Project data every worker reads, never rows
		 * owned by one user or location. CommCare HQ's alternative is a
		 * per-owner table, which Nova has no vocabulary for. */
		"yes",
		...table.columns.map((column) => column.wireName),
		...Array.from({ length: widest - table.columns.length }, () => ""),
	]);
	return [header, ...rows];
}

function dataSheetRows(
	table: LookupTableWireNaming,
	rows: readonly LookupFixtureRow[],
): string[][] {
	const header = [
		/* Left empty on every row below: `UID` is what an incremental merge
		 * keys on, and Nova pushes whole tables rather than merging, so
		 * every row is presented as new. `run_upload.py::_run_upload` under
		 * `replace` deletes whatever the sheet does not carry, which is the
		 * behaviour Nova wants and the reason it never has to remember a
		 * remote row id. */
		"UID",
		DELETE_HEADER,
		...table.columns.map((column) => `field: ${column.wireName}`),
	];
	const body = rows.map((row) => [
		"",
		"N",
		...table.columns.map((column) =>
			lookupFixtureCellText(column.dataType, row.values[column.id]),
		),
	]);
	return [header, ...body];
}

/**
 * Build one workbook carrying every table an app references.
 *
 * One workbook rather than one per table, because the upload is one
 * transaction from the author's point of view: CommCare HQ either took
 * the app's data or it did not, and a per-table loop would leave a
 * half-pushed project space with no honest thing to say about it.
 *
 * Sheets are ordered by tag, matching the fixture emitter, so a diff
 * between what the `.ccz` embeds and what CommCare HQ was sent reads in
 * one order.
 */
export function buildLookupWorkbook(
	naming: LookupWireNaming,
	rowsByTable: ReadonlyMap<LookupTableId, readonly LookupFixtureRow[]>,
): LookupWorkbook {
	const tables = [...naming.tables].sort((left, right) =>
		left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0,
	);
	const book = XLSX.utils.book_new();
	const typesRows = typesSheetRows(tables);
	XLSX.utils.book_append_sheet(
		book,
		XLSX.utils.aoa_to_sheet(typesRows),
		TYPES_SHEET,
	);

	let totalWorkbookRows = typesRows.length;
	const summaries = tables.map((table): LookupWorkbookTable => {
		const rows = rowsByTable.get(table.tableId);
		if (rows === undefined) {
			throw new Error(
				`buildLookupWorkbook: table '${table.tableId}' has no rows entry in the fixture snapshot. Definitions and rows must come from one snapshot read, this is a reader bug, not an authoring state.`,
			);
		}
		const sheetRows = dataSheetRows(table, rows);
		totalWorkbookRows += sheetRows.length;
		/* The sheet name IS the tag: `_run_upload` looks each table's data
		 * sheet up by it (`get_data_sheet(tabledef.table_id)`). The export
		 * boundary refuses a tag too long to be one before it ever calls
		 * this builder, so reaching here is a compiler bug rather than an
		 * authoring state. */
		if (table.tag.length > MAX_HQ_FIXTURE_SHEET_NAME_LENGTH) {
			throw new Error(
				`buildLookupWorkbook: the tag '${table.tag}' is ${table.tag.length} characters, and a data sheet's name cannot exceed ${MAX_HQ_FIXTURE_SHEET_NAME_LENGTH}. The export boundary must reject an unpushable tag before the workbook is built.`,
			);
		}
		if (table.tag.toLowerCase() === TYPES_SHEET) {
			throw new Error(
				`buildLookupWorkbook: the tag '${table.tag}' is the name of the mandatory types sheet, so its rows have nowhere to go. The export boundary must reject a tag reserved by CommCare HQ before the workbook is built.`,
			);
		}
		XLSX.utils.book_append_sheet(
			book,
			XLSX.utils.aoa_to_sheet(sheetRows),
			table.tag,
		);
		return {
			tableId: table.tableId,
			tag: table.tag,
			columnCount: table.columns.length,
			rowCount: rows.length,
		};
	});

	const bytes = XLSX.write(book, {
		type: "buffer",
		bookType: "xlsx",
	}) as Uint8Array;

	return { bytes, tables: summaries, totalWorkbookRows };
}
