import type { LookupFixtureRow } from "@/lib/lookup/types";
import { lookupFixtureCellText } from "./cellText";
import { hqWouldTrimLookupText } from "./hqCellText";
import type { LookupTableWireNaming } from "./naming";

const DELETE_HEADER = "Delete(Y/N)";
export interface LookupWorkbookOwners {
	readonly users: readonly string[];
	readonly groups: readonly string[];
	readonly locations: readonly string[];
}
export interface LookupWorkbookShape {
	readonly occurrences: number[];
	users: number;
	groups: number;
	locations: number;
	issue?: string;
}
export function lookupWorkbookShape(
	table: LookupTableWireNaming,
): LookupWorkbookShape {
	const shape: LookupWorkbookShape = {
		occurrences: table.columns.map(() => 1),
		users: 0,
		groups: 0,
		locations: 0,
	};
	if (table.tag.toLowerCase() === "types")
		shape.issue =
			"This name is reserved for the workbook’s mandatory types sheet.";
	if (table.columns.some((column) => column.index === "unobserved"))
		shape.issue = "The indexed columns have not been verified.";
	const keyword = table.columns.find(
		(column) =>
			(column.properties?.length ?? 0) > 0 && ROW_KEYWORDS.has(column.wireName),
	);
	if (keyword !== undefined)
		shape.issue ??= `The column “${keyword.wireName}” has value details, and CommCare HQ's workbook reads a heading that starts with “${keyword.wireName}:” as its own. You can give that column another export name.`;
	return shape;
}

/**
 * The top-level keys CommCare HQ's workbook reader gives a data row. A column
 * with value details heads its details `<column>: <detail> n`, and the reader
 * (`util/workbook_json/excel.py::IteratorJSONReader.set_field_value`) nests
 * each under `<column>`, so a column named one of these lands among the row's
 * own fields, details, owners or UID (`fixtures/upload/workbook.py::
 * iter_rows`, `_process_item_field`). A column without details heads its
 * value `field: <column>` and is safe under any name.
 */
const ROW_KEYWORDS: ReadonlySet<string> = new Set([
	"field",
	"property",
	"user",
	"group",
	"location",
	"UID",
]);
const ownerKeys = ["users", "groups", "locations"] as const;

