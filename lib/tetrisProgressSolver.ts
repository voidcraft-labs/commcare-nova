// ═══════════════════════════════════════════════════════════════
// Horizontal Tetris Progress Bar Solver v5
// ═══════════════════════════════════════════════════════════════
//
// Greedy solver with least-used-first piece ordering and depth-4
// lookahead. Pieces are sorted by ascending usage count so the
// solver always prefers variety. The depth-4 lookahead validates
// that a placement won't cause a dead end — on a 3-row board with
// max piece width 3, the partially-filled frontier spans at most
// ~4 columns, and 4 placements fully resolve any configuration.
//
// Board: 3 rows × N columns. Gravity pulls LEFT.
// ═══════════════════════════════════════════════════════════════

// ── Geometry ─────────────────────────────────────────────────

export const BOARD_ROWS = 3;
export const BOARD_COLS = 63;

export type Cell = [row: number, col: number];
export type Shape = Cell[];

export interface PieceDefinition {
	readonly id: string;
	readonly name: string;
	readonly rotations: readonly Shape[];
	readonly cellCount: number;
}

// ── Piece catalogue ─────────────────────────────────────────
//
// Ordered diversity-first so the solver tries interesting
// shapes before falling back to Column.

export const PIECES: readonly PieceDefinition[] = [
	{
		id: "ell",
		name: "Ell",
		cellCount: 4,
		rotations: [
			// L rotations
			[
				[0, 0],
				[1, 0],
				[2, 0],
				[2, 1],
			], //  #.  |  #.  |  ##
			[
				[0, 0],
				[0, 1],
				[0, 2],
				[1, 0],
			], //  ###  |  #..
			[
				[0, 0],
				[0, 1],
				[1, 1],
				[2, 1],
			], //  ##  |  .#  |  .#
			[
				[0, 2],
				[1, 0],
				[1, 1],
				[1, 2],
			], //  ..#  |  ###
			// J rotations (mirror)
			[
				[0, 0],
				[0, 1],
				[1, 0],
				[2, 0],
			], //  ##  |  #.  |  #.
			[
				[0, 0],
				[1, 0],
				[1, 1],
				[1, 2],
			], //  #.  |  ###
			[
				[0, 1],
				[1, 1],
				[2, 0],
				[2, 1],
			], //  .#  |  .#  |  ##
			[
				[0, 0],
				[0, 1],
				[0, 2],
				[1, 2],
			], //  ###  |  ..#
		],
	},
	{
		id: "step",
		name: "Step",
		cellCount: 4,
		rotations: [
			// S vertical / Z vertical (3 rows × 2 cols)
			[
				[0, 0],
				[1, 0],
				[1, 1],
				[2, 1],
			],
			[
				[0, 1],
				[1, 0],
				[1, 1],
				[2, 0],
			],
			// S horizontal / Z horizontal (2 rows × 3 cols)
			[
				[0, 1],
				[0, 2],
				[1, 0],
				[1, 1],
			],
			[
				[0, 0],
				[0, 1],
				[1, 1],
				[1, 2],
			],
		],
	},
	{
		id: "square",
		name: "Square",
		cellCount: 4,
		rotations: [
			[
				[0, 0],
				[0, 1],
				[1, 0],
				[1, 1],
			],
		],
	},
	{
		id: "column",
		name: "Column",
		cellCount: 3,
		rotations: [
			[
				[0, 0],
				[1, 0],
				[2, 0],
			], //  #  vertical
			[
				[0, 0],
				[0, 1],
				[0, 2],
			], //  ###  horizontal
		],
	},
] as const;

// ── Board ───────────────────────────────────────────────────

export type Board = boolean[][];

export function createEmptyBoard(cols: number = BOARD_COLS): Board {
	return Array.from({ length: BOARD_ROWS }, () =>
		new Array<boolean>(cols).fill(false),
	);
}

export function cloneBoard(board: Board): Board {
	return board.map((row) => row.slice());
}

export function fillCount(board: Board): number {
	const cols = board[0].length;
	let n = 0;
	for (let r = 0; r < BOARD_ROWS; r++)
		for (let c = 0; c < cols; c++) if (board[r][c]) n++;
	return n;
}

export function isBoardFull(board: Board): boolean {
	return fillCount(board) === BOARD_ROWS * board[0].length;
}

