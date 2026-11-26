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
 *   - It does not require placement on a column hidden from Results;
 *     stored placements still have to fit the grid.
 *   - It does not require placement when the layout is off.
 *   - **It does not require a hidden, order-driving column to be
 *     placed.** Sorting by something a worker doesn't see is an
 *     ordinary case-list pattern and it works unchanged on a tile. A
 *     column hidden from Results is no field of the tile's short detail
 *     (`lib/domain/caseListOrder.ts::caseListOrderPlan`, rule 1), so its
 *     order rule reaches CommCare HQ as a sort row with no stored column,
 *     and HQ appends the hidden field that carries it
 *     (`corehq/apps/app_manager/util.py::create_temp_sort_column`). No
 *     Case List save can give that field a cell, because it is never
 *     stored, and the build writes no `<style>` for it, so it is CommCare's
 *     own reserved hidden-field spelling (`<header width="0">` +
 *     `<template width="0">` + `<sort>`):
 *     `commcare-core/.../org/commcare/suite/model/Style.java::Style(DetailField)`
 *     carries the comment "For width, default to -1 since '0' is
 *     reserved for hidden (Search) fields", and both tile templates
 *     (`commcare-hq/corehq/apps/cloudcare/templates/cloudcare/partials/case_list/tile_item.html`
 *     and `tile_grouped_item.html`) branch on `styles[index].widthHint === 0`
 *     to render the value inside a `d-none` wrapper. Nothing renders, and
 *     the ordering still applies because the runtime sorts entities before
 *     it draws them. A calculated column, or one over `case_id`, has no
 *     such spelling, since its rule needs the stored column; the gate
 *     refuses that order rule (`caseTileHiddenCalculatedSort`).
 *
 * The 12-column cap is Nova's own. CommCare Core has no column-count
 * constant — `commcare-core/.../org/commcare/suite/model/Detail.java::Detail.getMaxWidthHeight`
 * derives the grid extent from whatever the fields occupy, and the Web
 * Apps renderer builds `repeat(maxWidth, 1fr)` from it
 * (`commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::buildCellGridStyle`),
 * so a 30-column tile renders. The 12 is the twelve columns HQ's Case
 * List page offers (`static/app_manager/js/details/bootstrap5/column.js`,
 * `tileColumnMax`) and HQ's own parity assertion
 * (`commcare-hq/corehq/apps/app_manager/tests/test_suite_case_tiles.py::SuiteCaseTilesTest.test_case_tile_column_count`,
 * "Keeps the number of columns in parity with what mobile allows").
 *
 * The rows are the rows HQ's own pages keep: `max(fields, 6)`, the fields
 * being the columns the Case List page counts for a Results tile and the
 * fields and tabs the Case Detail page counts for a Details tile
 * (`lib/domain/modules.ts::tileRowLimit`, which cites the page). Past them
 * the page's next save moves the cell to the first row or makes it one row
 * tall, so the gate refuses the cell there, as it does past the twelfth
 * column.
 */

import {
	type BlueprintDoc,
	detailsTileFieldCount,
	type Module,
	orderedColumns,
	resultsTileFieldCount,
	TILE_GRID_COLUMNS,
	type TileCell,
	tileCellBottomEdge,
	tileCellRightEdge,
	tileCellsOverlap,
	tileRowLimit,
	type Uuid,
} from "@/lib/domain";
import { menuEmittedAdvanced } from "@/lib/domain/advancedEntryDatums";
import {
	detailTabSpans,
	detailTileSharesRowAcrossTabs,
} from "@/lib/domain/detailTabs";
import { type ValidationError, validationError } from "../../errors";
import { describeColumn, describeColumnAtSentenceStart } from "./shared";

