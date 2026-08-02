// components/builder/case-list-config/tile/tileModel.ts
//
// The pure placement model behind the tile layout editor. Every gesture:
// a pointer drag, an arrow key, a typed number, a preset, resolves to
// the same verdict here: one placement, or one refusal stated in the
// author's words. The editor never lands a refused placement, which is
// what keeps the `CASE_LIST_TILE_*` validator findings unreachable from
// the canvas.
//
// One rule the surrounding UI reads off this file: **the tile lays out
// exactly the fields Results shows.** A column hidden from Results
// still reaches the wire when it drives the default order, but it goes
// as CommCare's reserved zero-width carrier and draws nothing, so it
// needs no square; a hidden column with no ordering role reaches the
// short detail not at all. Either way its stored cell is inert, kept so
// that showing the column again restores the place the author drew.
// `tileShowsColumn` is the one place that decision lives.

import {
	type CaseListConfig,
	type Column,
	orderedColumns,
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	type TileCell,
	tileCellBottomEdge,
	tileCellRightEdge,
	tileCellsOverlap,
	type Uuid,
} from "@/lib/domain";
import { columnLabel } from "../canvas/ColumnInventory";

/** One column the tile lays out, with the place it currently holds. */
export interface TilePlacement {
	readonly uuid: Uuid;
	readonly label: string;
	readonly cell: TileCell;
}

/** A column the tile must lay out that has no place yet. */
export interface TileVacancy {
	readonly uuid: Uuid;
	readonly label: string;
}

/** The tile's membership, split by whether each member has a place. */
export interface TileMembership {
	readonly placed: readonly TilePlacement[];
	readonly unplaced: readonly TileVacancy[];
}

/** Just the four coordinates: what a gesture changes. Presentation
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
 * Whether the tile lays this column out: that is, whether a worker sees
 * it. A column hidden from Results draws nothing on a tile whether or
 * not it still orders the list, so it needs no square.
 */
export function tileShowsColumn(column: Column): boolean {
	return column.visibleInList !== false;
}

/**
 * The tile's membership in Results order: the same sequence the short
 * detail emits its fields in.
 */
export function tileMembership(config: CaseListConfig): TileMembership {
	const placed: TilePlacement[] = [];
	const unplaced: TileVacancy[] = [];
	for (const column of orderedColumns(config, "list")) {
		if (!tileShowsColumn(column)) continue;
		const label = columnLabel(column);
		if (column.tile === undefined) {
			unplaced.push({ uuid: column.uuid, label });
			continue;
		}
		placed.push({ uuid: column.uuid, label, cell: column.tile });
	}
	return { placed, unplaced };
}

/**
 * Every member of the tile, placed or not, in Results order, the
 * sequence a preset arranges against.
 */
export function tileMemberUuids(config: CaseListConfig): readonly Uuid[] {
	return orderedColumns(config, "list")
		.filter(tileShowsColumn)
		.map((column) => column.uuid);
}

/**
 * The accessible name of one cell: the field and the squares it holds,
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
 * gesture surfaces: the canvas and the numeric inputs both show it
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
			reason: `${label} would sit on top of ${other.label}. Two fields can’t share a square on a tile: one would be drawn over the other.`,
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

/**
 * Adjudicate a placement for ANY column, member or not.
 *
 * The numeric controls reach cells the grid cannot draw: a saved place
 * on a field currently hidden from Results, or on any field while the
 * case list is showing rows, so they cannot go through the member list
 * the way a drag does. Everything else is identical: the same bounds,
 * the same overlap check against the tile's members, the same words.
 */
export function planColumnTilePlacement(args: {
	readonly config: CaseListConfig;
	readonly column: Column;
	readonly geometry: TileGeometry;
}): TilePlacementVerdict {
	const { config, column, geometry } = args;
	const verdict = evaluateTilePlacement({
		label: columnLabel(column),
		candidate: geometry,
		others: tileMembership(config).placed.filter(
			(entry) => entry.uuid !== column.uuid,
		),
	});
	if (!verdict.ok) return verdict;
	return { ok: true, cell: { ...column.tile, ...verdict.cell } };
}

