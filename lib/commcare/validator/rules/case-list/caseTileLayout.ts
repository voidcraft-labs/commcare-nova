/**
 * Rule: the case list's tile grid is a layout a worker can actually
 * read — every cell fits the grid, no two cells cover the same
 * square, and every field the Results detail carries has a place to
 * sit.
 *
 * The three findings split along two axes, because they have two
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
 * **Coverage** (`…_COLUMN_NOT_PLACED`) is checked only while the layout
 * is on, because it is a statement about what the Results detail emits.
 * It applies to columns the tile SHOWS, and to those alone.
 *
 * Three things this rule deliberately does NOT do:
 *
 *   - It does not reject a cell on a column that is hidden from
 *     Results. That column's cell is inert, and keeping it means
 *     unhiding the column restores the placement the author drew.
 *   - It does not reject a cell when the layout is off, for the same
 *     reason.
 *   - **It does not require a hidden, order-driving column to be
 *     placed.** Sorting by something a worker doesn't see is an
 *     ordinary case-list pattern and it works unchanged on a tile.
 *     Nova emits such a column as the zero-width sort carrier
 *     (`<header width="0">` + `<template width="0">` + `<sort>`) with
 *     no `<style>`, and CommCare treats that shape as its own reserved
 *     hidden-field spelling: `commcare-core/.../org/commcare/suite/model/Style.java::Style(DetailField)`
 *     carries the comment "For width, default to -1 since '0' is
 *     reserved for hidden (Search) fields", and both tile templates
 *     (`commcare-hq/corehq/apps/cloudcare/templates/cloudcare/partials/case_list/tile_item.html`
 *     and `tile_grouped_item.html`) branch on `styles[index].widthHint === 0`
 *     to render the value inside a `d-none` wrapper. The surrounding
 *     cell div carries a `-grid-style-N` class that
 *     `views.js::buildCellLayout` never emits a rule for, and
 *     `formplayer-common/grid.scss::.box` sets only colors and font
 *     size, so the div is an empty zero-size grid item. Nothing renders,
 *     and the ordering still applies because the runtime sorts entities
 *     before it draws them.
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
	orderedColumns,
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
	// In RESULTS order: the tile IS the Results screen, so "column #3" has to
	// count the way the author sees the fields laid out, and the overlapping
	// pair below has to read left-to-right the same way.
	const columns = orderedColumns(config, "list");
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
		if (column.visibleInList === false) continue;
		errors.push(
			validationError(
				"CASE_LIST_TILE_COLUMN_NOT_PLACED",
				"module",
				`${describeColumn(column, index)} is shown in the "${mod.name}" case list but has no place on the tile. Every field a tile shows needs a square to sit in. Give it a place on the tile, or hide it from the case list.`,
				location,
				{ columnUuid: column.uuid, columnIndex: String(index) },
			),
		);
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
