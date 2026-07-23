/**
 * Row-dependent validity for lookup-backed select sources.
 *
 * The rows-free commit validator proves identity and typing; only the export
 * boundary sees rows, so this module owns the checks a definition snapshot
 * cannot prove. Per the S05 contract a select source rejects, across the
 * COMPLETE source table (never merely the filtered result):
 *
 * - a missing or empty value cell, and any value containing XML whitespace
 *   (`U+0009`, `U+000A`, `U+000D`, `U+0020`) — a select value is an XML
 *   token, and a multi-select answer joins tokens with spaces;
 * - duplicate values after scalar lexicalization, by exact code-point
 *   equality — no trim, case folding, or Unicode normalization; and
 * - a missing label or one whose lexicalized value trims to empty. The check
 *   never alters the emitted label; duplicate labels stay valid.
 *
 * Findings aggregate per select and check kind so a 5,000-row table cannot
 * flood the verdict; details carry the offending 1-based row positions
 * (capped) alongside exact row ids.
 */

import {
	collectLookupOptionsSourceCarriers,
	type LookupOptionsSourceCarrier,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type {
	LookupColumn,
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { type ValidationError, validationError } from "../validator/errors";
import { lookupFixtureCellText } from "./cellText";

const XML_WHITESPACE = /[\t\n\r ]/;
const MAX_REPORTED_POSITIONS = 5;

interface RowOffence {
	readonly position: number;
	readonly rowId: string;
}

function offenceDetails(offences: readonly RowOffence[]): {
	offendingRowCount: string;
	offendingRowPositions: string;
	offendingRowIds: string;
} {
	const reported = offences.slice(0, MAX_REPORTED_POSITIONS);
	return {
		offendingRowCount: String(offences.length),
		offendingRowPositions: reported.map((o) => String(o.position)).join(","),
		offendingRowIds: reported.map((o) => o.rowId).join(","),
	};
}

function sourceFindings(args: {
	readonly carrier: LookupOptionsSourceCarrier;
	readonly table: LookupTableDefinition;
	readonly rows: readonly LookupFixtureRow[];
	readonly valueColumn: LookupColumn;
	readonly labelColumn: LookupColumn;
}): ValidationError[] {
	const { carrier, table, rows, valueColumn, labelColumn } = args;
	const blankValues: RowOffence[] = [];
	const whitespaceValues: RowOffence[] = [];
	const blankLabels: RowOffence[] = [];
	const positionsByValue = new Map<string, RowOffence[]>();

	rows.forEach((row, index) => {
		const offence = { position: index + 1, rowId: row.id };
		const value = lookupFixtureCellText(
			valueColumn.dataType,
			row.values[valueColumn.id],
		);
		if (value === "") {
			blankValues.push(offence);
		} else if (XML_WHITESPACE.test(value)) {
			whitespaceValues.push(offence);
		} else {
			const seen = positionsByValue.get(value);
			if (seen === undefined) positionsByValue.set(value, [offence]);
			else seen.push(offence);
		}
		const label = lookupFixtureCellText(
			labelColumn.dataType,
			row.values[labelColumn.id],
		);
		if (label.trim().length === 0) blankLabels.push(offence);
	});

	const duplicateOffences: RowOffence[] = [];
	const duplicateValues: string[] = [];
	for (const [value, offences] of positionsByValue) {
		if (offences.length < 2) continue;
		duplicateValues.push(value);
		duplicateOffences.push(...offences);
	}

	const baseDetails = {
		tableId: table.id as string,
		tableTag: table.tag,
		tableName: table.name,
	};
	const location = {
		...carrier.location,
		field: "optionsSource",
	};
	const errors: ValidationError[] = [];
	if (blankValues.length > 0) {
		errors.push(
			validationError(
				"LOOKUP_SELECT_SOURCE_VALUE_BLANK",
				carrier.location.scope,
				`Field "${carrier.fieldId}" builds its choices from lookup table "${table.name}", using "${valueColumn.label}" as the saved value, but ${blankValues.length} row(s) leave that column blank (row ${blankValues[0].position} first). Fill in those rows or choose another value column.`,
				location,
				{
					...baseDetails,
					columnId: valueColumn.id as string,
					columnLabel: valueColumn.label,
					...offenceDetails(blankValues),
				},
			),
		);
	}
	if (whitespaceValues.length > 0) {
		errors.push(
			validationError(
				"LOOKUP_SELECT_SOURCE_VALUE_WHITESPACE",
				carrier.location.scope,
				`Field "${carrier.fieldId}" builds its choices from lookup table "${table.name}", using "${valueColumn.label}" as the saved value, but ${whitespaceValues.length} row(s) contain spaces, tabs, or line breaks there (row ${whitespaceValues[0].position} first). A saved choice value cannot contain whitespace — tidy those rows or choose another value column.`,
				location,
				{
					...baseDetails,
					columnId: valueColumn.id as string,
					columnLabel: valueColumn.label,
					...offenceDetails(whitespaceValues),
				},
			),
		);
	}
	if (duplicateOffences.length > 0) {
		errors.push(
			validationError(
				"LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE",
				carrier.location.scope,
				`Field "${carrier.fieldId}" builds its choices from lookup table "${table.name}", using "${valueColumn.label}" as the saved value, but ${duplicateValues.length} value(s) appear in more than one row (for example "${duplicateValues[0]}"). Make the values unique or choose another value column.`,
				location,
				{
					...baseDetails,
					columnId: valueColumn.id as string,
					columnLabel: valueColumn.label,
					duplicateValueCount: String(duplicateValues.length),
					firstDuplicateValue: duplicateValues[0],
					...offenceDetails(duplicateOffences),
				},
			),
		);
	}
	if (blankLabels.length > 0) {
		errors.push(
			validationError(
				"LOOKUP_SELECT_SOURCE_LABEL_BLANK",
				carrier.location.scope,
				`Field "${carrier.fieldId}" builds its choices from lookup table "${table.name}", using "${labelColumn.label}" as the label, but ${blankLabels.length} row(s) leave that column blank (row ${blankLabels[0].position} first). Fill in those rows or choose another label column.`,
				location,
				{
					...baseDetails,
					columnId: labelColumn.id as string,
					columnLabel: labelColumn.label,
					...offenceDetails(blankLabels),
				},
			),
		);
	}
	return errors;
}

/**
 * Validate every persisted lookup-backed select against the fixture
 * snapshot's complete rows. A source whose table or columns are absent from
 * the snapshot is skipped here — the structural validator already owns that
 * finding, and emission never runs while it stands.
 */
export function lookupSelectSourceRowFindings(
	doc: BlueprintDoc,
	snapshot: LookupFixtureDataSnapshot,
): ValidationError[] {
	const tablesById = new Map(
		snapshot.definitions.map((table) => [table.id, table]),
	);
	const errors: ValidationError[] = [];
	for (const carrier of collectLookupOptionsSourceCarriers(doc)) {
		const table = tablesById.get(carrier.source.tableId);
		if (table === undefined) continue;
		const rows = snapshot.rowsByTable.get(carrier.source.tableId);
		if (rows === undefined) continue;
		const valueColumn = table.columns.find(
			(column) => column.id === carrier.source.valueColumnId,
		);
		const labelColumn = table.columns.find(
			(column) => column.id === carrier.source.labelColumnId,
		);
		if (valueColumn === undefined || labelColumn === undefined) continue;
		errors.push(
			...sourceFindings({ carrier, table, rows, valueColumn, labelColumn }),
		);
	}
	return errors;
}
