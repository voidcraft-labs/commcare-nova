import { hqWouldTrimLookupText } from "./hqCellText";
import type { LookupValueSlot } from "@/lib/lookup/largeValues/input";
import { lookupLexicalSlots } from "@/lib/commcare/lookup/lexicalSlots";
import {
	type LookupTableWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import {
	type ExpectedLookupData,
	expectedLookupData,
	intendedHqRow,
} from "./workbookReceipt";
import {
	type StreamSheet,
	streamTextWorkbook,
} from "@/lib/commcare/lookup/streamWorkbook";
import {
	type LookupWorkbookTable,
	MAX_HQ_FIXTURE_WORKBOOK_ROWS,
} from "@/lib/commcare/lookup/workbook";
import {
	type LookupWorkbookShape,
	lookupWorkbookDataHeader,
	lookupWorkbookDataRow,
	lookupWorkbookShape,
	lookupWorkbookTypesRows,
	observeLookupWorkbookRow,
} from "@/lib/commcare/lookup/workbookRows";
import { xmlTextIssue } from "@/lib/commcare/xmlText";
import type {
	ArchiveRow,
	StreamingLookupTable,
} from "@/lib/lookup/archiveRows";
import { slotFromStoragePath } from "@/lib/lookup/fixtureValues";
import { lookupRowContentSchema } from "@/lib/lookup/schema";
import { streamingLookupRowsDigest } from "./rowsDigest";

import {
	type LookupCarrierAlternative,
	alternativeLookupCarrier,
} from "./carrier";

interface Planned {
	table: StreamingLookupTable;
	naming: LookupTableWireNaming;
	shape: LookupWorkbookShape;
	rowsDigest: string;
}
export interface StreamLookupWorkbook {
	check: () => Promise<void>;
	path: string;
	tables: readonly LookupWorkbookTable[];
	expected: ReadonlyMap<string, ExpectedLookupData>;
	totalWorkbookRows: number;
	open: () => AsyncIterable<Uint8Array>;
}

/** An XML-illegal NUL distinguishes internal references from all admitted
 * literals. The form is checked before substitution. A wide row keeps every
 * external value outside its skeleton even when every cell fits Excel. */
function workbookRow(input: ArchiveRow) {
	const { row } = input;
	if (!input.external.size)
		return { row, resolve: undefined, issue: undefined };
	const result = {
		id: row.id,
		values: { ...row.values },
		...lookupRowContentSchema.parse({
			attributes: row.attributes,
			occurrences: row.occurrences,
		}),
	};
	const slots = new Map<string, LookupValueSlot>();
	let issue: string | undefined;
	for (const [key, meta] of input.external) {
		if (meta.bytes > 3 * 32767) {
			issue = "A value exceeds the workbook cell limit.";
			break;
		}
		const slot = slotFromStoragePath(JSON.parse(key));
		const marker = meta.bytes === 0 ? "" : "\0xlsx:" + slots.size;
		if (marker) slots.set(marker, slot);
		if (slot.kind === "cell") result.values[slot.columnId] = marker;
		else if (slot.kind === "attribute" && result.attributes)
			result.attributes[slot.attributeId] = marker;
		else if (slot.kind === "property" || slot.kind === "occurrence") {
			const item = result.occurrences?.[slot.columnId]?.[slot.index];
			if (!item)
				throw new Error("A workbook occurrence lost its stored source.");
			if (slot.kind === "property") item.properties[slot.propertyId] = marker;
			else item.text = marker;
		} else throw new Error("A workbook row detail lost its stored source.");
	}
	const resolve = async (value: string) => {
		const slot = slots.get(value);
		if (!slot) return value;
		const stream = input.read({ slot });
		if (!stream) throw new Error("A workbook cell lost its stored source.");
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		let text = "";
		for await (const chunk of stream) {
			text += decoder.decode(chunk, { stream: true });
			if (text.length > 3 * 32767)
				throw new Error(
					"A workbook value exceeded the length its stored source declared.",
				);
		}
		return text + decoder.decode();
	};
	return { row: result, resolve, issue };
}

async function* workbookCells(
	cells: readonly string[],
	resolve?: (value: string) => Promise<string>,
) {
	for (const cell of cells) yield resolve ? await resolve(cell) : cell;
}

function declarationWidth(table: LookupTableWireNaming) {
	return (
		3 +
		(table.attributes?.length ?? 0) +
		table.columns.reduce(
			(n, col) =>
				n +
				1 +
				(col.index === "indexed" ? 1 : 0) +
				(col.properties?.length ?? 0),
			0,
		)
	);
}
export async function planLargeWorkbooks(
	tables: readonly StreamingLookupTable[],
) {
	const files: StreamLookupWorkbook[] = [];
	const alternatives: {
		table: StreamingLookupTable;
		carrier: LookupCarrierAlternative;
	}[] = [];
	let group: Planned[] = [],
		rows = 1;
	let declarationColumns = 0;
	const flush = () => {
		if (!group.length) return;
		const planned = group;
		group = [];
		const definitions = lookupWorkbookTypesRows(planned.map((p) => p.naming));
		const sheets: StreamSheet[] = [
			{
				name: "types",
				width: definitions[0].length,
				height: definitions.length,
				async *rows() {
					for (const def of definitions) yield def;
				},
			},
		];
		for (const { table, naming, shape } of planned) {
			const header = lookupWorkbookDataHeader(naming, shape);
			sheets.push({
				name: table.definition.tag,
				width: header.length,
				height: table.count + 1,
				async *rows() {
					yield header;
					for await (const data of table.reader.rows()) {
						const { row, resolve, issue } = workbookRow(data);
						if (issue)
							throw new Error("The workbook changed during preparation.");
						yield workbookCells(
							lookupWorkbookDataRow(naming, shape, row),
							resolve,
						);
					}
				},
			});
		}
		files.push({
			path: "lookup-data-" + (files.length + 1) + ".xlsx",
			tables: planned.map(({ table, naming }) => ({
				tableId: naming.tableId,
				tag: naming.tag,
				columnCount: naming.columns.length,
				rowCount: table.count,
			})),
			totalWorkbookRows: rows,
			check: async () => {
				for (const { table } of planned) await table.reader.check();
			},
			expected: new Map(
				planned.map(({ table, naming, rowsDigest }) => [
					naming.tableId,
					expectedLookupData(naming, table.count, rowsDigest),
				]),
			),
			open: () => streamTextWorkbook(sheets),
		});
		rows = 1;
		declarationColumns = 0;
	};
	for (const table of [...tables].sort((a, b) =>
		a.definition.tag.localeCompare(b.definition.tag, "en"),
	)) {
		const naming = lookupWireNaming([table.definition]).tableFor(
			table.definition.id,
		);
		const shape = lookupWorkbookShape(naming);
		const width = declarationWidth(naming);
		if (width > 16384)
			shape.issue =
				"The table definition needs more columns than one workbook sheet can hold.";
		const expectedRows = streamingLookupRowsDigest();
		if (table.count + 3 > MAX_HQ_FIXTURE_WORKBOOK_ROWS)
			shape.issue =
				"The complete table exceeds CommCare HQ’s workbook row limit.";
		for await (const input of table.reader.rows()) {
			if (shape.issue) break;
			for (const column of lookupLexicalSlots(table.definition))
				for (const literal of column.values(input.row))
					if (xmlTextIssue(literal))
						throw new Error(
							"A table value contains a character that cannot be installed on a worker’s phone.",
						);
			const { row, resolve, issue } = workbookRow(input);
			if (issue) {
				shape.issue = issue;
				break;
			}
			if (resolve)
				for (const column of lookupLexicalSlots(table.definition)) {
					for (const marker of column.values(row)) {
						if (!marker.startsWith("\0")) continue;
						const value = await resolve(marker);
						if (xmlTextIssue(value))
							throw new Error(
								"A table value contains a character that cannot be installed on a worker’s phone.",
							);
						if (value.length > 32767)
							shape.issue = "A value exceeds the workbook cell limit.";
						else if (hqWouldTrimLookupText(value))
							shape.issue = "CommCare HQ would trim a value.";
						if (shape.issue) break;
					}
					if (shape.issue) break;
				}
			observeLookupWorkbookRow(shape, naming, row);
			if (shape.issue) break;
			const intended = intendedHqRow(naming, row);
			if (resolve) await expectedRows.resolvedRow(intended, resolve);
			else expectedRows.row(intended);
		}
		if (shape.issue) {
			alternatives.push({
				table,
				carrier: alternativeLookupCarrier(table.definition, shape.issue),
			});
			continue;
		}
		const add = 2 + table.count;
		// Each definition occupies a physical row as wide as the widest union
		// of declaration columns. Independently bound this retained skeleton.
		const combinedColumns = width + declarationColumns;
		if (
			rows + add > MAX_HQ_FIXTURE_WORKBOOK_ROWS ||
			combinedColumns > 16384 ||
			(group.length + 2) * combinedColumns > 128 * 1024
		)
			flush();
		declarationColumns += width;
		const expected = expectedRows.finish();
		if (expected.count !== table.count)
			throw new Error("The table changed during workbook planning.");
		group.push({ table, naming, shape, rowsDigest: expected.digest });
		rows += add;
	}
	flush();
	return { files, alternatives };
}
