/**
 * Step `tile-cells`: fills `horizontalAlign: "left"`, `verticalAlign: "top"`
 * and `fontSize: "medium"` on every tile cell missing one, the values
 * CommCare HQ's Case List save writes into a cell that holds none. The
 * schema requires the three of every cell, so the step walks every column
 * of every list and fills wherever a column holds a cell, whether or not
 * the list has a tile layout: a column keeps its cell when the layout is
 * switched off.
 *
 * The values are frozen here, as the cutover ran, not read from the tree's
 * defaults.
 *
 * One `tile-cell-defaults-set` line per menu whose list has a tile layout
 * and a cell the step filled. A list with no tile layout gets no line: no
 * runtime reads its cells.
 */

import type { CutoverStep, DocumentChange } from "../transform";
import { menuEntity, rawCaseLists, writableRecord } from "./caseLists";
import { isRecord } from "./relativePaths";

const CELL_DEFAULTS = {
	horizontalAlign: "left",
	verticalAlign: "top",
	fontSize: "medium",
} as const;

export const tileCellsStep: CutoverStep = {
	id: "tile-cells",
	apply(document) {
		const changes: DocumentChange[] = [];
		for (const list of rawCaseLists(document)) {
			let filled = false;
			for (const column of list.columns) {
				const cell = column.tile;
				if (!isRecord(cell)) continue;
				const writable = writableRecord(cell);
				for (const [slot, value] of Object.entries(CELL_DEFAULTS)) {
					if (writable[slot] !== undefined) continue;
					writable[slot] = value;
					filled = true;
				}
			}
			if (filled && list.tiled) {
				changes.push({
					reason: "tile-cell-defaults-set",
					entity: menuEntity(list),
				});
			}
		}
		return changes;
	},
};
