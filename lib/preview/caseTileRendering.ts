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
//   1. **A tile's fields are the columns it shows.** A column hidden from
//      Results is no field of a tile's short detail
//      (`lib/domain/caseListOrder.ts`, rule 1): an order rule on it rides
//      as a sort row with no stored column, for which CommCare appends a
//      zero-width carrier with no `<style>`. Formplayer sends a null tile
//      for that carrier and `views.js::buildCellLayout` writes no
//      `grid-area` rule, so it adds nothing to the grid's extent and takes
//      no part in the tile-wide border/shading switch; Preview draws
//      nothing for it.
//
//   2. **`text-align` is not part of the alignment switch.** The cell
//      template emits `text-align` for every cell in every mode, and
//      only `justify-self` / `align-self` change with the tile-wide
//      border/shading switch. A boxed cell still reads left/center/right
//      as its author wrote it; what it stops doing is positioning its
//      own box.

import type { CSSProperties } from "react";
import { type CaseTileLayout, type Column, tileCellFor } from "@/lib/domain";
import {
	type TileCellProjection,
	type TileGridProjection,
	tileGridTemplateColumns,
	tileGridTemplateRows,
} from "./caseTileLayout";
import type { PreviewPlatformRules } from "./platform";

/** One column a tile draws, with what the tile does about its value. */
export interface TileResultsColumn {
	readonly column: Column;
	/**
	 * True for a field hidden from Results, which a list with no tile
	 * layout carries at width 0 and whose value nothing draws. A tile list
	 * has none.
	 */
	readonly valueHidden: boolean;
}

/**
 * The fields a Results list carries, from the module's columns already
 * sorted into Results order: the order plan's rule 1
 * (`lib/domain/caseListOrder.ts`). In a list with a tile layout these are
 * the columns shown on Results, each with the cell `tileCellFor` gives it;
 * a list with no tile layout carries every column, a hidden one at width 0.
 * `caseList.ts::applyTileLayoutToShortDetail` and the local short detail
 * walk the same fields, so the three agree on which columns a tile's short
 * detail holds.
 */
export function tileResultsColumns(
	listOrderedColumns: readonly Column[],
	layout: CaseTileLayout | undefined,
): readonly TileResultsColumn[] {
	return listOrderedColumns.flatMap<TileResultsColumn>((column) => {
		const hidden = column.visibleInList === false;
		if (layout !== undefined && hidden) return [];
		// `tileCellFor` is the ONE decision about whether a column holds a
		// square, shared with both emitters.
		const cell = tileCellFor(column, layout);
		if (cell !== undefined) return [{ column, valueHidden: hidden }];
		const { tile: _unemittedCell, ...carried } = column;
		return [{ column: carried as Column, valueHidden: hidden }];
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
 * Every cell states its size (`tileCellSchema`), and a tile's text never
 * follows the list's own size.
 *
 * On Android (`rules.tileBorderShading` false) no cell is boxed, bordered or
 * shaded whatever it says: commcare-android holds no reader of
 * `Style.getShowBorder` or `getShowShading`, so every cell sits in its square
 * at its own alignments. Its vertical alignment is `middle` or the top
 * (`rules.tileVerticalAlign` `"middle-only"`): `EntityViewTile.computeGravity`
 * matches `center`, `top` and `bottom` against Nova's `start`, `center` and
 * `end`, so only `center` meets, and the rest take the framework's default
 * gravity. Horizontal alignment and size hold on both.
 */
export function planTileCell(
	cell: TileCellProjection,
	rules: Pick<PreviewPlatformRules, "tileBorderShading" | "tileVerticalAlign">,
): TileCellPlan {
	const base: CSSProperties = {
		gridArea: cell.gridArea,
		textAlign: cell.horizontalAlign,
		fontSize: cell.fontSize,
	};
	if (!rules.tileBorderShading) {
		return {
			style: {
				...base,
				justifySelf: cell.horizontalAlign,
				alignSelf:
					rules.tileVerticalAlign === "middle-only" &&
					cell.verticalAlign !== "center"
						? "start"
						: cell.verticalAlign,
			},
			boxed: false,
			bordered: false,
			shaded: false,
		};
	}
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
