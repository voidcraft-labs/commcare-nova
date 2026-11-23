import "server-only";

import { z } from "zod";
import { ownRecordValue, recordFromEntries } from "@/lib/domain/records";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { HqFixtureRow, HqLookupTable } from "./lookupTables";

const literalSheet = z.array(z.array(z.string()));
export const selectedLookupSheets = z.strictObject({
	definition: literalSheet.length(2),
	items: literalSheet.min(1),
});
type Sheets = z.infer<typeof selectedLookupSheets>;
const DELETE = "Delete(Y/N)";
export const lookupOwnerKinds = ["user", "group", "location"] as const;
export type LookupOwnerKind = (typeof lookupOwnerKinds)[number];
export interface WorkbookRowOwners {
	readonly rowId: string;
	readonly owners: Readonly<Record<LookupOwnerKind, readonly string[]>>;
}
export class LookupWorkbookMismatch extends Error {
	constructor() {
		super(
			"This workbook no longer matches the selected table. You can download just this table from its project space and try again.",
		);
	}
}
function requireMatch(condition: unknown): asserts condition {
	if (!condition) throw new LookupWorkbookMismatch();
}
function unique(values: readonly string[]) {
	return new Set(values).size === values.length;
}
function same(actual: readonly string[], expected: readonly string[]) {
	return (
		actual.length === expected.length &&
		actual.every((v, i) => v === expected[i])
	);
}

/** Row IDs are only candidates at this stage. No workbook can attest coverage
 * of an unreadable fixture list. The fallback requires independent cardinality. */
export function lookupWorkbookCandidates(sheets: Sheets) {
	const [headers, ...rows] = sheets.items;
	requireMatch(
		headers[0] === "UID" && headers[1] === DELETE && unique(headers),
	);
	const ids = rows.map((row) => row[0]);
	requireMatch(ids.every((id) => /^[0-9a-f]{32}$/.test(id)) && unique(ids));
	return ids;
}

/** HQ's selected-table _prepare_fixture writes only the indexed flags it needs.
 * Its text workbook collapses no-value and blank, and emits only the first
 * value of a propertyless field. Compare exactly what this exporter preserves;
 * leave the independent API cells and order intact. */
