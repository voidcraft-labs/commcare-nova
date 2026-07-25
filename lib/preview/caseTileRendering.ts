// lib/preview/caseTileRendering.ts
//
// The step after `caseTileLayout.ts`: from resolved tile geometry to the
// exact CSS a renderer writes, plus the column set a tile actually
// carries. Pure, so the running tile's parity is provable without
// mounting anything.
//
// The declarations here are read off the Web Apps templates that draw a
// tile, because those templates ARE the layout a worker sees:
// `commcare-hq/corehq/apps/cloudcare/templates/cloudcare/partials/case_list/cell_grid_style.html`
// (the container) and `…/cell_layout_style.html` (each cell). Only the
// COLORS are re-expressed — CommCare's literal `#685c53` border and
// `white` shading are a hairline rule and a raised surface, and Nova
// draws those from its own preview tokens so a tile belongs to the
// theme it is previewed in. Every geometry value is the template's.
//
// Two rules a fresh implementation gets wrong, both proven by the
// templates:
//
//   1. **A tile carries more columns than it shows, and the extra ones
//      hold no square.** A column hidden from Results that still owns a
//      Default-order rule is emitted as a zero-width sort carrier
//      (`lib/commcare/suite/case-list/shortDetail.ts`) so the device can
//      order by it. It is NOT a tile cell: `columns.ts::tileStyleChildren`
//      refuses a `<style>` for a hidden column, so
//      `DetailField::isCaseTileField` is false, Formplayer sends a null
//      tile for it, and `views.js::buildCellLayout` writes no `grid-area`
//      rule. `tile_item.html` still emits a wrapper div, but its content
//      goes inside `<div class="d-none">` and `grid.scss::.box` gives the
//      wrapper no size — an empty, zero-size, auto-placed item. So the
//      carrier adds nothing to the grid's extent and takes no part in the
//      tile-wide border/shading switch. `tileResultsColumns` strips the
//      stored cell from a hidden carrier to keep this projection matching
//      that.
//
//   2. **`text-align` is not part of the alignment switch.** The cell
//      template emits `text-align` for every cell in every mode, and
//      only `justify-self` / `align-self` change with the tile-wide
//      border/shading switch. A boxed cell still reads left/center/right
//      as its author wrote it; what it stops doing is positioning its
//      own box.

import type { CSSProperties } from "react";
import type { Column } from "@/lib/domain";
import {
	type TileCellProjection,
	type TileGridProjection,
	tileGridTemplateColumns,
	tileGridTemplateRows,
} from "./caseTileLayout";

/** One column a tile draws, with what the tile does about its value. */
export interface TileResultsColumn {
	readonly column: Column;
	/**
	 * True for a column the case list hides but still orders by. It rides
	 * the detail so the device can sort on it and draws nothing —
	 * `tile_item.html`'s `widthHint === 0` arm renders its value inside a
	 * `d-none` wrapper.
	 */
	readonly valueHidden: boolean;
}

/**
 * The columns a tile-laid-out Results list carries, from the module's
 * columns already sorted into Results order.
 *
 * This is the same set the short detail emits: every column shown in
 * Results, plus every hidden column that owns a Default-order rule. The
 * order matters — it is the order the emitted `<field>`s take.
 *
 * A hidden carrier arrives here with its stored placement STRIPPED, which
 * is what keeps this projection honest against the wire. Hiding a column
 * keeps its cell on the document — an author who hides and unhides should
 * get their drawing back — but `columns.ts::tileStyleChildren` refuses to
 * emit a `<style>` for a hidden column, so on the device that carrier is
 * not a tile field at all: it claims no `grid-area`, adds nothing to the
 * grid's extent, and takes no part in the tile-wide border/shading switch.
 * Leaving the cell attached here would let an invisible column silently
 * widen the tile and box every visible cell in the preview and nowhere
 * else.
 */
export function tileResultsColumns(
	listOrderedColumns: readonly Column[],
): readonly TileResultsColumn[] {
	return listOrderedColumns.flatMap<TileResultsColumn>((column) => {
		const hidden = column.visibleInList === false;
		if (hidden && column.sort === undefined) return [];
		if (!hidden) return [{ column, valueHidden: false }];
		const { tile: _unemittedCell, ...carrier } = column;
		return [{ column: carrier as Column, valueHidden: true }];
	});
}

/**
 * The tile container's own declarations.
 *
 * `justify-items: start` is the template's `justify-items: left` in
 * logical form: it only decides where a cell that sets no `justify-self`
 * of its own lands, and every projected cell sets one, so it is a
 * backstop rather than a layout rule.
 */
export function tileGridStyle(projection: TileGridProjection): CSSProperties {
	return {
		display: "grid",
		gridTemplateColumns: tileGridTemplateColumns(projection.columns),
		gridTemplateRows: tileGridTemplateRows(projection.rows),
		justifyItems: "start",
	};
}

/** One cell's declarations, plus the chrome its renderer draws with tokens. */
export interface TileCellPlan {
	readonly style: CSSProperties;
	/** Draw the padded, rounded box — this cell asked for border or shading. */
	readonly boxed: boolean;
	/** Draw the hairline rule around the box. */
	readonly bordered: boolean;
	/** Fill the box with the raised surface. */
	readonly shaded: boolean;
}

/**
 * Project one resolved cell onto the declarations `cell_layout_style.html`
 * writes for it.
 *
 * The three modes differ only in how the cell sits in its square:
 *
 *   - `flow` — the cell positions itself at its own alignments.
 *   - `boxed` — the cell stretches across its square and takes the box's
 *     padding and margins. It sets no `align-self`, so the grid's
 *     default stretches it vertically too; that is the template's shape,
 *     not an omission.
 *   - `inset` — the cell keeps its own alignments and takes the flat
 *     margin that lines it up with its boxed neighbours.
 *
 * An absent `fontSize` leaves the declaration off entirely, so the cell
 * inherits the list's size. Substituting `medium` here would make every
 * unsized cell disagree with the device.
 */
export function planTileCell(cell: TileCellProjection): TileCellPlan {
	const base: CSSProperties = {
		gridArea: cell.gridArea,
		textAlign: cell.horizontalAlign,
		...(cell.fontSize !== undefined && { fontSize: cell.fontSize }),
	};
	if (cell.mode === "boxed") {
		return {
			style: {
				...base,
				justifySelf: "stretch",
				borderRadius: "8px",
				padding: "5px 5px 0",
				margin: "2px 4px 5px",
			},
			boxed: true,
			bordered: cell.showBorder,
			shaded: cell.showShading,
		};
	}
	return {
		style: {
			...base,
			justifySelf: cell.horizontalAlign,
			alignSelf: cell.verticalAlign,
			...(cell.mode === "inset" && { margin: "7px" }),
		},
		boxed: false,
		bordered: false,
		shaded: false,
	};
}