/** Shift one member by whole squares. */
export function planTileMove(
	placed: readonly TilePlacement[],
	uuid: Uuid,
	deltaColumns: number,
	deltaRows: number,
): TilePlacementVerdict {
	const target = placed.find((entry) => entry.uuid === uuid);
	if (target === undefined)
		return planTilePlacement(placed, uuid, ZERO_GEOMETRY);
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
	if (target === undefined)
		return planTilePlacement(placed, uuid, ZERO_GEOMETRY);
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
	| {
			readonly kind: "move";
			readonly deltaColumns: number;
			readonly deltaRows: number;
	  }
	| {
			readonly kind: "resize";
			readonly deltaWidth: number;
			readonly deltaHeight: number;
	  };

/**
 * The keyboard equivalent of dragging a cell: an arrow key moves it one
 * square, and Shift with an arrow key moves the edge the arrow points
 * at: right and down grow the field, left and up shrink it.
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
 * right then top to bottom, where a newly placed field lands so it
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

/**
 * The place a column takes when it joins the tile: showing a field the
 * tile had hidden, or adding a new one.
 *
 * A saved cell is honored only while it still WORKS. A column hidden
 * from Results leaves the tile's membership, so its square is free for
 * anything else to take; handing that cell straight back would land the
 * column on top of whatever moved in and refuse the author's own reveal
 * at the commit gate, with no way to repair it from the panel the
 * refusal opens. So a saved cell that no longer fits falls back to free
 * space: at the size the author chose, if that size fits anywhere.
 *
 * Returns `null` only when the tile is genuinely full, which callers
 * state as the reason rather than dispatching a doomed batch.
 */
export function placementForJoiningTile(
	config: CaseListConfig,
	column: Column,
): TileCell | null {
	const others = tileMembership(config).placed.filter(
		(entry) => entry.uuid !== column.uuid,
	);
	const saved = column.tile;
	if (
		saved !== undefined &&
		evaluateTilePlacement({
			label: columnLabel(column),
			candidate: saved,
			others,
		}).ok
	) {
		return saved;
	}
	const occupied = others.map((entry) => entry.cell);
	const atSavedSize =
		saved === undefined
			? null
			: firstFreeTilePlacement(occupied, saved.width, saved.height);
	return atSavedSize ?? nextFreeTilePlacement(occupied);
}

// ── Findings ──────────────────────────────────────────────────────

export type TileIssueKind = "out-of-grid" | "overlap" | "not-placed";

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
 * exactly: geometry is checked on every stored cell whether or not the
 * layout is on (so switching the tile back on is always accepted), while
 * coverage is checked only while it is on (it is a statement about what
 * the Results detail emits).
 */
export function tileLayoutIssues(config: CaseListConfig): readonly TileIssue[] {
	const issues: TileIssue[] = [];
	const columns = orderedColumns(config, "list");

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
			message: `${columnLabel(column)} runs past the edge of the tile: it reaches ${overflow}, and a tile is ${TILE_GRID_COLUMNS} columns by ${TILE_GRID_ROWS} rows. Move it back, or make it smaller.`,
		});
	}

	// Overlap is a Results-visible question, exactly as the validator has
	// it: a hidden field's stored cell draws nothing, so two of them on one
	// square is not something a worker can see. Showing one of them is the
	// moment the conflict becomes the author's to fix.
	// Scanned in the Results sequence, like the geometry pass above: the pair in
	// the message reads left-to-right the way the author sees them, and the
	// issue list comes back in the order the fields are laid out.
	const visible = columns.filter(
		(column) => column.tile !== undefined && tileShowsColumn(column),
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
		if (!tileShowsColumn(column)) continue;
		issues.push({
			uuid: column.uuid,
			kind: "not-placed",
			message: `${columnLabel(column)} is shown in Results but has no place on the tile. Give it a place, or hide it from Results.`,
		});
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