export function observeLookupWorkbook(
	table: HqLookupTable,
	rows: readonly HqFixtureRow[],
	sheets: Sheets,
) {
	const ids = lookupWorkbookCandidates(sheets);
	requireMatch(
		same(
			ids,
			rows.map((row) => row.id),
		),
	);
	const [headers, values] = sheets.definition;
	requireMatch(unique(headers));
	const definitionHeaders = [DELETE, "table_id", "is_global?"];
	const definitionValues = ["N", table.tag, table.isGlobal ? "yes" : "no"];
	const indexed: string[] = [];
	for (const [index, name] of table.fields.entries()) {
		const key = `field ${index + 1}`;
		definitionHeaders.push(key);
		definitionValues.push(name);
		const indexKey = `${key}: is_indexed?`;
		if (headers.includes(indexKey)) {
			definitionHeaders.push(indexKey);
			definitionValues.push("yes");
			indexed.push(name);
		}
	}
	for (const [i, name] of table.itemAttributes.entries()) {
		definitionHeaders.push(`property ${i + 1}`);
		definitionValues.push(name);
	}
	for (const [i, field] of table.fields.entries()) {
		for (const [p, prop] of (
			ownRecordValue(table.fieldProperties, field) ?? []
		).entries()) {
			definitionHeaders.push(`field ${i + 1} : property ${p + 1}`);
			definitionValues.push(prop);
		}
	}
	requireMatch(
		same(headers, definitionHeaders) && same(values, definitionValues),
	);
	const rowHeaders = sheets.items[0];
	type ReadCell = (row: HqFixtureRow) => string;
	const expectedHeaders: string[] = [];
	const readers: ReadCell[] = [];
	const column = (name: string, read: ReadCell) => {
		expectedHeaders.push(name);
		readers.push(read);
	};
	const fieldValues = (row: HqFixtureRow, field: string) => {
		requireMatch(Object.hasOwn(row.fields, field)); // HQ cannot download an absent field.
		const value = row.fields[field];
		return typeof value === "string" ? [{ value, properties: {} }] : value;
	};
	column("UID", (row) => row.id);
	column(DELETE, () => "N");
	for (const field of table.fields) {
		const props = ownRecordValue(table.fieldProperties, field) ?? [];
		if (props.length === 0) {
			column(
				`field: ${field}`,
				(row) => fieldValues(row, field)[0]?.value ?? "",
			);
			continue;
		}
		const max = rows.reduce(
			(n, row) => Math.max(n, fieldValues(row, field).length),
			0,
		);
		for (let i = 0; i < max; i++) {
			for (const prop of props)
				column(
					`${field}: ${prop} ${i + 1}`,
					(row) =>
						ownRecordValue(fieldValues(row, field)[i]?.properties, prop) ?? "",
				);
			column(
				`field: ${field} ${i + 1}`,
				(row) => fieldValues(row, field)[i]?.value ?? "",
			);
		}
	}
	for (const attr of table.itemAttributes)
		column(`property: ${attr}`, (row) => {
			const value = ownRecordValue(row.itemAttributes, attr);
			requireMatch(typeof value === "string");
			return value;
		});
	const ownerColumns = new Map<LookupOwnerKind, number[]>();
	for (const kind of lookupOwnerKinds) {
		const positions: number[] = [];
		while (
			rowHeaders[expectedHeaders.length] === `${kind} ${positions.length + 1}`
		) {
			positions.push(expectedHeaders.length);
			expectedHeaders.push(rowHeaders[expectedHeaders.length]);
		}
		ownerColumns.set(kind, positions);
	}
	requireMatch(same(rowHeaders, expectedHeaders));
	const owners: WorkbookRowOwners[] = rows.map((row, i) => {
		const cells = sheets.items[i + 1];
		requireMatch(
			cells.length === expectedHeaders.length &&
				readers.every((read, c) => read(row) === cells[c]),
		);
		const names = (kind: LookupOwnerKind) => {
			const result = (ownerColumns.get(kind) ?? [])
				.map((c) => cells[c])
				.filter(Boolean);
			requireMatch(
				unique(result) &&
					result.every(
						(name) =>
							name.length <= 255 &&
							[...name].every((c) => c.charCodeAt(0) >= 32),
					),
			);
			return result;
		};
		return {
			rowId: row.id,
			owners: {
				user: names("user"),
				group: names("group"),
				location: names("location"),
			},
		};
	});
	return {
		indexedFields: indexed,
		owners,
		workbookDigest: canonicalJsonDigest(sheets),
	};
}

export type ResolvedLookupPrincipal = {
	kind: LookupOwnerKind;
	name: string;
	id: string;
};
/** A name observed more than once must resolve to one exact identity. */
export function bindWorkbookOwners(
	observation: ReturnType<typeof observeLookupWorkbook>,
	principals: readonly ResolvedLookupPrincipal[],
) {
	const byName = new Map<string, Set<string>>();
	for (const principal of principals) {
		const key = JSON.stringify([principal.kind, principal.name]);
		const ids = byName.get(key) ?? new Set<string>();
		ids.add(principal.id);
		byName.set(key, ids);
	}
	return observation.owners.map((row) => ({
		rowId: row.rowId,
		owners: recordFromEntries(
			lookupOwnerKinds.map(
				(kind) =>
					[
						kind,
						row.owners[kind].map((name) => {
							const ids = byName.get(JSON.stringify([kind, name]));
							requireMatch(ids?.size === 1);
							return { name, id: [...ids][0] };
						}),
					] as const,
			),
		),
	}));
}
