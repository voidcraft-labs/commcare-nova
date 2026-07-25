// components/builder/case-list-config/tile/tilePresets.ts
//
// Starting arrangements for a tile. A preset is a BUILDER GESTURE that
// fills every member's placement — there is no template name in the
// schema and none on the wire, so a preset and a hand-drawn layout take
// exactly the same path. Each is named for what a worker sees on the
// screen, never for a CommCare template.
//
// Presets are purely geometric. Alignment, text size, border, and
// shading are the author's own choices about a cell, and rearranging a
// tile is not a reason to overwrite them.

import {
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	type TileCell,
	type Uuid,
} from "@/lib/domain";
import type { TileGeometry } from "./tileModel";

export type TilePresetId =
	| "stacked-lines"
	| "two-columns"
	| "title-with-side-note"
	| "title-over-two-columns";

export interface TilePreset {
	readonly id: TilePresetId;
	readonly label: string;
	readonly description: string;
	/**
	 * The arrangement for `count` fields, in Results order, or `null`
	 * when this shape has no room for that many. A caller offering the
	 * preset states the `null` case as the reason it is unavailable.
	 */
	readonly arrange: (count: number) => readonly TileGeometry[] | null;
}

/** One full-width line per field. */
function stackedLines(count: number): readonly TileGeometry[] | null {
	if (count < 1 || count > TILE_GRID_ROWS) return null;
	return Array.from({ length: count }, (_unused, index) => ({
		x: 0,
		y: index,
		width: TILE_GRID_COLUMNS,
		height: 1,
	}));
}

/** Fields in `perRow` equal columns, filling left to right. */
function grid(count: number, perRow: number): readonly TileGeometry[] | null {
	const width = TILE_GRID_COLUMNS / perRow;
	if (!Number.isInteger(width)) return null;
	if (count < 1) return null;
	if (Math.ceil(count / perRow) > TILE_GRID_ROWS) return null;
	return Array.from({ length: count }, (_unused, index) => ({
		x: (index % perRow) * width,
		y: Math.floor(index / perRow),
		width,
		height: 1,
	}));
}

/** A wide first field with a narrow companion beside it, then full lines. */
function titleWithSideNote(count: number): readonly TileGeometry[] | null {
	if (count < 2) return null;
	if (1 + (count - 2) > TILE_GRID_ROWS) return null;
	const arranged: TileGeometry[] = [
		{ x: 0, y: 0, width: 8, height: 1 },
		{ x: 8, y: 0, width: 4, height: 1 },
	];
	for (let index = 2; index < count; index++) {
		arranged.push({ x: 0, y: index - 1, width: TILE_GRID_COLUMNS, height: 1 });
	}
	return arranged;
}

/** A full-width first field, then two equal columns underneath. */
function titleOverTwoColumns(count: number): readonly TileGeometry[] | null {
	if (count < 3) return null;
	if (1 + Math.ceil((count - 1) / 2) > TILE_GRID_ROWS) return null;
	const arranged: TileGeometry[] = [
		{ x: 0, y: 0, width: TILE_GRID_COLUMNS, height: 1 },
	];
	for (let index = 1; index < count; index++) {
		const slot = index - 1;
		arranged.push({
			x: (slot % 2) * 6,
			y: 1 + Math.floor(slot / 2),
			width: 6,
			height: 1,
		});
	}
	return arranged;
}

export const TILE_PRESETS: readonly TilePreset[] = [
	{
		id: "stacked-lines",
		label: "Stacked lines",
		description: "Every field on its own line, full width",
		arrange: stackedLines,
	},
	{
		id: "two-columns",
		label: "Two columns",
		description: "Fields side by side, two to a line",
		arrange: (count) => (count < 2 ? null : grid(count, 2)),
	},
	{
		id: "title-with-side-note",
		label: "Title with a side note",
		description: "A wide first field with a narrow one beside it",
		arrange: titleWithSideNote,
	},
	{
		id: "title-over-two-columns",
		label: "Title over two columns",
		description: "A full-width first field, then two columns below",
		arrange: titleOverTwoColumns,
	},
];

/** Why a preset can't run for the current field count. */
export function tilePresetUnavailableReason(
	preset: TilePreset,
	count: number,
): string | undefined {
	if (preset.arrange(count) !== null) return undefined;
	if (count === 0) return "Add information to Results first.";
	if (preset.id === "title-with-side-note" && count < 2) {
		return "This layout needs at least two fields.";
	}
	if (preset.id === "title-over-two-columns" && count < 3) {
		return "This layout needs at least three fields.";
	}
	if (preset.id === "two-columns" && count < 2) {
		return "This layout needs at least two fields.";
	}
	return `This layout has no room for ${count} fields on a ${TILE_GRID_COLUMNS} by ${TILE_GRID_ROWS} tile.`;
}

/**
 * The arrangement a tile is BORN with when an author turns it on and no
 * field has a place yet: one field per line while they fit, then as many
 * equal columns as it takes. Total up to a full grid of single squares,
 * so turning the tile on always lands a working layout.
 */
const SEED_SHAPES: readonly number[] = [1, 2, 3, 4, 6, TILE_GRID_COLUMNS];

export function seedTileArrangement(
	count: number,
): readonly TileGeometry[] | null {
	if (count < 1) return null;
	for (const perRow of SEED_SHAPES) {
		const arranged = perRow === 1 ? stackedLines(count) : grid(count, perRow);
		if (arranged !== null) return arranged;
	}
	return null;
}

/** The most fields one tile can lay out — a full grid of single squares. */
export const TILE_MAX_FIELDS = TILE_GRID_COLUMNS * TILE_GRID_ROWS;

/**
 * Which preset the current arrangement already matches, so the menu can
 * show where the author is rather than presenting four equal options.
 * Compares placement only; presentation is not part of a preset.
 */
export function matchingTilePreset(
	cellsInOrder: readonly TileCell[],
): TilePresetId | null {
	for (const preset of TILE_PRESETS) {
		const arranged = preset.arrange(cellsInOrder.length);
		if (arranged === null) continue;
		const matches = cellsInOrder.every((cell, index) => {
			const target = arranged[index];
			return (
				target !== undefined &&
				cell.x === target.x &&
				cell.y === target.y &&
				cell.width === target.width &&
				cell.height === target.height
			);
		});
		if (matches) return preset.id;
	}
	return null;
}

/** Pair an arrangement with the members it applies to, in Results order. */
export function assignTileArrangement(
	uuids: readonly Uuid[],
	arrangement: readonly TileGeometry[],
): ReadonlyMap<Uuid, TileGeometry> {
	const assigned = new Map<Uuid, TileGeometry>();
	uuids.forEach((uuid, index) => {
		const geometry = arrangement[index];
		if (geometry !== undefined) assigned.set(uuid, geometry);
	});
	return assigned;
}
