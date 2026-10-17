/**
 * Step `tile-hidden-calculated-sort`: in each list with a tile layout,
 * removes the order rule of each column hidden from Results that is
 * calculated or reads `case_id`, every column `CASE_TILE_HIDDEN_CALCULATED_SORT`
 * refuses. In a tile list a column hidden from Results is no field of the
 * list, and its order rule rides as a sort row over its property with no
 * stored column; a calculation and `case_id` have no such spelling. A hidden
 * order rule over any other property, `owner_id` and `status` included, stays.
 * The column itself stays, with its place on Details.
 *
 * One `tile-order-rule-removed` line per column, naming the column, with the
 * menu's name and `detail.shape` (`calculated` or `case_id`).
 */

import type { CutoverStep, DocumentChange } from "../transform";
import {
	columnEntity,
	menuName,
	rawCaseLists,
	writableRecord,
} from "./caseLists";

export const tileHiddenCalculatedSortStep: CutoverStep = {
	id: "tile-hidden-calculated-sort",
	apply(document) {
		const changes: DocumentChange[] = [];
		for (const list of rawCaseLists(document)) {
			if (!list.tiled) continue;
			for (const column of list.columns) {
				if (column.visibleInList !== false || column.sort === undefined) {
					continue;
				}
				const shape =
					column.kind === "calculated"
						? "calculated"
						: column.field === "case_id"
							? "case_id"
							: undefined;
				if (shape === undefined) continue;
				delete writableRecord(column).sort;
				changes.push({
					reason: "tile-order-rule-removed",
					entity: columnEntity(column),
					detail: { menu: menuName(list), shape },
				});
			}
		}
		return changes;
	},
};
