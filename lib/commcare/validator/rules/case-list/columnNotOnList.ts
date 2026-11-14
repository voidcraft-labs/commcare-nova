/**
 * Rule: a column that is not on the list (`Column.notOnList`) is hidden from
 * Results and carries no order rule.
 *
 * A column that is not on the list is no field of the short detail in either
 * layout (`lib/domain/caseListOrder.ts`, rule 1): the case's detail alone
 * holds it. Two pairings would contradict that, and each is refused with its
 * own reason:
 *
 *   - `shown`: `notOnList` beside a `visibleInList` that is not `false`. One
 *     state has one stored form, so every reader that asks whether Results
 *     shows a column reads `visibleInList` and is right.
 *   - `sorted`: `notOnList` beside a `sort`. An order rule on a column the
 *     list does not hold would reach the wire as a carrier field, which the
 *     list's filter matches (`caseListOrder.ts`, rule 5), so the column would
 *     be on the list after all.
 *
 * A column that is not on the list and is hidden from Details too is on no
 * screen and no wire, and is admitted, as a column hidden from both screens
 * is. A tile cell on such a column is dormant, as on any column hidden from
 * Results.
 */

import type { BlueprintDoc, Column, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";
import { caseListColumnLabel } from "./shared";

/** Why a column that is not on the list is refused, or `undefined`. */
function refusedReason(column: Column): "shown" | "sorted" | undefined {
	if (column.notOnList !== true) return undefined;
	if (column.visibleInList !== false) return "shown";
	return column.sort === undefined ? undefined : "sorted";
}

/** The column's header, or its property where the header is blank; a
 *  calculated column with no header is the builder's "Calculated value". */
function headerOf(column: Column): string {
	const header = column.header.trim();
	if (header.length > 0) return header;
	return column.kind === "calculated" ? "Calculated value" : column.field;
}

/**
 * The rule's sentence for a column refused with `reason`, which a tool's
 * caller reads. The tools that write a column refuse the pairing before
 * staging in these same words.
 */
export function columnNotOnListMessage(
	column: Column,
	reason: "shown" | "sorted",
): string {
	const header = headerOf(column);
	return reason === "shown"
		? `The "${header}" column is set to show on Results and also to stay off the list. A column that is off the list is hidden on Results. You can hide it on Results, or put it back on the list.`
		: `The "${header}" column isn't on the list, so the list can't sort by it. You can remove its sort rule, or keep the column on the list as a hidden one, which the list's search then matches.`;
}

export function columnNotOnList(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config === undefined) return [];
	const errors: ValidationError[] = [];
	for (
		let columnIndex = 0;
		columnIndex < config.columns.length;
		columnIndex++
	) {
		const column = config.columns[columnIndex];
		const reason = refusedReason(column);
		if (reason === undefined) continue;
		errors.push(
			validationError(
				"CASE_LIST_COLUMN_NOT_ON_LIST_INVALID",
				"module",
				columnNotOnListMessage(column, reason),
				{ moduleUuid, moduleName: mod.name },
				{
					slot: `caseListConfig.columns[${columnIndex}].notOnList`,
					columnIndex: String(columnIndex),
					columnUuid: column.uuid,
					columnLabel: caseListColumnLabel(column),
					reason,
				},
			),
		);
	}
	return errors;
}
