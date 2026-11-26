import { v5 } from "uuid";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import type { Expression } from "./expression/types";
import { makeTranslationUnitId } from "./localization";
import { asUuid, type Uuid } from "./uuid";

/** An existing document may predate row identities. The column and its native
 * comparison identify every admitted historical row without using its position. */
export interface CaseMappingRow {
	readonly uuid?: Uuid;
	readonly value?: string;
	readonly when?: Expression;
	readonly match?: "exact";
}

export function caseMappingComparison(row: CaseMappingRow): string {
	return row.when
		? canonicalJsonText(["condition", row.when])
		: JSON.stringify([row.match ?? "selected", row.value]);
}

/** Conditions are addressable rows and may overlap or be equivalent.
 * Shorthand saved values keep their distinct comparison/value pairs. */
export function caseMappingRowKey(row: CaseMappingRow): string {
	return row.when && row.uuid
		? JSON.stringify(["rule", row.uuid])
		: caseMappingComparison(row);
}

export function uniqueCaseMappingRows(
	rows: readonly CaseMappingRow[],
): boolean {
	const ids = rows.flatMap((row) => (row.uuid ? [row.uuid] : []));
	return (
		new Set(ids).size === ids.length &&
		new Set(rows.map(caseMappingRowKey)).size === rows.length
	);
}
export function caseMappingRowUuid(
	columnUuid: Uuid,
	row: CaseMappingRow,
): Uuid {
	if (row.when && !row.uuid)
		return asUuid(v5(caseMappingComparison(row), columnUuid));
	return (
		row.uuid ??
		asUuid(
			v5(
				JSON.stringify(["case-mapping-v1", row.match ?? "selected", row.value]),
				columnUuid,
			),
		)
	);
}

export function caseMappingTextUnit(
	columnUuid: Uuid,
	row: CaseMappingRow,
	role: "mapping" | "image-description",
) {
	return row.uuid === undefined && !row.when
		? makeTranslationUnitId("column", columnUuid, role, row.value ?? "")
		: makeTranslationUnitId(
				"column",
				columnUuid,
				"row",
				caseMappingRowUuid(columnUuid, row),
				role,
			);
}
