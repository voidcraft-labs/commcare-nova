// lib/preview/caseTileLayout.ts
//
// The parity projection: authored tile cells → the grid geometry a
// renderer draws. Pure, framework-free, and the single source both the
// running case list and the builder's layout canvas read, so what an
// author arranges and what a worker sees can never be derived
// differently.
//
// Every rule here is read off the Web Apps renderer rather than
// invented, because Web Apps is the target runtime and the tile is a
// visual contract. The three that a fresh implementation gets wrong:
//
//   1. **The grid is the OCCUPIED extent, not the authoring canvas.**
//      Cells are drawn on a 12-column grid, but the rendered grid is
//      `repeat(maxWidth, 1fr)` where `maxWidth` is the widest cell's
//      right edge
//      (`commcare-core/.../org/commcare/suite/model/Detail.java::Detail.getMaxWidthHeight`
//      → `formplayer/.../beans/menus/EntityListResponse.java::EntityListResponse.processCaseTiles`
//      → `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::buildCellGridStyle`).
//      A tile whose cells all end by column 6 renders as six equal
//      columns filling the full width — NOT as six twelfths of it.
//
//   2. **Border and shading are TILE-WIDE switches.** `views.js::buildCellLayout`
//      computes one `borderInTile` / `shadingInTile` across the whole
//      tile; if any cell asks for either, every cell changes layout
//      mode. A cell that asked for neither loses its stretch-free
//      alignment margin and takes a flat 7px margin instead, and a cell
//      that asked for either stops honoring its own alignment and
//      stretches inside a padded box.
//
//   3. **Absent is not a default.** An absent alignment resolves to
//      `start` (`views.js::getValidFieldAlignment` against
//      `constants.js::ALLOWED_FIELD_ALIGNMENTS`), but an absent font
//      size produces an empty `font-size: ;` declaration the browser
//      discards — so the cell INHERITS the list's size. There is no
//      `medium` fallback at runtime; that default lives only in HQ's
//      authoring UI.
//
// Two runtime knobs Nova does not author are pinned here rather than
// left implicit, because the renderer has to assume something and the
// assumption is what a parity test asserts against: `numEntitiesPerRow`
// resolves to 1 (one tile per row) and `useUniformUnits` to false
// (`min-content` row heights). Both are the runtime's own
// absent-attribute defaults —
// `commcare-core/.../org/commcare/xml/DetailParser.java::DetailParser.parse`
// falls back to 1 for a missing `fit-across` and `"true".equals(null)`
// is false for `uniform-units` — and both are re-asserted client-side by
// `views.js::initCaseTileList` (`options.numEntitiesPerRow || 1`) and
// `menus/controller.js::getCaseTile` (`detailObject.useUniformUnits || false`).

import {
	type Column,
	type TileCell,
	type TileFontSize,
	tileGridExtent,
	tileHasBoxedCells,
} from "@/lib/domain";

/**
 * Tiles drawn side by side in one row of the list. Nova does not author
 * CommCare's `fit-across`, and the runtime treats a missing attribute as
 * 1, so the projection pins 1 rather than leaving the renderer to guess.
 */
export const TILE_ENTITIES_PER_ROW = 1;

/**
 * Whether tile rows are forced to the same height as a column's width
 * (square cells). Nova does not author CommCare's `uniform-units`, and
 * the runtime treats a missing attribute as false, so rows size to
 * their content.
 */
export const TILE_USES_UNIFORM_UNITS = false;

/** How a cell's content sits across the cell, resolved for rendering. */
export type ResolvedTileAlign = "start" | "center" | "end";

/**
 * How a cell is laid out inside the grid, after the tile-wide border /
 * shading switch is applied.
 *
 *   - `flow` — no cell in the tile asks for a border or shading. Each
 *     cell sits at its own alignment with no box around it.
 *   - `boxed` — this cell asks for a border, shading, or both. It
 *     stretches across its grid area inside a padded, rounded box; its
 *     own alignment no longer positions the box.
 *   - `inset` — some OTHER cell in the tile asks for a box, so the
 *     whole tile is in boxed mode, but this cell asked for neither. It
 *     keeps its alignment and takes a uniform margin so it lines up
 *     with its boxed neighbours.
 */
export type TileCellLayoutMode = "flow" | "boxed" | "inset";

/** One placed cell, resolved for rendering. */
export interface TileCellProjection {
	/** The column this cell draws. */
	readonly columnUuid: string;
	/**
	 * The authored row this cell STARTS on, zero-based — the runtime's own
	 * `tile.gridY`. Carried beside `gridArea` (which encodes the same number
	 * one-based, alongside three others) because the grouped renderer splits
	 * header from body on exactly this value and nothing else:
	 * `views.js::CaseTileGroupedListView.initialize` computes
	 * `isHeaderRow = (y) => y < groupHeaderRows` against `tile.gridY`, so a
	 * cell's height never moves it across the boundary.
	 */
	readonly gridY: number;
	/**
	 * CSS `grid-area`, already 1-based:
	 * `row-start / column-start / row-end / column-end`. Mirrors
	 * `views.js::getGridAttributes`, whose own doc comment claims
	 * `[x] / [y] / [width] / [height]` and is wrong about it — the code
	 * emits the standard four-edge order.
	 */
	readonly gridArea: string;
	readonly horizontalAlign: ResolvedTileAlign;
	readonly verticalAlign: ResolvedTileAlign;
	/** Absent means "inherit the list's size", not "medium". */
	readonly fontSize?: TileFontSize;
	readonly mode: TileCellLayoutMode;
	readonly showBorder: boolean;
	readonly showShading: boolean;
}