/** Rightmost filled column + 1 across all rows (0 = empty board). */
export function fillFront(board: Board): number {
	const cols = board[0].length;
	let maxFront = 0;
	for (let r = 0; r < BOARD_ROWS; r++) {
		for (let c = cols - 1; c >= 0; c--) {
			if (board[r][c]) {
				maxFront = Math.max(maxFront, c + 1);
				break;
			}
		}
	}
	return maxFront;
}

// ── Placement ───────────────────────────────────────────────

export interface Placement {
	piece: PieceDefinition;
	rotationIndex: number;
	shape: Shape;
	originRow: number;
	originCol: number;
	cells: Cell[];
	/** Pieces the solver tried (all rotations exhausted) before finding this placement. */
	rejected: PieceDefinition[];
}

export function applyPlacement(board: Board, p: Placement): Board {
	const next = cloneBoard(board);
	for (const [r, c] of p.cells) next[r][c] = true;
	return next;
}

/** Can the piece physically slide from the right edge to originCol without collision?
 *  Checks every intermediate column position — the piece enters from the right
 *  and slides left as a unit, so ALL cells must be clear at every stop. */
function canReachFromRight(
	board: boolean[][],
	shape: Shape,
	oRow: number,
	oCol: number,
): boolean {
	const cols = board[0].length;
	const maxDc = Math.max(...shape.map(([, c]) => c));
	const entry = cols - 1 - maxDc;
	if (oCol >= entry) return true; // already at the right edge
	for (let anchorCol = entry; anchorCol > oCol; anchorCol--) {
		for (const [dr, dc] of shape) {
			const r = oRow + dr;
			const c = anchorCol + dc;
			if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= cols || board[r][c])
				return false;
		}
	}
	return true;
}

// ── Utility ─────────────────────────────────────────────────

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
	const out = [...arr];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// ── Tiling plan generator v5 ────────────────────────────────
//
// Greedy least-used-first solver with depth-4 lookahead.
// Pieces are sorted by ascending usage count so the solver always
// prefers variety. The 4-step lookahead validates that a placement
// won't cause a dead end — sufficient on a 3-row board where the
// partially-filled frontier spans at most ~4 columns.

export type TilingPlan = Placement[];

/** Depth of the recursive lookahead. Proven sufficient by exhaustive
 *  state-space analysis (scripts/prove-lookahead-depth.py):
 *  - Infinite model (board interior): depth 1 suffices
 *  - Finite model (right-edge constraint): depth 4 required (from N≥9)
 *  The right edge removes piece options (can't extend past the board),
 *  creating dead-end cascades up to 3 layers deep. Depth 4 sees past
 *  all of them. Verified: 0 failures across 80,000 runs. */
const LOOKAHEAD_DEPTH = 4;

function findFirstEmpty(board: boolean[][], cols: number): Cell | null {
	for (let c = 0; c < cols; c++) {
		for (let r = 0; r < BOARD_ROWS; r++) {
			if (!board[r][c]) return [r, c];
		}
	}
	return null;
}

/** Orthogonal direction offsets for neighbor traversal. */
const DIRS: readonly Cell[] = [
	[-1, 0],
	[1, 0],
	[0, -1],
	[0, 1],
];

/** Check if placing `placedCells` created any isolated empty cells.
 *  Only inspects empty neighbors of the placement — a cell can only become
 *  isolated when one of its orthogonal neighbors was just filled. Runs in
 *  O(piece_size) instead of O(board_area) for the full-board scan. */
function hasNewIsolatedCell(
	board: boolean[][],
	cols: number,
	placedCells: Cell[],
): boolean {
	for (const [pr, pc] of placedCells) {
		for (const [dr, dc] of DIRS) {
			const r = pr + dr,
				c = pc + dc;
			if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= cols) continue;
			if (board[r][c]) continue; // filled cell can't be isolated
			// This empty cell had a neighbor just filled — check if it's now surrounded
			let hasEmptyNeighbor = false;
			for (const [nr, nc] of DIRS) {
				const er = r + nr,
					ec = c + nc;
				if (
					er >= 0 &&
					er < BOARD_ROWS &&
					ec >= 0 &&
					ec < cols &&
					!board[er][ec]
				) {
					hasEmptyNeighbor = true;
					break;
				}
			}
			if (!hasEmptyNeighbor) return true;
		}
	}
	return false;
}

/** Try to fit `shape` at the given origin on `board`. Returns the occupied
 *  cells if the shape fits within bounds and doesn't overlap, else null. */
