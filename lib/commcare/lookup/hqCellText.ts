import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { type ValidationError, validationError } from "../validator/errors";
import { xmlTextIssue } from "../xmlText";

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

/** HQ-only carrier refusal: preserve storage and local fixture semantics. */
export function lookupHqCellTextFindings(
	snapshot: LookupFixtureDataSnapshot,
): ValidationError[] {
	const findings: ValidationError[] = [];
	for (const table of snapshot.definitions) {
		const rows = snapshot.rowsByTable.get(table.id) ?? [];
		for (const column of table.columns) {
			let count = 0;
			const examples: { row: number; id: string }[] = [];
			rows.forEach((row, index) => {
				const value = row.values[column.id];
				// XML-invalid values already have a more fundamental, all-carrier finding.
				if (
					typeof value !== "string" ||
					xmlTextIssue(value) !== undefined ||
					!hqWouldTrimLookupText(value)
				)
					return;
				count++;
				if (examples.length < 5) examples.push({ row: index + 1, id: row.id });
			});
			if (count === 0) continue;
			findings.push(
				validationError(
					"LOOKUP_CELL_TEXT_CHANGED_BY_HQ",
					"app",
					`The "${column.label}" column in "${table.name}" has leading or trailing whitespace in ${count} row(s) that CommCare HQ would remove. Remove that whitespace in Project data, or download the app to preserve these values.`,
					{},
					{
						tableId: table.id,
						tableName: table.name,
						columnId: column.id,
						columnLabel: column.label,
						offendingRowCount: String(count),
						offendingRowPositions: examples.map((item) => item.row).join(","),
						offendingRowIds: examples.map((item) => item.id).join(","),
					},
				),
			);
		}
	}
	return findings;
}
