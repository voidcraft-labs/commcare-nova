/** Independent consumer for the fixture workbook subset the capture submits.
 * Mirrors HQ's workbook_json.excel.Reader.set_field_value and
 * fixtures.upload.workbook._FixtureWorkbook.iter_tables/iter_rows. */
import * as XLSX from "xlsx";
import type { PeerRow, PeerTable } from "./targetPeer";

type Cells = Record<string, unknown>;
export type OwnerKind = "user" | "group" | "location";
export interface WorkbookOwner {
	kind: OwnerKind;
	name: string;
	id: string;
}
interface WorkbookTable {
	definition: Omit<PeerTable, "id" | "rows">;
	rows: Omit<PeerRow, "id">[];
}
function record(value: unknown): Cells {
	if (value === undefined) return Object.create(null);
	if (value === null || Array.isArray(value) || typeof value !== "object")
		throw Error("Expected a group of fixture workbook cells.");
	return value as Cells;
}
function text(value: unknown) {
	if (typeof value !== "string")
		throw Error("Expected a text fixture workbook cell.");
	return value;
}
function list(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
		throw Error("Expected numbered fixture workbook cells.");
	return value;
}
function cell(obj: Cells, header: string, raw: string) {
	const path = header.trim().split(":");
	if (path.length === 2) {
		const key = path[0].trim();
		const nested = record(obj[key]);
		obj[key] = nested;
		cell(nested, path[1], raw);
		return;
	}
	const words = header.trim().split(/\s+/);
	const key = words.length === 2 ? words[0] : header.trim();
	const value = raw.trim();
	if (words.length === 2) {
		if (!/^\d+$/.test(words[1]))
			throw Error("Invalid numbered fixture workbook column.");
		const values = list(obj[key]);
		obj[key] = values;
		if (value !== "") values.push(value);
	} else if (key.endsWith("?")) {
		if (!["yes", "true", "no", "false", ""].includes(value.toLowerCase()))
			throw Error("Invalid fixture workbook boolean.");
		obj[key.slice(0, -1)] = ["yes", "true"].includes(value.toLowerCase());
	} else {
		if (Object.hasOwn(obj, key))
			throw Error("Duplicate fixture workbook column.");
		obj[key] = value;
	}
}
function sheet(book: XLSX.WorkBook, name: string): Cells[] {
	/* SheetJS stores sheets on a plain object, so a sheet a table tagged
	 * `__proto__` names is reached through the same bracket read SheetJS's
	 * own assignment made, and only a name the workbook lists is read. */
	const page = book.SheetNames.includes(name) ? book.Sheets[name] : undefined;
	if (!page) throw Error(`Fixture workbook is missing its ${name} sheet.`);
	const [headers = [], ...rows] = XLSX.utils.sheet_to_json<string[]>(page, {
		header: 1,
		raw: false,
		defval: "",
	});
	return rows.map((row) => {
		const result: Cells = Object.create(null);
		for (const [i, header] of headers.entries())
			cell(result, header, row[i] ?? "");
		return result;
	});
}
export function readPeerWorkbook(
	bytes: Uint8Array,
	principals: readonly WorkbookOwner[],
) {
	const book = XLSX.read(bytes, { type: "array" });
	const missingOwners: string[] = [];
	const tables: WorkbookTable[] = sheet(book, "types").map((type) => {
		if (
			typeof type.table_id !== "string" ||
			!type.table_id ||
			type["Delete(Y/N)"] === "Y"
		)
			throw Error("Expected a table definition for replacement.");
		const tag = type.table_id;
		const fields = list(type.field).map((name, i) => {
			const details = record(type[`field ${i + 1}`]);
			return {
				name,
				properties: list(details.property),
				...(details.is_indexed === true && { isIndexed: true as const }),
			};
		});
		const attributes = list(type.property);
		const rows = sheet(book, tag).map((data) => {
			const dataFields = record(data.field);
			const values = Object.fromEntries(
				fields.map((field) => {
					if (!field.properties.length)
						return [
							field.name,
							[{ value: text(dataFields[field.name]), properties: {} }],
						];
					const props = record(data[field.name]);
					const occurrences = list(dataFields[field.name]);
					return [
						field.name,
						occurrences.map((value, i) => {
							const properties = Object.fromEntries(
								field.properties.map((p) => {
									const entries = list(props[p]);
									if (entries[i] === undefined)
										throw Error(
											`Missing property ${field.name}/${p} in workbook occurrence ${i + 1}.`,
										);
									return [p, entries[i]];
								}),
							);
							return { value, properties };
						}),
					];
				}),
			);
			const owners: WorkbookOwner[] = [];
			for (const kind of ["user", "group", "location"] as const) {
				const normalize = (value: string) =>
					kind === "group" ? value : value.toLowerCase();
				for (const spelling of list(data[kind])) {
					const found = principals.filter(
						(p) => p.kind === kind && normalize(p.name) === normalize(spelling),
					);
					if (found.length === 1) owners.push(found[0]);
					else missingOwners.push(`${kind}: ${spelling}`);
				}
			}
			const rowAttrs = record(data.property);
			const itemAttributes = Object.fromEntries(
				attributes.map((p) => [p, text(rowAttrs[p] ?? "")]),
			);
			return {
				fields: values,
				itemAttributes,
				...(owners.length ? { owners } : {}),
			};
		});
		return {
			definition: {
				tag,
				isGlobal: type.is_global === true,
				fields,
				itemAttributes: attributes,
				description: "",
			},
			rows,
		};
	});
	return { tables, missingOwners };
}
