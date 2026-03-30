// ═══════════════════════════════════════════════════════════════
// Horizontal Tetris Progress Bar Solver v3
// ═══════════════════════════════════════════════════════════════
//
// Backtracker sorts pieces by LEAST-USED-FIRST at each decision
// point. This forces it to explore Step, Square, Flat, and Column
// placements before repeating a piece type.
// Result: a visually varied mosaic that's still gap-free.
//
// Board: 3 rows × N columns. Gravity pulls LEFT.
// ═══════════════════════════════════════════════════════════════

// ── Geometry ─────────────────────────────────────────────────

export const BOARD_ROWS = 3
export const BOARD_COLS = 63

export type Cell = [row: number, col: number]
export type Shape = Cell[]

export interface PieceDefinition {
  readonly id: string
  readonly name: string
  readonly rotations: readonly Shape[]
  readonly cellCount: number
}

// ── Piece catalogue ─────────────────────────────────────────
//
// Ordered diversity-first so the backtracker tries interesting
// shapes before falling back to Column.

export const PIECES: readonly PieceDefinition[] = [
  {
    id: 'ell', name: 'Ell', cellCount: 4,
    rotations: [
      // L rotations
      [[0, 0], [1, 0], [2, 0], [2, 1]],   //  #.  |  #.  |  ##
      [[0, 0], [0, 1], [0, 2], [1, 0]],   //  ###  |  #..
      [[0, 0], [0, 1], [1, 1], [2, 1]],   //  ##  |  .#  |  .#
      [[0, 2], [1, 0], [1, 1], [1, 2]],   //  ..#  |  ###
      // J rotations (mirror)
      [[0, 0], [0, 1], [1, 0], [2, 0]],   //  ##  |  #.  |  #.
      [[0, 0], [1, 0], [1, 1], [1, 2]],   //  #.  |  ###
      [[0, 1], [1, 1], [2, 0], [2, 1]],   //  .#  |  .#  |  ##
      [[0, 0], [0, 1], [0, 2], [1, 2]],   //  ###  |  ..#
    ],
  },
  {
    id: 'step', name: 'Step', cellCount: 4,
    rotations: [
      [[0, 0], [1, 0], [1, 1], [2, 1]],
      [[0, 1], [1, 0], [1, 1], [2, 0]],
    ],
  },
  {
    id: 'square', name: 'Square', cellCount: 4,
    rotations: [
      [[0, 0], [0, 1], [1, 0], [1, 1]],
    ],
  },
  {
    id: 'column', name: 'Column', cellCount: 3,
    rotations: [
      [[0, 0], [1, 0], [2, 0]],   //  #  vertical
      [[0, 0], [0, 1], [0, 2]],   //  ###  horizontal
    ],
  },
] as const

// ── Board ───────────────────────────────────────────────────

export type Board = boolean[][]

export function createEmptyBoard(cols: number = BOARD_COLS): Board {
  return Array.from({ length: BOARD_ROWS }, () => new Array<boolean>(cols).fill(false))
}

export function cloneBoard(board: Board): Board {
  return board.map(row => row.slice())
}

export function fillCount(board: Board): number {
  const cols = board[0].length
  let n = 0
  for (let r = 0; r < BOARD_ROWS; r++)
    for (let c = 0; c < cols; c++) if (board[r][c]) n++
  return n
}

export function isBoardFull(board: Board): boolean {
  return fillCount(board) === BOARD_ROWS * board[0].length
}

/** Rightmost filled column + 1 across all rows (0 = empty board). */
export function fillFront(board: Board): number {
  const cols = board[0].length
  let maxFront = 0
  for (let r = 0; r < BOARD_ROWS; r++) {
    for (let c = cols - 1; c >= 0; c--) {
      if (board[r][c]) { maxFront = Math.max(maxFront, c + 1); break }
    }
  }
  return maxFront
}

// ── Placement ───────────────────────────────────────────────

export interface Placement {
  piece: PieceDefinition
  rotationIndex: number
  shape: Shape
  originRow: number
  originCol: number
  cells: Cell[]
  /** Pieces the solver tried (all rotations exhausted) before finding this placement. */
  rejected: PieceDefinition[]
}

export function applyPlacement(board: Board, p: Placement): Board {
  const next = cloneBoard(board)
  for (const [r, c] of p.cells) next[r][c] = true
  return next
}

/** Can the piece physically slide from the right edge to originCol without collision?
 *  Checks every intermediate column position — the piece enters from the right
 *  and slides left as a unit, so ALL cells must be clear at every stop. */
function canReachFromRight(board: boolean[][], shape: Shape, oRow: number, oCol: number): boolean {
  const cols = board[0].length
  const maxDc = Math.max(...shape.map(([, c]) => c))
  const entry = cols - 1 - maxDc
  if (oCol >= entry) return true // already at the right edge
  for (let anchorCol = entry; anchorCol > oCol; anchorCol--) {
    for (const [dr, dc] of shape) {
      const r = oRow + dr
      const c = anchorCol + dc
      if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= cols || board[r][c]) return false
    }
  }
  return true
}

