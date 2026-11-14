// lib/preview/caseTileGrouping.ts
//
// The projection a GROUPED tile list draws with: the tile's cells split
// into the header the group shows once and the body every member of the
// group repeats, and the cards a page's rows make (`tileGroupCards`, below).
// Pure, and read off the Web Apps renderer the same way `caseTileLayout.ts`
// is, because a grouped list is a visual contract too.
//
// Two rules of the split, both proven by the templates, both easy to get
// wrong:
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
import type { PreviewPlatformRules } from "./platform";

/**
 * One grouped tile's two halves. The header is drawn ONCE per card, from
 * the card's first case; the body is drawn once per member.
 */
export interface GroupedTileProjection {
	/** Cells starting in the header band, drawn from the card's first case. */
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
 * On Android the list is flat: the header holds no cell and the body is the
 * whole tile, so each case draws as a group of one.
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
	rules: Pick<PreviewPlatformRules, "tileGrouping">,
): GroupedTileProjection {
	/* Android draws an ordinary tile list (commcare-android holds no reader
	 * of `Detail.getGroup`, `DetailGroup` or `header-rows`): every case is a
	 * group of its own whose body is the whole tile. */
	if (rules.tileGrouping === "flat") {
		return {
			header: { columns: projection.columns, rows: projection.rows, cells: [] },
			body: projection,
		};
	}
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

/**
 * One card of a grouped tile list: a group key and the cases the card holds, in the list's
 * order. `rows[0]` is the case the heading is drawn from and the one case choosing the card
 * chooses.
 */
export interface TileGroupCard<Row> {
	readonly key: string;
	readonly rows: readonly [Row, ...Row[]];
}

/** A grouped page as the list's own run of rows: each row in the list's order, and its group. */
export interface GroupedPageRows<Row> {
	readonly rows: readonly Row[];
	readonly keyOf: (row: Row) => string;
}

/**
 * The page's rows put back in the list's own order, each still knowing its group.
 *
 * The case store reads a grouped page clustered (`queryGrouped`), and names
 * the order the rows held before clustering in `listOrder`. Total: a row
 * `listOrder` does not name sorts after those it names, in its clustered
 * order (`Array.prototype.sort` is stable).
 */
export function groupedPageRows<
	Row extends { readonly case_id: string },
>(page: {
	readonly groups: readonly {
		readonly key: string;
		readonly rows: readonly Row[];
	}[];
	readonly listOrder: readonly string[];
}): GroupedPageRows<Row> {
	const place = new Map(page.listOrder.map((caseId, index) => [caseId, index]));
	const keys = new Map<Row, string>();
	const clustered: Row[] = [];
	for (const group of page.groups) {
		for (const row of group.rows) {
			keys.set(row, group.key);
			clustered.push(row);
		}
	}
	const unnamed = page.listOrder.length;
	const rows = clustered.sort(
		(a, b) =>
			(place.get(a.case_id) ?? unnamed) - (place.get(b.case_id) ?? unnamed),
	);
	return {
		rows,
		keyOf: (row) => {
			const key = keys.get(row);
			if (key === undefined)
				throw new Error(
					`Case ${row.case_id} is not a row of this grouped page, so it has no group here. Read its group from the page it came from.`,
				);
			return key;
		},
	};
}

/**
 * The cards for the rows that remain, given in the list's order: Core's
 * `EntityScreenHelper.groupEntities` (a group's place is its first appearance, its members keep
 * their order) and the client's one model a group (`CaseTileGroupedListView.initialize`).
 *
 * Formplayer filters, then sorts, then groups
 * (`EntityScreenHelper.java::initEntities`), so under the list's filter the
 * cards are made from the matches: the groups stand in the order of each one's
 * first match, and a card's first case, which draws its heading and is its one
 * choice, is its first match. With every row kept the cards are the store's
 * own groups.
 */
export function tileGroupCards<Row>(
	rowsInListOrder: readonly Row[],
	keyOf: (row: Row) => string,
): readonly TileGroupCard<Row>[] {
	const cards = new Map<string, [Row, ...Row[]]>();
	for (const row of rowsInListOrder) {
		const key = keyOf(row);
		const card = cards.get(key);
		if (card === undefined) cards.set(key, [row]);
		else card.push(row);
	}
	return [...cards].map(([key, rows]) => ({ key, rows }));
}
