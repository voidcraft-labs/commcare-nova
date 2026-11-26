import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
} from "@/lib/lookup/types";
import type { HqFixtureRow } from "../hq/lookupTables";
import { type LookupTableWireNaming, lookupWireNaming } from "./naming";
import { workerFixtureRow } from "./row";
import { streamingLookupRowsDigest } from "./rowsDigest";

export interface ExpectedLookupData {
	count: number;
	digest: string;
	isGlobal: boolean;
	fields: readonly string[];
	fieldProperties: Readonly<Record<string, readonly string[]>>;
	attributes: readonly string[];
}

/** HQ's inventory spells the same field occurrences and details that
 * the worker fixture contains. Database and HQ resource IDs differ. */
export function intendedHqRow(
	naming: LookupTableWireNaming,
	row: LookupFixtureRow,
): HqFixtureRow {
	const tree = workerFixtureRow(naming, row);
	const fields: Record<
		string,
		{ value: string; properties: Readonly<Record<string, string>> }[]
	> = Object.create(null);
	for (const col of naming.columns) fields[col.wireName] = [];
	for (const child of tree.children)
		fields[child.name].push({
			value: child.value,
			properties: child.attributes,
		});
	/* A repeated column a row holds no list of is a field CommCare HQ's row
	 * does not hold at all. The worker fixture writes it as one empty element,
	 * as HQ's restore does (`fixturegenerators.py::ItemListsProvider.to_xml`),
	 * so the tree alone reads it as an empty value; HQ's row keeps no key. */
	for (const col of naming.columns)
		if (col.repeated && row.occurrences?.[col.id] === undefined)
			delete fields[col.wireName];
	return { id: row.id, fields, itemAttributes: tree.attributes };
}

export function expectedLookupData(
	naming: LookupTableWireNaming,
	count: number,
	digest: string,
): ExpectedLookupData {
	return {
		count,
		digest,
		isGlobal: naming.distribution !== "assigned",
		fields: naming.columns.map((c) => c.wireName),
		fieldProperties: Object.fromEntries(
			naming.columns.map((c) => [
				c.wireName,
				(c.properties ?? []).map((p) => p.wireName),
			]),
		),
		attributes: (naming.attributes ?? []).map((a) => a.wireName),
	};
}

export function inlineWorkbookReceipts(
	snapshot: LookupFixtureDataSnapshot,
	ids: ReadonlySet<string>,
) {
	const receipts = new Map<string, ExpectedLookupData>();
	const naming = lookupWireNaming(snapshot.definitions);
	for (const table of naming.tables) {
		if (!ids.has(table.tableId)) continue;
		const rows = snapshot.rowsByTable.get(table.tableId);
		if (!rows)
			throw new Error("The workbook lost its source rows before publication.");
		const state = streamingLookupRowsDigest();
		for (const row of rows) state.row(intendedHqRow(table, row));
		const { count, digest } = state.finish();
		receipts.set(table.tableId, expectedLookupData(table, count, digest));
	}
	return receipts;
}
