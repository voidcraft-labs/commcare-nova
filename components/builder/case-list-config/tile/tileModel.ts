// components/builder/case-list-config/tile/tileModel.ts
//
// The pure placement model behind the tile layout editor. Every gesture
// — a pointer drag, an arrow key, a typed number, a preset — resolves to
// the same verdict here: one placement, or one refusal stated in the
// author's words. The editor never lands a refused placement, which is
// what keeps the four `CASE_LIST_TILE_*` validator findings unreachable
// from the canvas.
//
// Two rules the surrounding UI reads off this file:
//
//   1. **A tile cannot hide a field.** A column that is hidden from
//      Results but still sets the default order is carried by the tile
//      anyway — the wire emits its `<style><grid>` alongside its
//      zero-width header — so it occupies a real square and belongs on
//      the canvas. `tileParticipation` is the one place that decision
//      lives.
//   2. **Overlap is checked across every participant**, including those
//      order-only fields. The validator checks overlap only among
//      Results-visible cells; the editor is deliberately stricter,
//      because two cells on one square is never something an author
//      means, whichever of them is nominally hidden.

import { byListColumnOrder } from "@/lib/doc/order/compare";
import {
	type CaseListConfig,
	type Column,
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	type TileCell,
	tileCellBottomEdge,
	tileCellRightEdge,
	tileCellsOverlap,
	type Uuid,
} from "@/lib/domain";
import { columnLabel } from "../canvas/ColumnInventory";

/** Why a column is on the tile. */
export type TileParticipantRole =
	/** Shown in Results — the ordinary case. */
	| "shown"
	/** Hidden from Results, but the case list still carries it to order
	 *  by it, and a tile has no off-screen column. */
	| "order-only";

/** One column the tile lays out, with the place it currently holds. */
export interface TilePlacement {
	readonly uuid: Uuid;
	readonly label: string;
	readonly role: TileParticipantRole;
	readonly cell: TileCell;
}

/** A column the tile must lay out that has no place yet. */
export interface TileVacancy {
	readonly uuid: Uuid;
	readonly label: string;
	readonly role: TileParticipantRole;
}

/** The tile's membership, split by whether each member has a place. */
export interface TileMembership {
	readonly placed: readonly TilePlacement[];
	readonly unplaced: readonly TileVacancy[];
}

/** Just the four coordinates — what a gesture changes. Presentation
 *  slots travel with the cell they already sit on. */