export function observeLookupWorkbookRow(
	shape: LookupWorkbookShape,
	table: LookupTableWireNaming,
	row: LookupFixtureRow,
	owners?: LookupWorkbookOwners,
): void {
	const reject = (issue: string) => {
		shape.issue ??= issue;
	};
	const lexical = (value: string) => {
		if (value.length > 32767)
			reject("A value exceeds the workbook cell limit.");
		else if (hqWouldTrimLookupText(value))
			reject("CommCare HQ would trim a value.");
	};
	for (const member of table.attributes ?? []) {
		const value = row.attributes?.[member.id];
		if (value === undefined)
			reject("A row is missing one of its declared details.");
		else lexical(value);
	}
	for (const [index, column] of table.columns.entries()) {
		const items = row.occurrences?.[column.id],
			properties = column.properties ?? [];
		if (!items && !column.repeated) {
			lexical(lookupFixtureCellText(column.dataType, row.values[column.id]));
			continue;
		}
		if (items === undefined) {
			reject("The workbook cannot retain a missing repeated field.");
			continue;
		}
		shape.occurrences[index] = Math.max(shape.occurrences[index], items.length);
		if (!properties.length && items.length !== 1)
			reject(
				"This field needs a carrier that preserves its number of occurrences.",
			);
		for (const item of items) {
			lexical(item.text);
			if (properties.length && item.text === "")
				reject("CommCare HQ would drop an empty occurrence.");
			for (const member of properties) {
				const value = item.properties[member.id];
				if (value === undefined || value === "")
					reject(
						"CommCare HQ cannot align missing or empty occurrence details in this workbook.",
					);
				else lexical(value);
			}
		}
	}
	if (table.distribution === "assigned" && owners === undefined)
		reject(
			"This row needs verified assignments in the destination project space.",
		);
	for (const key of ownerKeys) {
		const values = owners?.[key] ?? [];
		shape[key] = Math.max(shape[key], values.length);
		for (const value of values) {
			if (!value) reject("A row assignment has no verified destination name.");
			lexical(value);
		}
	}
	const width =
		2 +
		(table.attributes?.length ?? 0) +
		shape.users +
		shape.groups +
		shape.locations +
		table.columns.reduce(
			(count, col, i) =>
				count +
				(col.properties?.length
					? shape.occurrences[i] * (col.properties.length + 1)
					: 1),
			0,
		);
	if (width > 16384)
		reject("The table needs more columns than one workbook sheet can hold.");
}
export function lookupWorkbookTypesRows(
	tables: readonly LookupTableWireNaming[],
): string[][] {
	const maxColumns = tables.reduce((n, t) => Math.max(n, t.columns.length), 0);
	const maxAttributes = tables.reduce(
		(n, t) => Math.max(n, t.attributes?.length ?? 0),
		0,
	);
	const columns = Array.from({ length: maxColumns }, (_, i) => ({
		indexed: tables.some((t) => t.columns[i]?.index === "indexed"),
		properties: tables.reduce(
			(n, t) => Math.max(n, t.columns[i]?.properties?.length ?? 0),
			0,
		),
	}));
	const names = (prefix: string, count: number) =>
		Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
	const header = [
		DELETE_HEADER,
		"table_id",
		"is_global?",
		...columns.flatMap(({ indexed }, i) => [
			`field ${i + 1}`,
			...(indexed ? [`field ${i + 1}: is_indexed?`] : []),
		]),
		...names("property", maxAttributes),
		...columns.flatMap(({ properties }, i) =>
			names(`field ${i + 1} : property`, properties),
		),
	];
	if (header.length > 16384)
		throw new Error(
			"The table definitions need more columns than one workbook sheet can hold.",
		);
	return [
		header,
		...tables.map((t) => [
			"N",
			t.tag,
			t.distribution === "assigned" ? "no" : "yes",
			...columns.flatMap(({ indexed }, i) => [
				t.columns[i]?.wireName ?? "",
				...(indexed ? [t.columns[i]?.index === "indexed" ? "yes" : "no"] : []),
			]),
			...Array.from(
				{ length: maxAttributes },
				(_, i) => t.attributes?.[i]?.wireName ?? "",
			),
			...columns.flatMap(({ properties }, i) =>
				Array.from(
					{ length: properties },
					(_, j) => t.columns[i]?.properties?.[j]?.wireName ?? "",
				),
			),
		]),
	];
}
export function lookupWorkbookDataHeader(
	table: LookupTableWireNaming,
	shape: LookupWorkbookShape,
): string[] {
	const cells = ["UID", DELETE_HEADER];
	for (const [i, column] of table.columns.entries()) {
		const properties = column.properties ?? [];
		if (!properties.length) {
			cells.push(`field: ${column.wireName}`);
			continue;
		}
		for (let n = 1; n <= shape.occurrences[i]; n++) {
			for (const property of properties)
				cells.push(`${column.wireName}: ${property.wireName} ${n}`);
			cells.push(`field: ${column.wireName} ${n}`);
		}
	}
	for (const attr of table.attributes ?? [])
		cells.push(`property: ${attr.wireName}`);
	for (const [key, prefix] of [
		["users", "user"],
		["groups", "group"],
		["locations", "location"],
	] as const)
		for (let n = 1; n <= shape[key]; n++) cells.push(`${prefix} ${n}`);
	return cells;
}
export function lookupWorkbookDataRow(
	table: LookupTableWireNaming,
	shape: LookupWorkbookShape,
	row: LookupFixtureRow,
	owners?: LookupWorkbookOwners,
): string[] {
	if (shape.issue) throw new Error(shape.issue);
	if (table.distribution === "assigned" && !owners)
		throw new Error(
			"This workbook needs verified destination row assignments.",
		);
	const cells = ["", "N"];
	for (const [i, column] of table.columns.entries()) {
		const items = row.occurrences?.[column.id],
			properties = column.properties ?? [];
		if (!properties.length) {
			cells.push(
				items?.[0]?.text ??
					lookupFixtureCellText(column.dataType, row.values[column.id]),
			);
			continue;
		}
		for (let n = 0; n < shape.occurrences[i]; n++) {
			const item = items?.[n];
			for (const property of properties)
				cells.push(item?.properties[property.id] ?? "");
			cells.push(item?.text ?? "");
		}
	}
	for (const attr of table.attributes ?? [])
		cells.push(row.attributes?.[attr.id] ?? "");
	for (const key of ownerKeys)
		for (let n = 0; n < shape[key]; n++) cells.push(owners?.[key][n] ?? "");
	return cells;
}