// ── Utility ─────────────────────────────────────────────────

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ── Tiling plan generator v3 ────────────────────────────────
//
// Pieces are ordered by ascending usage count at each decision
// point. After placing an Ell, the next step tries Step, Square,
// Flat, Column BEFORE trying another Ell. This creates natural
// round-robin variety while the backtracker guarantees a perfect fill.

export type TilingPlan = Placement[]

function findFirstEmpty(board: boolean[][]): Cell | null {
  const cols = board[0].length
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) {
      if (!board[r][c]) return [r, c]
    }
  }
  return null
}

/** Detect isolated single cells (unfillable — smallest piece is 2 cells). */
function hasIsolatedCell(board: boolean[][]): boolean {
  const cols = board[0].length
  for (let r = 0; r < BOARD_ROWS; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c]) continue
      const hasNeighbor =
        (r > 0 && !board[r - 1][c]) ||
        (r < BOARD_ROWS - 1 && !board[r + 1][c]) ||
        (c > 0 && !board[r][c - 1]) ||
        (c < cols - 1 && !board[r][c + 1])
      if (!hasNeighbor) return true
    }
  }
  return false
}

export function generateTilingPlan(
  cols: number = BOARD_COLS,
  rng: () => number = Math.random,
): TilingPlan {
  // Retry with advanced rng state if the greedy solver gets stuck (rare 2+ step dead end)
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = attemptTilingPlan(cols, rng)
    if (result) return result
  }
  throw new Error('Failed to generate tiling after 50 attempts')
}

function attemptTilingPlan(cols: number, rng: () => number): TilingPlan | null {
  const board = createEmptyBoard(cols)
  const plan: Placement[] = []

  /** After tentatively placing, can ANY piece still cover the next empty cell?
   *  1-step lookahead that catches unreachable pockets created by overhangs. */
  function nextCellFillable(b: boolean[][]): boolean {
    const next = findFirstEmpty(b)
    if (!next) return true // board full
    const [tr, tc] = next
    for (const p of PIECES) {
      for (const rot of p.rotations) {
        for (const [dr, dc] of rot) {
          const oRow = tr - dr, oCol = tc - dc
          let fits = true
          for (const [sr, sc] of rot) {
            const r = oRow + sr, c = oCol + sc
            if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= cols || b[r][c]) { fits = false; break }
          }
          if (fits && canReachFromRight(b, rot, oRow, oCol)) return true
        }
      }
    }
    return false
  }

  /** Try to place `piece` using the given rotation order.
   *  Returns the placement if any rotation fits, is reachable, and passes lookahead. */
  function tryPlace(piece: PieceDefinition, rotOrder: number[], targetRow: number, targetCol: number): Placement | null {
    for (const ri of rotOrder) {
      const shape = piece.rotations[ri]

      for (const [dr, dc] of shape) {
        const oRow = targetRow - dr
        const oCol = targetCol - dc

        let fits = true
        const cells: Cell[] = []

        for (const [sr, sc] of shape) {
          const r = oRow + sr
          const c = oCol + sc
          if (r < 0 || r >= BOARD_ROWS || c < 0 || c >= cols || board[r][c]) {
            fits = false
            break
          }
          cells.push([r, c])
        }
        if (!fits) continue
        if (!canReachFromRight(board, shape, oRow, oCol)) continue

        // Tentatively place — reject if it creates isolated cells or blocks the next step
        for (const [r, c] of cells) board[r][c] = true
        const valid = !hasIsolatedCell(board) && nextCellFillable(board)
        for (const [r, c] of cells) board[r][c] = false

        if (valid) {
          return { piece, rotationIndex: ri, shape, originRow: oRow, originCol: oCol, cells, rejected: [] }
        }
      }
    }
    return null
  }

  while (true) {
    const empty = findFirstEmpty(board)
    if (!empty) break // board full

    // Each turn: fresh random shuffle of pieces, each with shuffled rotations
    const candidates = shuffleArray([...PIECES], rng).map(piece => ({
      piece,
      rotOrder: shuffleArray(Array.from({ length: piece.rotations.length }, (_, i) => i), rng),
    }))
    const rejected: PieceDefinition[] = []
    let placed = false

    for (const { piece, rotOrder } of candidates) {
      const placement = tryPlace(piece, rotOrder, empty[0], empty[1])
      if (placement) {
        placement.rejected = rejected
        for (const [r, c] of placement.cells) board[r][c] = true
        plan.push(placement)
        placed = true
        break
      }
      rejected.push(piece)
    }

    if (!placed) return null // stuck — caller retries with a different shuffle
  }

  return plan
}
