/**
 * Rule: the case list's tile grid is a layout a worker can actually
 * read — every cell fits the grid, no two cells cover the same
 * square, and every field the Results detail carries has a place to
 * sit.
 *
 * The four findings split along two axes, because they have two
 * different repairs and two different lifetimes.
 *
 * **Geometry** (`…_CELL_OUT_OF_GRID`, `…_CELLS_OVERLAP`) is checked on
 * every stored cell whether or not the tile layout is currently on.
 * Turning tiles off KEEPS the placements — an author who tries a tile
 * and switches back should not lose the layout they drew — so the
 * cells stay live data, and validating them continuously is what
 * guarantees that switching tiles back on is always accepted. Checking
 * only while the layout is on would let a rejected geometry hide in a
 * disabled layout and surface as an unexplained refusal later.
 *
 * **Coverage** (`…_COLUMN_NOT_PLACED`, `…_SORT_COLUMN_NOT_PLACED`) is
 * checked only while the layout is on, because it is a statement about
 * what the Results detail emits. A tile detail has no off-screen
 * column: every `<field>` the detail carries becomes a cell div in the
 * Web Apps renderer, and a field with no `<style>` gets no
 * `grid-area`, so CSS grid auto-places it wherever there is room —
 * typically an unstyled extra row under the tile showing a raw value.
 * Requiring a placement is what keeps that from shipping.
 *
 * Two things this rule deliberately does NOT do:
 *
 *   - It does not reject a cell on a column that is hidden from
 *     Results and drives no ordering. That column emits nothing, its
 *     cell is inert, and keeping it means unhiding the column restores
 *     the placement the author drew.
 *   - It does not reject a cell when the layout is off, for the same
 *     reason.
 *
 * The 12-column cap is Nova's own. CommCare Core has no column-count
 * constant — `commcare-core/.../org/commcare/suite/model/Detail.java::Detail.getMaxWidthHeight`
 * derives the grid extent from whatever the fields occupy, and the Web
 * Apps renderer builds `repeat(maxWidth, 1fr)` from it
 * (`commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::buildCellGridStyle`),
 * so a 30-column tile renders. The 12 comes from HQ's own parity
 * assertion
 * (`commcare-hq/corehq/apps/app_manager/tests/test_suite_case_tiles.py::SuiteCaseTilesTest.test_case_tile_column_count`,
 * "Keeps the number of columns in parity with what mobile allows"),
 * which only lints HQ's two shipped named templates and never sees a
 * `custom` tile — HQ has no server-side grid validation at all. Nova
 * enforces it here so a Nova tile is a layout every CommCare client
 * renders the same way.
 */

import {
	type BlueprintDoc,
	type Column,
	type Module,
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	type TileCell,
	tileCellBottomEdge,
	tileCellRightEdge,
	tileCellsOverlap,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function caseTileLayout(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (config === undefined) return [];
	const columns = config.columns;
	if (columns.length === 0) return [];

	const errors: ValidationError[] = [];
	const location = { moduleUuid, moduleName: mod.name };

	for (const [index, column] of columns.entries()) {
		const cell = column.tile;
		if (cell === undefined) continue;
		const right = tileCellRightEdge(cell);
		const bottom = tileCellBottomEdge(cell);
		if (right <= TILE_GRID_COLUMNS && bottom <= TILE_GRID_ROWS) continue;
		errors.push(
			validationError(
				"CASE_LIST_TILE_CELL_OUT_OF_GRID",
				"module",
				`${describeColumn(column, index)} on the "${mod.name}" case tile runs past the edge of the grid: it starts at column ${cell.x + 1}, row ${cell.y + 1} and spans ${cell.width} × ${cell.height}, which reaches column ${right} and row ${bottom}. The tile is ${TILE_GRID_COLUMNS} columns by ${TILE_GRID_ROWS} rows. Move the field left or up, or make it narrower or shorter, so it ends inside the grid.`,
				location,
				{
					columnUuid: column.uuid,
					columnIndex: String(index),
					x: String(cell.x),
					y: String(cell.y),
					width: String(cell.width),
					height: String(cell.height),
				},
			),
		);
	}

	// Overlap is checked among the cells that would actually render —
	// the Results-visible ones. A hidden column's cell is not on screen,
	// so two hidden cells sharing a square is not something a worker can
	// see; unhiding one of them is what surfaces the conflict, and at
	// that moment this rule fires against a change the author just made.
	const placed = columns
		.map((column, index) => ({ column, index }))
		.filter(
			(entry) =>
				entry.column.tile !== undefined && entry.column.visibleInList !== false,
		);
	for (let a = 0; a < placed.length; a++) {
		for (let b = a + 1; b < placed.length; b++) {
			const first = placed[a];
			const second = placed[b];
			// Both cells are present — the filter above proved it.
			if (
				!tileCellsOverlap(
					first.column.tile as TileCell,
					second.column.tile as TileCell,
				)
			) {
				continue;
			}
			errors.push(
				validationError(
					"CASE_LIST_TILE_CELLS_OVERLAP",
					"module",
					`${describeColumn(first.column, first.index)} and ${describeColumn(second.column, second.index)} sit on top of each other on the "${mod.name}" case tile. Two fields cannot share the same square — one would be drawn over the other. Move or resize one of them so they no longer cover the same part of the grid.`,
					location,
					{
						firstUuid: first.column.uuid,
						firstIndex: String(first.index),
						secondUuid: second.column.uuid,
						secondIndex: String(second.index),
					},
				),
			);
		}
	}

	if (config.tile === undefined) return errors;

	for (const [index, column] of columns.entries()) {
		if (column.tile !== undefined) continue;
		if (column.visibleInList !== false) {
			errors.push(
				validationError(
					"CASE_LIST_TILE_COLUMN_NOT_PLACED",
					"module",
					`${describeColumn(column, index)} is shown in the "${mod.name}" case list but has no place on the tile. Every field a tile shows needs a square to sit in, or it lands wherever the grid happens to have room. Give it a place on the tile, or hide it from the case list.`,
					location,
					{ columnUuid: column.uuid, columnIndex: String(index) },
				),
			);
			continue;
		}
		if (column.sort !== undefined) {
			errors.push(
				validationError(
					"CASE_LIST_TILE_SORT_COLUMN_NOT_PLACED",
					"module",
					`${describeColumn(column, index)} orders the "${mod.name}" case list but is hidden and has no place on the tile. Hiding a field from a tile is not possible the way it is for a row of columns — the case list still has to carry the field to order by it, and an unplaced field lands wherever the grid has room. Give it a place on the tile, or take it out of the case list's order.`,
					location,
					{ columnUuid: column.uuid, columnIndex: String(index) },
				),
			);
		}
	}

	return errors;
}

/**
 * Compose a short author-facing handle for a column referenced from an
 * error message. Mirrors `sortPriorityUniqueness`'s helper: calculated
 * columns have no `field`, so `header` is the informative slot when
 * present.
 */
function describeColumn(column: Column, index: number): string {
	const header = column.header.trim();
	if (header.length > 0) return `"${header}" (column #${index + 1})`;
	if (column.kind !== "calculated" && column.field.trim().length > 0) {
		return `"${column.field}" (column #${index + 1})`;
	}
	return `Column #${index + 1}`;
}
