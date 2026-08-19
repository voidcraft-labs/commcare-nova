// lib/preview/caseTileGrouping.ts
//
// The projection a GROUPED tile list draws with: the tile's cells split
// into the header the group shows once and the body every member of the
// group repeats. Pure, and read off the Web Apps renderer the same way
// `caseTileLayout.ts` is, because a grouped list is a visual contract
// too.
//
// Two rules, both proven by the templates, both easy to get wrong:
//
//   1. **The split is the START ROW ONLY.**
//      `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::CaseTileGroupedListView.initialize`
//      computes `isHeaderRow = (y) => y < groupHeaderRows` against each
//      tile's `gridY` and partitions the FIELD INDICES on it. A cell's
//      height never enters the decision, so a two-row-tall cell starting
//      inside the header band is wholly header — which is exactly the
//      state `CASE_LIST_TILE_GROUP_CELL_STRADDLES_HEADER` refuses to
//      commit, because per-case content silently drawn from the group's
//      first case is a lie rather than a layout.
//
//   2. **Both halves keep the WHOLE tile's geometry.**
//      `…/partials/case_list/tile_grouped_item.html` draws the header and
//      each body row as separate divs that all carry the SAME
//      `<prefix>-cell-grid-style` class, and `cell_grid_style.html` emits
//      one such block from the tile's own `numColumns` / `numRows`. Each
//      cell keeps its `<prefix>-grid-style-<index>` rule, so it lands on
//      its absolute `grid-area` inside whichever half draws it. Rows the
//      half does not occupy collapse to `min-content` and take no space.
//      Re-deriving a narrower extent per half would slide every cell.

import type { TileGridProjection } from "./caseTileLayout";

/**
 * One grouped tile's two halves. The header is drawn ONCE per group,
 * from the group's first case; the body is drawn once per member.
 */
export interface GroupedTileProjection {
	/** Cells starting in the header band, drawn from the group's first case. */
	readonly header: TileGridProjection;
	/** Cells starting below it, drawn once for every case in the group. */
	readonly body: TileGridProjection;
}

/**
 * Split a tile's cells into the group header and the per-case body.
 *
 * `headerRows` is the authored `grouping.headerRows` — the same number the
 * `<group header-rows="N"/>` attribute carries. Both halves keep the full
 * projection's `columns` and `rows` (rule 2 above), so a renderer draws
 * them as two grids of identical geometry and every cell keeps the square
 * its author placed it in.
 *
 * Total: a `headerRows` covering every cell yields an empty body, and one
 * covering none yields an empty header. Neither can commit — the validator
 * refuses both — but the projection stays honest about what it was handed
 * rather than repairing it, so a preview of a document from anywhere shows
 * that document.
 */
export function splitTileGridByGroupHeader(
	projection: TileGridProjection,
	headerRows: number,
): GroupedTileProjection {
	const header = projection.cells.filter((cell) => cell.gridY < headerRows);
	const body = projection.cells.filter((cell) => cell.gridY >= headerRows);
	return {
		header: {
			columns: projection.columns,
			rows: projection.rows,
			cells: header,
		},
		body: { columns: projection.columns, rows: projection.rows, cells: body },
	};
}
