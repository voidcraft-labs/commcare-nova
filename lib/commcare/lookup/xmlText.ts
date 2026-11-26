import type {
	LookupFixtureDataSnapshot,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { type ValidationError, validationError } from "../validator/errors";
import { xmlTextIssue } from "../xmlText";
import { lookupLexicalSlots } from "./lexicalSlots";

/**
 * The project space that manages a table, for a table CommCare HQ manages;
 * `undefined` for a table Nova manages. A finding about such a table cannot
 * send a person to edit it in Project data, which refuses every edit to it,
 * so its last sentence names where the table is changed instead, and its
 * details carry the project space as `managedInDomain`.
 */
export function lookupTableManagedInDomain(
	table: Pick<LookupTableDefinition, "hq">,
): string | undefined {
	return table.hq?.managedBy === "commcare-hq" ? table.hq.domain : undefined;
}

/** The last sentence of `LOOKUP_CELL_TEXT_UNREPRESENTABLE` for a table CommCare HQ manages in `domain`. */
export function unrepresentableManagedRemedy(domain: string): string {
	return `CommCare HQ manages this table in ${domain}. You can take those characters out there, then refresh Nova's copy on the table's page.`;
}

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
		const managedInDomain = lookupTableManagedInDomain(table);
		for (const column of lookupLexicalSlots(table)) {
			let count = 0;
			const examples: { row: number; id: string; character: string }[] = [];
			rows.forEach((row, index) => {
				let character: string | undefined;
				for (const value of column.values(row)) {
					character = xmlTextIssue(value);
					if (character !== undefined) break;
				}
				if (character === undefined) return;
				count++;
				if (examples.length < 5)
					examples.push({ row: index + 1, id: row.id, character });
			});
			if (count === 0) continue;
			const remedy =
				managedInDomain === undefined
					? "Remove those characters in Project data so CommCare can preserve the values."
					: unrepresentableManagedRemedy(managedInDomain);
			findings.push(
				validationError(
					"LOOKUP_CELL_TEXT_UNREPRESENTABLE",
					"app",
					`The "${column.label}" column in "${table.name}" contains unsupported characters in ${count} row(s). ${remedy}`,
					{},
					{
						tableId: table.id,
						tableName: table.name,
						...column.target,
						columnLabel: column.label,
						offendingRowCount: String(count),
						offendingRowPositions: examples.map((item) => item.row).join(","),
						offendingRowIds: examples.map((item) => item.id).join(","),
						characters: examples.map((item) => item.character).join(","),
						...(managedInDomain !== undefined && { managedInDomain }),
					},
				),
			);
		}
	}
	return findings;
}