export interface TileGeometry {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export type TilePlacementVerdict =
	| { readonly ok: true; readonly cell: TileCell }
	| { readonly ok: false; readonly reason: string };

/**
 * Whether a column is laid out by the tile, and why.
 *
 * Returns `null` for a column the tile does not carry — one hidden from
 * Results with no ordering role. Such a column may still hold a stored
 * cell; that cell is inert, and keeping it means showing the column in
 * Results again restores the place the author drew.
 */
export function tileParticipation(column: Column): TileParticipantRole | null {
	if (column.visibleInList !== false) return "shown";
	if (column.sort !== undefined) return "order-only";
	return null;
}

/**
 * The tile's membership in Results order — the same sequence the short
 * detail emits its fields in.
 */
export function tileMembership(columns: readonly Column[]): TileMembership {
	const placed: TilePlacement[] = [];
	const unplaced: TileVacancy[] = [];
	for (const column of [...columns].sort(byListColumnOrder)) {
		const role = tileParticipation(column);
		if (role === null) continue;
		const label = columnLabel(column);
		if (column.tile === undefined) {
			unplaced.push({ uuid: column.uuid, label, role });
			continue;
		}
		placed.push({ uuid: column.uuid, label, role, cell: column.tile });
	}
	return { placed, unplaced };
}

/**
 * The accessible name of one cell — the field and the squares it holds,
 * so a screen reader announces a move as a change of place rather than
 * an unexplained focus event.
 */
export function describeTileCell(label: string, cell: TileCell): string {
	const firstColumn = cell.x + 1;
	const firstRow = cell.y + 1;
	const columns =
		cell.width === 1
			? `column ${firstColumn}`
			: `columns ${firstColumn} to ${firstColumn + cell.width - 1}`;
	const rows =
		cell.height === 1
			? `row ${firstRow}`
			: `rows ${firstRow} to ${firstRow + cell.height - 1}`;
	return `${label}, ${columns}, ${rows}`;
}

/** The place a cell holds, in the words the inspector and canvas use. */
export function describeTilePlace(cell: TileCell): string {
	const firstColumn = cell.x + 1;
	const firstRow = cell.y + 1;
	const columns =
		cell.width === 1
			? `column ${firstColumn}`
			: `columns ${firstColumn} to ${firstColumn + cell.width - 1}`;
	const rows =
		cell.height === 1
			? `row ${firstRow}`
			: `rows ${firstRow} to ${firstRow + cell.height - 1}`;
	return `${columns}, ${rows}`;
}

/**
 * Adjudicate one candidate placement against the rest of the tile.
 *
 * `others` is every OTHER member's placement; the moving field is never
 * compared against itself. The refusal is the whole explanation a
 * gesture surfaces — the canvas and the numeric inputs both show it
 * verbatim rather than composing their own.
 */
export function evaluateTilePlacement(args: {
	readonly label: string;
	readonly candidate: TileGeometry;
	readonly others: readonly TilePlacement[];
}): TilePlacementVerdict {
	const { label, candidate, others } = args;

	if (candidate.width < 1) {
		return {
			ok: false,
			reason: `${label} has to be at least one column wide.`,
		};
	}
	if (candidate.height < 1) {
		return {
			ok: false,
			reason: `${label} has to be at least one row tall.`,
		};
	}
	if (candidate.x < 0) {
		return {
			ok: false,
			reason: `${label} would start before column 1. A tile starts at column 1.`,
		};
	}
	if (candidate.y < 0) {
		return {
			ok: false,
			reason: `${label} would start before row 1. A tile starts at row 1.`,
		};
	}

	const cell: TileCell = {
		x: candidate.x,
		y: candidate.y,
		width: candidate.width,
		height: candidate.height,
	};
	const right = tileCellRightEdge(cell);
	if (right > TILE_GRID_COLUMNS) {
		return {
			ok: false,
			reason: `${label} would reach column ${right}, past the right edge. A tile is ${TILE_GRID_COLUMNS} columns wide, so a field has to end by column ${TILE_GRID_COLUMNS}.`,
		};
	}
	const bottom = tileCellBottomEdge(cell);
	if (bottom > TILE_GRID_ROWS) {
		return {
			ok: false,
			reason: `${label} would reach row ${bottom}, past the bottom edge. A tile is ${TILE_GRID_ROWS} rows tall, so a field has to end by row ${TILE_GRID_ROWS}.`,
		};
	}

	for (const other of others) {
		if (!tileCellsOverlap(cell, other.cell)) continue;
		return {
			ok: false,
			reason: `${label} would sit on top of ${other.label}. Two fields can’t share a square on a tile — one would be drawn over the other.`,
		};
	}

	return { ok: true, cell };
}

/**
 * Move or resize one member to an absolute geometry, keeping every
 * presentation slot the cell already carries. Presentation is not a
 * placement decision, so no gesture on the grid may drop it.
 */
export function planTilePlacement(
	placed: readonly TilePlacement[],
	uuid: Uuid,
	geometry: TileGeometry,
): TilePlacementVerdict {
	const target = placed.find((entry) => entry.uuid === uuid);
	if (target === undefined) {
		return {
			ok: false,
			reason:
				"That field is no longer on this tile. Reopen the case list to see its current layout.",
		};
	}
	const verdict = evaluateTilePlacement({
		label: target.label,
		candidate: geometry,
		others: placed.filter((entry) => entry.uuid !== uuid),
	});
	if (!verdict.ok) return verdict;
	return { ok: true, cell: { ...target.cell, ...verdict.cell } };
}

/** Shift one member by whole squares. */
export function planTileMove(
	placed: readonly TilePlacement[],
	uuid: Uuid,
	deltaColumns: number,
	deltaRows: number,
): TilePlacementVerdict {
	const target = placed.find((entry) => entry.uuid === uuid);
	if (target === undefined) return planTilePlacement(placed, uuid, ZERO_GEOMETRY);
	return planTilePlacement(placed, uuid, {
		x: target.cell.x + deltaColumns,
		y: target.cell.y + deltaRows,
		width: target.cell.width,
		height: target.cell.height,
	});
}

/** Grow or shrink one member at its right and bottom edges. */
export function planTileResize(
	placed: readonly TilePlacement[],
	uuid: Uuid,
	deltaWidth: number,
	deltaHeight: number,
): TilePlacementVerdict {
	const target = placed.find((entry) => entry.uuid === uuid);
	if (target === undefined) return planTilePlacement(placed, uuid, ZERO_GEOMETRY);
	return planTilePlacement(placed, uuid, {
		x: target.cell.x,
		y: target.cell.y,
		width: target.cell.width + deltaWidth,
		height: target.cell.height + deltaHeight,
	});
}

const ZERO_GEOMETRY: TileGeometry = { x: 0, y: 0, width: 1, height: 1 };

// ── Keyboard ──────────────────────────────────────────────────────

export type TileKeyboardGesture =
	| { readonly kind: "move"; readonly deltaColumns: number; readonly deltaRows: number }
	| {
			readonly kind: "resize";
			readonly deltaWidth: number;
			readonly deltaHeight: number;
	  };

/**
 * The keyboard equivalent of dragging a cell: an arrow key moves it one
 * square, and Shift with an arrow key moves the edge the arrow points
 * at — right and down grow the field, left and up shrink it.
 *
 * Returns `null` for every other key so the grid never swallows Tab,
 * Escape, or activation keys.
 */
export function tileKeyboardGesture(
	key: string,
	shiftKey: boolean,
): TileKeyboardGesture | null {
	switch (key) {
		case "ArrowLeft":
			return shiftKey
				? { kind: "resize", deltaWidth: -1, deltaHeight: 0 }
				: { kind: "move", deltaColumns: -1, deltaRows: 0 };
		case "ArrowRight":
			return shiftKey
				? { kind: "resize", deltaWidth: 1, deltaHeight: 0 }
				: { kind: "move", deltaColumns: 1, deltaRows: 0 };
		case "ArrowUp":
			return shiftKey
				? { kind: "resize", deltaWidth: 0, deltaHeight: -1 }
				: { kind: "move", deltaColumns: 0, deltaRows: -1 };
		case "ArrowDown":
			return shiftKey
				? { kind: "resize", deltaWidth: 0, deltaHeight: 1 }
				: { kind: "move", deltaColumns: 0, deltaRows: 1 };
		default:
			return null;
	}
}

/** Apply one keyboard gesture through the same adjudication a drag uses. */
export function planTileKeyboardGesture(
	placed: readonly TilePlacement[],
	uuid: Uuid,
	gesture: TileKeyboardGesture,
): TilePlacementVerdict {
	return gesture.kind === "move"
		? planTileMove(placed, uuid, gesture.deltaColumns, gesture.deltaRows)
		: planTileResize(placed, uuid, gesture.deltaWidth, gesture.deltaHeight);
}

// ── Free space ────────────────────────────────────────────────────

/**
 * The first free rectangle of the requested size, scanning left to
 * right then top to bottom — where a newly placed field lands so it
 * reads in the order the author added it.
 */
export function firstFreeTilePlacement(
	occupied: readonly TileCell[],
	width: number,
	height: number,
): TileCell | null {
	if (width < 1 || height < 1) return null;
	for (let y = 0; y + height <= TILE_GRID_ROWS; y++) {
		for (let x = 0; x + width <= TILE_GRID_COLUMNS; x++) {
			const candidate: TileCell = { x, y, width, height };
			if (occupied.some((cell) => tileCellsOverlap(cell, candidate))) continue;
			return candidate;
		}
	}
	return null;
}

/**
 * The widest free place for one more field, preferring a full line and
 * narrowing until something fits. Returns `null` only when every square
 * is taken.
 */
export function nextFreeTilePlacement(
	occupied: readonly TileCell[],
): TileCell | null {
	for (const width of [TILE_GRID_COLUMNS, 6, 4, 3, 2, 1]) {
		const found = firstFreeTilePlacement(occupied, width, 1);
		if (found !== null) return found;
	}
	return null;
}

// ── Findings ──────────────────────────────────────────────────────

export type TileIssueKind =
	| "out-of-grid"
	| "overlap"
	| "not-placed"
	| "order-not-placed";

/** One tile problem, addressed to the field it belongs to. */
export interface TileIssue {
	readonly uuid: Uuid;
	readonly kind: TileIssueKind;
	readonly message: string;
}

/**
 * Every tile problem in one config, in the workspace's voice.
 *
 * This mirrors `lib/commcare/validator/rules/case-list/caseTileLayout.ts`
 * exactly — geometry is checked on every stored cell whether or not the
 * layout is on (so switching the tile back on is always accepted), while
 * coverage is checked only while it is on (it is a statement about what
 * the Results detail emits).
 */
export function tileLayoutIssues(config: CaseListConfig): readonly TileIssue[] {
	const issues: TileIssue[] = [];
	const columns = [...config.columns].sort(byListColumnOrder);

	for (const column of columns) {
		const cell = column.tile;
		if (cell === undefined) continue;
		const right = tileCellRightEdge(cell);
		const bottom = tileCellBottomEdge(cell);
		if (right <= TILE_GRID_COLUMNS && bottom <= TILE_GRID_ROWS) continue;
		const overflow =
			right > TILE_GRID_COLUMNS && bottom > TILE_GRID_ROWS
				? `column ${right} and row ${bottom}`
				: right > TILE_GRID_COLUMNS
					? `column ${right}`
					: `row ${bottom}`;
		issues.push({
			uuid: column.uuid,
			kind: "out-of-grid",
			message: `${columnLabel(column)} runs past the edge of the tile — it reaches ${overflow}, and a tile is ${TILE_GRID_COLUMNS} columns by ${TILE_GRID_ROWS} rows. Move it back, or make it smaller.`,
		});
	}

	// Overlap mirrors the validator's Results-visible scope. An order-only
	// field is left out here for the same reason the rule leaves it out:
	// unhiding it is the moment the conflict becomes the author's to fix.
	// The editor still refuses to CREATE one against an order-only cell.
	const visible = columns.filter(
		(column) => column.tile !== undefined && column.visibleInList !== false,
	);
	for (let a = 0; a < visible.length; a++) {
		for (let b = a + 1; b < visible.length; b++) {
			const first = visible[a];
			const second = visible[b];
			if (first === undefined || second === undefined) continue;
			const firstCell = first.tile;
			const secondCell = second.tile;
			if (firstCell === undefined || secondCell === undefined) continue;
			if (!tileCellsOverlap(firstCell, secondCell)) continue;
			const message = `${columnLabel(first)} and ${columnLabel(second)} cover the same squares. Move or resize one of them.`;
			issues.push({ uuid: first.uuid, kind: "overlap", message });
			issues.push({ uuid: second.uuid, kind: "overlap", message });
		}
	}

	if (config.tile === undefined) return issues;

	for (const column of columns) {
		if (column.tile !== undefined) continue;
		const role = tileParticipation(column);
		if (role === null) continue;
		issues.push(
			role === "shown"
				? {
						uuid: column.uuid,
						kind: "not-placed",
						message: `${columnLabel(column)} is shown in Results but has no place on the tile. Give it a place, or hide it from Results.`,
					}
				: {
						uuid: column.uuid,
						kind: "order-not-placed",
						message: `${columnLabel(column)} sets the default order, so the tile still carries it. A tile can’t hide a field — give it a place, or take it out of the default order.`,
					},
		);
	}

	return issues;
}

/** The per-column index the canvas and inspector read. */
export function tileIssuesByColumn(
	issues: readonly TileIssue[],
): ReadonlyMap<Uuid, readonly string[]> {
	const byColumn = new Map<Uuid, string[]>();
	for (const issue of issues) {
		const existing = byColumn.get(issue.uuid);
		if (existing === undefined) byColumn.set(issue.uuid, [issue.message]);
		else if (!existing.includes(issue.message)) existing.push(issue.message);
	}
	return byColumn;
}
