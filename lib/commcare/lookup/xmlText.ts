import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { type ValidationError, validationError } from "../validator/errors";
import { xmlTextIssue } from "../xmlText";

/** Every export carries every defined column of the referenced tables. These
 * are mutable external rows, so refuse the export with repairable findings
 * before constructing either XML or the HQ workbook. Do not narrow Project
 * storage to a particular export format or silently rewrite a stored value. */
export function lookupXmlTextFindings(
	snapshot: LookupFixtureDataSnapshot,
): ValidationError[] {
	const findings: ValidationError[] = [];
	for (const table of snapshot.definitions) {
		const rows = snapshot.rowsByTable.get(table.id) ?? [];
		for (const column of table.columns) {
			let count = 0;
			const examples: { row: number; id: string; character: string }[] = [];
			rows.forEach((row, index) => {
				const value = row.values[column.id];
				const character =
					typeof value === "string" ? xmlTextIssue(value) : undefined;
				if (character === undefined) return;
				count++;
				if (examples.length < 5)
					examples.push({ row: index + 1, id: row.id, character });
			});
			if (count === 0) continue;
			findings.push(
				validationError(
					"LOOKUP_CELL_TEXT_UNREPRESENTABLE",
					"app",
					`The "${column.label}" column in "${table.name}" contains unsupported characters in ${count} row(s). Remove those characters in Project data so CommCare can preserve the values.`,
					{},
					{
						tableId: table.id,
						columnId: column.id,
						offendingRowCount: String(count),
						offendingRowPositions: examples.map((item) => item.row).join(","),
						offendingRowIds: examples.map((item) => item.id).join(","),
						characters: examples.map((item) => item.character).join(","),
					},
				),
			);
		}
	}
	return findings;
}
