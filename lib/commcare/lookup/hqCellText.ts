import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { type ValidationError, validationError } from "../validator/errors";
import { xmlTextIssue } from "../xmlText";
import { lookupLexicalSlots } from "./lexicalSlots";
import { lookupTableManagedInDomain } from "./xmlText";

// Native HQ IteratorJSONReader.set_field_value applies Python str.strip to every
// decoded string. Python whitespace includes U+0085 and excludes U+FEFF; JS trim
// does the reverse. The native workbook proof checks this exact boundary.
const HQ_WHITESPACE = new Set([
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
	0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
	0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function hqWouldTrimLookupText(value: string): boolean {
	return (
		HQ_WHITESPACE.has(value.charCodeAt(0)) ||
		HQ_WHITESPACE.has(value.charCodeAt(value.length - 1))
	);
}

/** The last sentence of `LOOKUP_CELL_TEXT_CHANGED_BY_HQ` for a table CommCare HQ manages in `domain`. */
export function changedByHqManagedRemedy(domain: string): string {
	return `CommCare HQ manages this table in ${domain}. You can take that white space out there, then refresh Nova's copy on the table's page.`;
}

/**
 * HQ-only carrier refusal: preserve storage and local fixture semantics.
 * `snapshot` holds the tables a workbook carries, and only those: a table
 * left out of every workbook is never sent, so CommCare HQ never trims it.
 */
export function lookupHqCellTextFindings(
	snapshot: LookupFixtureDataSnapshot,
): ValidationError[] {
	const findings: ValidationError[] = [];
	for (const table of snapshot.definitions) {
		const rows = snapshot.rowsByTable.get(table.id) ?? [];
		const managedInDomain = lookupTableManagedInDomain(table);
		for (const column of lookupLexicalSlots(table)) {
			let count = 0;
			const examples: { row: number; id: string }[] = [];
			rows.forEach((row, index) => {
				let changed = false;
				for (const value of column.values(row))
					if (
						xmlTextIssue(value) === undefined &&
						hqWouldTrimLookupText(value)
					) {
						changed = true;
						break;
					}
				if (!changed) return;
				count++;
				if (examples.length < 5) examples.push({ row: index + 1, id: row.id });
			});
			if (count === 0) continue;
			const remedy =
				managedInDomain === undefined
					? "Remove that whitespace in Project data."
					: changedByHqManagedRemedy(managedInDomain);
			findings.push(
				validationError(
					"LOOKUP_CELL_TEXT_CHANGED_BY_HQ",
					"app",
					`The "${column.label}" column in "${table.name}" has leading or trailing whitespace in ${count} row(s) that CommCare HQ would remove. ${remedy}`,
					{},
					{
						tableId: table.id,
						tableName: table.name,
						...column.target,
						columnLabel: column.label,
						offendingRowCount: String(count),
						offendingRowPositions: examples.map((item) => item.row).join(","),
						offendingRowIds: examples.map((item) => item.id).join(","),
						...(managedInDomain !== undefined && { managedInDomain }),
					},
				),
			);
		}
	}
	return findings;
}
