import {
	TILE_GRID_COLUMNS,
	type TileCell,
	tileCell,
	tileCellBottomEdge,
	tileCellsOverlap,
} from "./modules";

/**
 * The first free rectangle of the requested size within a tile of `rows`
 * rows (`tileRowLimit`), scanning left to right then top to bottom, where
 * a newly placed field lands so it reads in the order the author added it.
 */
export function firstFreeTilePlacement(
	occupied: readonly TileCell[],
	width: number,
	height: number,
	rows: number,
): TileCell | null {
	if (width < 1 || height < 1) return null;
	for (let y = 0; y + height <= rows; y++) {
		for (let x = 0; x + width <= TILE_GRID_COLUMNS; x++) {
			const candidate = tileCell(x, y, width, height);
			if (occupied.some((cell) => tileCellsOverlap(cell, candidate))) continue;
			return candidate;
		}
	}
	return null;
}

/**
 * The widest free place for one more field in a tile of `rows` rows,
 * preferring a full line and narrowing until something fits. Returns
 * `null` only when every square is taken.
 */
export function nextFreeTilePlacement(
	occupied: readonly TileCell[],
	rows: number,
): TileCell | null {
	for (const width of [TILE_GRID_COLUMNS, 6, 4, 3, 2, 1]) {
		const found = firstFreeTilePlacement(occupied, width, 1, rows);
		if (found !== null) return found;
	}
	return null;
}

/**
 * A place for `cell` inside a tile of `rows` rows, for a tile whose rows
 * just fell below it (a field left the screen, so the tile offers fewer
 * rows). A cell that already fits stays where it is. Otherwise, keeping
 * its width and style: its own column at the lowest start that fits its
 * height, where that square is free; then the first free place of its
 * size; then of its width at the tallest height that fits; then the
 * widest free line. Every place is free of `occupied` (the cells shown
 * beside it). `null` only where no square is free.
 */
export function fitTileCellIntoRows(
	cell: TileCell,
	occupied: readonly TileCell[],
	rows: number,
): TileCell | null {
	if (tileCellBottomEdge(cell) <= rows) return cell;
	const restyle = (place: TileCell): TileCell => ({
		...cell,
		x: place.x,
		y: place.y,
		width: place.width,
		height: place.height,
	});
	const clear = (place: TileCell) =>
		!occupied.some((other) => tileCellsOverlap(other, place));
	for (let height = Math.min(cell.height, rows); height >= 1; height--) {
		const raised = { ...cell, y: rows - height, height };
		if (clear(raised)) return raised;
		const free = firstFreeTilePlacement(occupied, cell.width, height, rows);
		if (free) return restyle(free);
	}
	const line = nextFreeTilePlacement(occupied, rows);
	return line ? restyle(line) : null;
}