/** A whole tile, resolved for rendering. */
export interface TileGridProjection {
	/** Grid columns — the widest cell's right edge, never the 12-column canvas. */
	readonly columns: number;
	/** Grid rows — the lowest cell's bottom edge. */
	readonly rows: number;
	/** Placed cells, in the order the caller supplied their columns. */
	readonly cells: readonly TileCellProjection[];
}

/**
 * Nova's authoring words for horizontal alignment → the resolved value.
 * `left` / `right` are honored by the renderer as written; mapping them
 * onto the logical `start` / `end` keeps the projection RTL-safe, which
 * matters for Nova's own canvas even though the emitted wire keeps the
 * physical spelling CommCare's allow-list carries.
 */
const HORIZONTAL_ALIGN: Readonly<
	Record<NonNullable<TileCell["horizontalAlign"]>, ResolvedTileAlign>
> = { left: "start", center: "center", right: "end" };

const VERTICAL_ALIGN: Readonly<
	Record<NonNullable<TileCell["verticalAlign"]>, ResolvedTileAlign>
> = { top: "start", middle: "center", bottom: "end" };

/**
 * Project a tile's placed columns into renderable geometry.
 *
 * `columns` is the Results-ordered column list. Columns with no cell
 * are skipped: an unplaced column contributes nothing to the grid, and
 * the validator already refuses to commit one that would render.
 *
 * The result is empty-safe — a tile with no placed columns projects to
 * a zero-by-zero grid, which the renderer shows as its empty state
 * rather than a collapsed row.
 */
export function projectTileGrid(
	columns: readonly Column[],
): TileGridProjection {
	const placed = columns.flatMap((column) =>
		column.tile === undefined ? [] : [{ uuid: column.uuid, cell: column.tile }],
	);
	const cellsOnly = placed.map((entry) => entry.cell);
	const extent = tileGridExtent(cellsOnly);
	// One switch for the whole tile, exactly as the runtime computes it —
	// a per-cell reading would place every plain cell differently from the
	// device the moment one neighbour asked for a box.
	const boxedTile = tileHasBoxedCells(cellsOnly);

	return {
		columns: extent.columns,
		rows: extent.rows,
		cells: placed.map(({ uuid, cell }) => {
			const showBorder = cell.showBorder === true;
			const showShading = cell.showShading === true;
			const mode: TileCellLayoutMode = !boxedTile
				? "flow"
				: showBorder || showShading
					? "boxed"
					: "inset";
			return {
				columnUuid: uuid,
				gridY: cell.y,
				gridArea: tileCellGridArea(cell),
				horizontalAlign:
					cell.horizontalAlign === undefined
						? "start"
						: HORIZONTAL_ALIGN[cell.horizontalAlign],
				verticalAlign:
					cell.verticalAlign === undefined
						? "start"
						: VERTICAL_ALIGN[cell.verticalAlign],
				...(cell.fontSize !== undefined && { fontSize: cell.fontSize }),
				mode,
				showBorder,
				showShading,
			};
		}),
	};
}

/**
 * One cell's CSS `grid-area`. Authored coordinates are zero-based and
 * CSS grid lines are one-based, so every edge shifts by one.
 */
export function tileCellGridArea(cell: TileCell): string {
	const rowStart = cell.y + 1;
	const columnStart = cell.x + 1;
	return `${rowStart} / ${columnStart} / ${rowStart + cell.height} / ${columnStart + cell.width}`;
}

/**
 * `grid-template-rows` for a tile.
 *
 * With uniform units off — Nova's pinned assumption — rows size to their
 * content. The uniform arm is kept because it is what the value means,
 * not because Nova can author it: a renderer that hardcoded
 * `min-content` would silently disagree with a device running an
 * imported app that does set `uniform-units`.
 */
export function tileGridTemplateRows(
	rows: number,
	uniformUnits: boolean = TILE_USES_UNIFORM_UNITS,
	columns?: number,
): string {
	if (!uniformUnits || columns === undefined || columns <= 0) {
		return `repeat(${rows}, min-content)`;
	}
	return `repeat(${rows}, ${100 / columns}cqw)`;
}

/** `grid-template-columns` for a tile — equal fractions of the occupied extent. */
export function tileGridTemplateColumns(columns: number): string {
	return `repeat(${columns}, minmax(0, 1fr))`;
}
