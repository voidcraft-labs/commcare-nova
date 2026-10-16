/**
 * Step `date-patterns`: in every date column of every list, replaces each
 * straight apostrophe (`'`) in the pattern with a curved one (`’`), so the
 * document passes `CASE_LIST_DATE_PATTERN_APOSTROPHE`. CommCare HQ writes a
 * date column's pattern unescaped between straight apostrophes into the
 * column's expression, so a straight one ends the literal early and the app
 * no longer installs from HQ. The curved one is a character like any other
 * to every runtime's formatter.
 *
 * The step reads one string and writes one string: it changes no column's
 * kind, adds no column and touches no order rule, so it cannot make a
 * document the gate refuses.
 *
 * One `date-pattern-apostrophe-replaced` line per column, naming the column,
 * with the menu's name.
 */

import type { CutoverStep, DocumentChange } from "../transform";
import {
	columnEntity,
	menuName,
	rawCaseLists,
	writableRecord,
} from "./caseLists";

const STRAIGHT_APOSTROPHE = "'";
const CURVED_APOSTROPHE = "’";

export const datePatternsStep: CutoverStep = {
	id: "date-patterns",
	apply(document) {
		const changes: DocumentChange[] = [];
		for (const list of rawCaseLists(document)) {
			for (const column of list.columns) {
				if (column.kind !== "date" || typeof column.pattern !== "string") {
					continue;
				}
				if (!column.pattern.includes(STRAIGHT_APOSTROPHE)) continue;
				writableRecord(column).pattern = column.pattern.replaceAll(
					STRAIGHT_APOSTROPHE,
					CURVED_APOSTROPHE,
				);
				changes.push({
					reason: "date-pattern-apostrophe-replaced",
					entity: columnEntity(column),
					detail: { menu: menuName(list) },
				});
			}
		}
		return changes;
	},
};
