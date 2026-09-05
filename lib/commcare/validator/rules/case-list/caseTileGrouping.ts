/**
 * Rule: a grouped case tile has a header band the author could actually
 * have meant — a clean horizontal cut of the layout, with something
 * above it and something below it.
 *
 * Grouping draws the top `headerRows` rows of the tile ONCE per group,
 * from the group's first case, and the rows beneath once per member.
 * Two of the three findings here exist because Web Apps splits the tile
 * on a cell's START ROW alone:
 * `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::CaseTileGroupedListView.initialize`
 * computes `const isHeaderRow = (y) => y < groupHeaderRows` and then
 * partitions the field indices into `headerRowIndices` and
 * `bodyRowIndices` with no further check. It never splits a cell.
 *
 * The third finding — the whole-grid header — is arithmetic: a header
 * covering every occupied row leaves no body, so the "list" is a column
 * of identical headers.
 *
 * Which cells count is `tileCellFor`'s decision and nobody else's, the
 * same predicate every emission path calls
 * (`lib/commcare/CLAUDE.md` § Case-tile emission). That matters here
 * for one specific reason: a hidden, order-driving column keeps its
 * stored cell but emits no `<style>`, so it is not on the tile, cannot
 * straddle anything, and must not be allowed to widen the header band's
 * arithmetic either. Re-deriving the visibility rule locally is exactly
 * how the four emission paths diverged before the predicate had one
 * home.
 *
 * The state this rule does NOT check is the one the schema already made
 * unrepresentable: grouping lives inside `caseListConfig.tile`, so a
 * `<group>` on a detail with no tile cannot be constructed. That state
 * is silently broken on the wire — Formplayer sets `groupHeaderRows`
 * from the `<group>` regardless of tiles
 * (`formplayer/.../beans/menus/EntityListResponse`), so the list still
 * clusters and still pages by group, while
 * `cloudcare/.../formplayer/menus/utils.js::getCaseListView` routes to
 * the grouped view only when `tiles` is present and therefore renders
 * it flat.
 *
 * Nothing here can speak to the empty group key. `string(./index/<id>)`
 * on a case carrying no such index evaluates to `""`, which the
 * clustering map accepts as an ordinary key, so every such case
 * collapses into one group. WHICH cases lack the index is runtime data,
 * so a construction-time refusal could not be honest — the authoring
 * surface measures it and states the consequence instead
 * (`docs/architecture/contracts.md` § What the commit gate may
 * read).
 */

import {
	type BlueprintDoc,
	type Column,
	type Module,
	orderedColumns,
	type TileCell,
	tileCellBottomEdge,
	tileCellFor,
	tileCellIsGroupHeader,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function caseTileGrouping(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	const layout = config?.tile;
	const grouping = layout?.grouping;
	if (config === undefined || layout === undefined || grouping === undefined) {
		return [];
	}

	// In RESULTS order, so "column #3" counts the way the author sees the
	// tile laid out — the same ordering `caseTileLayout` reports against.
	const placed = orderedColumns(config, "list")
		.map((column, index) => ({
			column,
			index,
			cell: tileCellFor(column, layout),
		}))
		.filter(
			(entry): entry is { column: Column; index: number; cell: TileCell } =>
				entry.cell !== undefined,
		);
	if (placed.length === 0) return [];

	const errors: ValidationError[] = [];
	const location = { moduleUuid, moduleName: mod.name };
	const headerRows = grouping.headerRows;
	const occupiedRows = Math.max(
		...placed.map((entry) => tileCellBottomEdge(entry.cell)),
	);

	if (headerRows >= occupiedRows) {
		errors.push(
			validationError(
				"CASE_LIST_TILE_GROUP_HEADER_ROWS_OUT_OF_RANGE",
				"module",
				`The "${mod.name}" case list groups its cases and gives the group header ${rowCount(headerRows)}, but the tile is only ${rowCount(occupiedRows)} tall. The header is drawn once per group and the rows below it once per case, so a header that covers the whole tile leaves nothing to show for each case. Give the header fewer rows, or make the tile taller.`,
				location,
				{
					headerRows: String(headerRows),
					occupiedRows: String(occupiedRows),
				},
			),
		);
		// The straddle and empty-header checks below both read the boundary
		// as a real cut of the layout. With no body they would restate the
		// same problem in two more messages.
		return errors;
	}

	for (const entry of placed) {
		const cell = entry.cell;
		if (!tileCellIsGroupHeader(cell, headerRows)) continue;
		if (tileCellBottomEdge(cell) <= headerRows) continue;
		errors.push(
			validationError(
				"CASE_LIST_TILE_GROUP_CELL_STRADDLES_HEADER",
				"module",
				`${describeColumn(entry.column, entry.index)} crosses the group header boundary on the "${mod.name}" case tile: the header is the top ${rowCount(headerRows)} and this field runs from row ${cell.y + 1} to row ${tileCellBottomEdge(cell)}. A field cannot be split, so this one would be drawn entirely in the header, from the first case in each group, and every other case's value would disappear. Move or resize it so it sits fully inside the header or fully below it.`,
				location,
				{
					columnUuid: entry.column.uuid,
					columnIndex: String(entry.index),
					headerRows: String(headerRows),
					y: String(cell.y),
					height: String(cell.height),
				},
			),
		);
	}

	if (!placed.some((entry) => tileCellIsGroupHeader(entry.cell, headerRows))) {
		errors.push(
			validationError(
				"CASE_LIST_TILE_GROUP_HEADER_EMPTY",
				"module",
				`The "${mod.name}" case list groups its cases and gives the group header ${rowCount(headerRows)}, but no field sits in ${headerRows === 1 ? "that row" : "those rows"}. Every group would open with an empty band. Move a field the cases in a group share, such as something from the case they are connected to, into the header, or give the header fewer rows.`,
				location,
				{ headerRows: String(headerRows) },
			),
		);
	}

	return errors;
}

function rowCount(rows: number): string {
	return rows === 1 ? "1 row" : `${rows} rows`;
}

/**
 * Author-facing handle for a column named in a message. Mirrors
 * `caseTileLayout`'s helper: calculated columns have no `field`, so
 * `header` is the informative slot when present.
 */
function describeColumn(column: Column, index: number): string {
	const header = column.header.trim();
	if (header.length > 0) return `"${header}" (column #${index + 1})`;
	if (column.kind !== "calculated" && column.field.trim().length > 0) {
		return `"${column.field}" (column #${index + 1})`;
	}
	return `Column #${index + 1}`;
}
