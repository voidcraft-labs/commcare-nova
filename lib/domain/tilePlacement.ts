import {
	TILE_GRID_COLUMNS,
	TILE_GRID_ROWS,
	type TileCell,
	tileCell,
	tileCellsOverlap,
} from "./modules";

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
			const candidate = tileCell(x, y, width, height);
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