export function caseTileLayout(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
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

	if (config.detailTile) {
		const fields = orderedColumns(config, "detail").filter(
			(column) => column.visibleInDetail !== false,
		);
		// Every field shown in Details has a cell, and every cell belongs to
		// one: the twin of `caseListConfigSchema`'s rule, so the gate refuses
		// a layout the stored-document schema would.
		const shownInDetail = config.columns.filter(
			(column) => column.visibleInDetail !== false,
		);
		const cellKeys = Object.keys(config.detailTile.cells) as Uuid[];
		for (const [index, column] of config.columns.entries()) {
			const shown = column.visibleInDetail !== false;
			const placed = config.detailTile.cells[column.uuid] !== undefined;
			if (shown === placed) continue;
			const reason = shown
				? `${describeColumnAtSentenceStart(column, index)} is shown in Details but has no place on the Details tile. Give it a place on the tile, or hide it from Details.`
				: `${describeColumnAtSentenceStart(column, index)} has a place on the Details tile but isn't shown in Details. Show it in Details, or take it off the tile.`;
			errors.push(
				validationError(
					"CASE_DETAIL_TILE_LAYOUT_INVALID",
					"module",
					reason,
					location,
					{
						columnUuid: column.uuid,
						reason,
					},
				),
			);
		}
		for (const key of cellKeys) {
			if (config.columns.some((column) => column.uuid === key)) continue;
			const reason =
				"A place on the Details tile belongs to a field that isn't in this case list anymore. Lay the Details tile out again.";
			errors.push(
				validationError(
					"CASE_DETAIL_TILE_LAYOUT_INVALID",
					"module",
					reason,
					location,
					{
						columnUuid: key,
						reason,
					},
				),
			);
		}
		if (shownInDetail.length === 0) {
			const reason =
				"The Details tile has no field to show. Show a field in Details, or turn the Details tile off.";
			errors.push(
				validationError(
					"CASE_DETAIL_TILE_LAYOUT_INVALID",
					"module",
					reason,
					location,
					{
						reason,
					},
				),
			);
		}
		const detailRows = tileRowLimit(detailsTileFieldCount(config));
		const groups = config.detailTabs
			? (detailTabSpans(config.detailTabs, fields) ?? [])
			: [{ start: 0, end: fields.length }];
		for (const { start, end } of groups) {
			const prior: TileCell[] = [];
			for (const column of fields.slice(start, end)) {
				const cell = config.detailTile.cells[column.uuid];
				if (!cell) continue;
				const problem = cell.androidOnly
					? "Only a Results tile supports an Android-only value. Show this Details field on both platforms."
					: tileCellRightEdge(cell) > TILE_GRID_COLUMNS
						? "This field reaches past the edge of the Details tile. You can move it back inside or make it smaller."
						: tileCellBottomEdge(cell) > detailRows
							? `This field reaches row ${tileCellBottomEdge(cell)}, and the Details tile has ${detailRows} rows: one for each field and tab it shows, and at least six. You can move it up or make it shorter.`
							: prior.some((other) => tileCellsOverlap(other, cell))
								? "Two fields overlap on the same Details tile. You can move one field to a free space."
								: undefined;
				if (problem)
					errors.push(
						validationError(
							"CASE_DETAIL_TILE_LAYOUT_INVALID",
							"module",
							problem,
							location,
							{ columnUuid: column.uuid, reason: problem },
						),
					);
				prior.push(cell);
			}
		}
		if (
			detailTileSharesRowAcrossTabs(config) &&
			!menuEmittedAdvanced(doc, moduleUuid)
		)
			errors.push(
				validationError(
					"CASE_DETAIL_TILE_LAYOUT_INVALID",
					"module",
					"This menu needs each tile row to belong to one tab. You can move the fields of different tabs onto separate rows.",
					location,
					{
						reason:
							"This menu needs each tile row to belong to one tab. You can move the fields of different tabs onto separate rows.",
					},
				),
			);
	}

	const rows = tileRowLimit(resultsTileFieldCount(config));
	for (const [index, column] of columns.entries()) {
		const cell = column.tile;
		if (cell === undefined) continue;
		const right = tileCellRightEdge(cell);
		const bottom = tileCellBottomEdge(cell);
		if (right <= TILE_GRID_COLUMNS && bottom <= rows) continue;
		errors.push(
			validationError(
				"CASE_LIST_TILE_CELL_OUT_OF_GRID",
				"module",
				`${describeColumnAtSentenceStart(column, index)} on the "${mod.name}" case tile runs past the edge of the grid: it starts at column ${cell.x + 1}, row ${cell.y + 1} and spans ${cell.width} × ${cell.height}, which reaches column ${right} and row ${bottom}. The tile is ${TILE_GRID_COLUMNS} columns wide and ${rows} rows tall: a row for each field it shows, and at least six. Move the field left or up, or make it narrower or shorter, so it ends inside the grid.`,
				location,
				{
					columnUuid: column.uuid,
					columnIndex: String(index),
					x: String(cell.x),
					y: String(cell.y),
					width: String(cell.width),
					height: String(cell.height),
					rows: String(rows),
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
					`${describeColumnAtSentenceStart(first.column, first.index)} and ${describeColumn(second.column, second.index)} sit on top of each other on the "${mod.name}" case tile. Two fields cannot share the same square, one would be drawn over the other. Move or resize one of them so they no longer cover the same part of the grid.`,
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

	// A named layout's positions each show a different field of Results: a
	// removed, hidden or repeated field leaves a position HQ's
	// `CaseTileHelper._get_matched_detail_column` cannot fill.
	const named = config.tile?.namedSlots;
	if (named) {
		const shown = new Set(
			columns
				.filter(
					(column) =>
						column.visibleInList !== false && column.notOnList !== true,
				)
				.map((column) => column.uuid),
		);
		const seen = new Set<Uuid>();
		for (const [slot, uuid] of Object.entries(named)) {
			const repeated = seen.has(uuid);
			seen.add(uuid);
			if (shown.has(uuid) && !repeated) continue;
			errors.push(
				validationError(
					"CASE_LIST_NAMED_TILE_SLOT_INVALID",
					"module",
					repeated
						? `Two positions on the "${mod.name}" case tile show the same field. Choose a different Results field for each position.`
						: `A position on the "${mod.name}" case tile shows a field that isn't in Results anymore. Choose a Results field for it, or turn the named tile off.`,
					location,
					{ slot, columnUuid: uuid },
				),
			);
		}
	}
	if (config.tile === undefined || named) return errors;

	for (const [index, column] of columns.entries()) {
		if (column.tile !== undefined) continue;
		if (column.visibleInList === false) continue;
		errors.push(
			validationError(
				"CASE_LIST_TILE_COLUMN_NOT_PLACED",
				"module",
				`${describeColumnAtSentenceStart(column, index)} is shown in the "${mod.name}" case list but has no place on the tile. Every field a tile shows needs a square to sit in. Give it a place on the tile, or hide it from the case list.`,
				location,
				{ columnUuid: column.uuid, columnIndex: String(index) },
			),
		);
	}

	return errors;
}