function fitShape(
	board: boolean[][],
	cols: number,
	shape: Shape,
	oRow: number,
	oCol: number,
): Cell[] | null {
	const cells: Cell[] = [];
	for (const [sr, sc] of shape) {
		const r = oRow + sr,
			c = oCol + sc;
		if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= cols || board[r][c])
			return null;
		cells.push([r, c]);
	}
	return cells;
}

/** Can at least one valid placement be found `depth` steps deep from the
 *  current board state? At depth 0 just verifies the next cell is reachable.
 *  At depth 1+ tentatively places each candidate, checks for isolated cells
 *  created by the placement, and recurses. The isolation check is targeted:
 *  only neighbors of placed cells are inspected (not the full board). */
function canSolveAhead(
	board: boolean[][],
	cols: number,
	depth: number,
): boolean {
	const empty = findFirstEmpty(board, cols);
	if (!empty) return true; // board full
	if (depth <= 0) return true; // caller already validated no isolated cells

	const [tr, tc] = empty;
	for (const piece of PIECES) {
		for (const rot of piece.rotations) {
			for (const [dr, dc] of rot) {
				const cells = fitShape(board, cols, rot, tr - dr, tc - dc);
				if (!cells) continue;
				if (!canReachFromRight(board, rot, tr - dr, tc - dc)) continue;

				// Tentatively place, reject if it creates isolated cells, then recurse
				for (const [r, c] of cells) board[r][c] = true;
				const ok =
					!hasNewIsolatedCell(board, cols, cells) &&
					canSolveAhead(board, cols, depth - 1);
				for (const [r, c] of cells) board[r][c] = false;
				if (ok) return true;
			}
		}
	}
	return false;
}

export function generateTilingPlan(
	cols: number = BOARD_COLS,
	rng: () => number = Math.random,
): TilingPlan {
	const board = createEmptyBoard(cols);
	const plan: Placement[] = [];

	/** Running placement count per piece id for least-used-first ordering. */
	const usage: Record<string, number> = {};
	for (const p of PIECES) usage[p.id] = 0;

	while (true) {
		const target = findFirstEmpty(board, cols);
		if (!target) break; // board full

		// Shuffle first, then stable-sort by ascending usage count.
		// The pre-shuffle randomizes tie order so the mosaic isn't deterministic.
		const sorted = shuffleArray([...PIECES], rng).sort(
			(a, b) => usage[a.id] - usage[b.id],
		);

		const rejected: PieceDefinition[] = [];
		let placed = false;

		for (const piece of sorted) {
			// Shuffle rotations within each piece for visual variety
			const rotOrder = shuffleArray(
				Array.from({ length: piece.rotations.length }, (_, i) => i),
				rng,
			);
			const placement = tryPlace(board, cols, piece, rotOrder, target);
			if (placement) {
				placement.rejected = rejected;
				for (const [r, c] of placement.cells) board[r][c] = true;
				plan.push(placement);
				usage[piece.id]++;
				placed = true;
				break;
			}
			rejected.push(piece);
		}

		if (!placed) {
			// Unreachable — vertical 3×1 column always fits a 3-row empty span,
			// and LOOKAHEAD_DEPTH is proven sufficient to prevent dead ends.
			throw new Error(
				`Unexpected: no placement found at [${target[0]},${target[1]}] on ${cols}-col board`,
			);
		}
	}

	return plan;
}

/** Try to place `piece` at the target cell. Returns the first rotation/offset
 *  that fits, is reachable from the right, creates no isolated cells, and
 *  passes the recursive lookahead. */
function tryPlace(
	board: boolean[][],
	cols: number,
	piece: PieceDefinition,
	rotOrder: number[],
	target: Cell,
): Placement | null {
	const [targetRow, targetCol] = target;
	for (const ri of rotOrder) {
		const shape = piece.rotations[ri];

		for (const [dr, dc] of shape) {
			const oRow = targetRow - dr;
			const oCol = targetCol - dc;
			const cells = fitShape(board, cols, shape, oRow, oCol);
			if (!cells) continue;
			if (!canReachFromRight(board, shape, oRow, oCol)) continue;

			// Tentatively place, check for isolated cells, then validate with lookahead
			for (const [r, c] of cells) board[r][c] = true;
			const valid =
				!hasNewIsolatedCell(board, cols, cells) &&
				canSolveAhead(board, cols, LOOKAHEAD_DEPTH);
			for (const [r, c] of cells) board[r][c] = false;

			if (valid) {
				return {
					piece,
					rotationIndex: ri,
					shape,
					originRow: oRow,
					originCol: oCol,
					cells,
					rejected: [],
				};
			}
		}
	}
	return null;
}
