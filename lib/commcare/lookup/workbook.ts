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
 * **The consumer oracle is CommCare HQ's native workbook reader.** The workbook shape is
 * not documented anywhere; what is authoritative is that
 * `corehq/apps/fixtures/download.py::_prepare_fixture` writes workbooks
 * that `corehq/apps/fixtures/upload/workbook.py` reads back. This module
 * emits its header grammar using an inline-text XLSX package; the native
 * proof executes that reader over current production bytes.
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

import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupFixtureRow } from "@/lib/lookup/types";
import type { LookupWireNaming } from "./naming";
import { buildTextWorkbook } from "./textWorkbook";
import {
	type LookupWorkbookOwners,
	lookupWorkbookDataHeader,
	lookupWorkbookDataRow,
	lookupWorkbookShape,
	lookupWorkbookTypesRows,
	observeLookupWorkbookRow,
} from "./workbookRows";

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
 * `worksheet.max_row`). Nova's 5,000-row threshold is for inline input;
 * a paged table can approach the workbook ceiling by itself.
 */
export const MAX_HQ_FIXTURE_WORKBOOK_ROWS = 500_000;

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
	assignments?: ReadonlyMap<
		LookupTableId,
		ReadonlyMap<string, LookupWorkbookOwners>
	>,
): LookupWorkbook {
	const tables = [...naming.tables].sort((left, right) =>
		left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0,
	);
	const sheets: { name: string; rows: string[][] }[] = [];
	const typesRows = lookupWorkbookTypesRows(tables);
	sheets.push({ name: TYPES_SHEET, rows: typesRows });

	let totalWorkbookRows = typesRows.length;
	const summaries = tables.map((table): LookupWorkbookTable => {
		const rows = rowsByTable.get(table.tableId);
		if (rows === undefined) {
			throw new Error(
				`buildLookupWorkbook: table '${table.tableId}' has no rows entry in the fixture snapshot. Definitions and rows must come from one snapshot read, this is a reader bug, not an authoring state.`,
			);
		}
		const owners = assignments?.get(table.tableId);
		const shape = lookupWorkbookShape(table);
		for (const row of rows)
			observeLookupWorkbookRow(shape, table, row, owners?.get(row.id));
		if (shape.issue)
			throw new Error(
				`“${table.tag}” cannot be sent in a workbook. ${shape.issue}`,
			);
		const sheetRows = [
			lookupWorkbookDataHeader(table, shape),
			...rows.map((row) =>
				lookupWorkbookDataRow(table, shape, row, owners?.get(row.id)),
			),
		];
		totalWorkbookRows += sheetRows.length;
		/* The sheet name IS the tag: `_run_upload` looks each table's data
		 * sheet up by it (`get_data_sheet(tabledef.table_id)`), read as a plain
		 * title with no length check
		 * (`util/workbook_json/excel.py::WorkbookJSONReader.get_worksheet`), so
		 * a tag of Nova's full 32 characters names its sheet as written. */
		if (table.tag.toLowerCase() === TYPES_SHEET) {
			throw new Error(
				`buildLookupWorkbook: the tag '${table.tag}' is the name of the mandatory types sheet, so its rows have nowhere to go. The export boundary must reject a tag reserved by CommCare HQ before the workbook is built.`,
			);
		}
		sheets.push({ name: table.tag, rows: sheetRows });
		return {
			tableId: table.tableId,
			tag: table.tag,
			columnCount: table.columns.length,
			rowCount: rows.length,
		};
	});

	const bytes = buildTextWorkbook(sheets);

	return { bytes, tables: summaries, totalWorkbookRows };
}
