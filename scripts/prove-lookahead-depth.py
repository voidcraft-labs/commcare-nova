#!/usr/bin/env python3
"""
Proves the minimum lookahead depth for the tetris tiling solver.

Two models:
  1. INFINITE model — frontier with unlimited space to the right.
     Captures interior behavior; misses right-edge constraints.
  2. FINITE model — (frontier, position) on a board of width N.
     Captures the right-edge effect where pieces can't extend past column N-1.

The finite model is the authoritative result. We run it for every board width
1-80 and report the worst-case required lookahead depth.
"""

from collections import deque

ROWS = 3
FULL = (1 << ROWS) - 1  # 0b111

# Piece rotations: each is a list of (row_offset, col_offset) cells
PIECES = [
    ("ell", [
        [(0,0),(1,0),(2,0),(2,1)],
        [(0,0),(0,1),(0,2),(1,0)],
        [(0,0),(0,1),(1,1),(2,1)],
        [(0,2),(1,0),(1,1),(1,2)],
        [(0,0),(0,1),(1,0),(2,0)],
        [(0,0),(1,0),(1,1),(1,2)],
        [(0,1),(1,1),(2,0),(2,1)],
        [(0,0),(0,1),(0,2),(1,2)],
    ]),
    ("step", [
        [(0,0),(1,0),(1,1),(2,1)],
        [(0,1),(1,0),(1,1),(2,0)],
        [(0,1),(0,2),(1,0),(1,1)],
        [(0,0),(0,1),(1,1),(1,2)],
    ]),
    ("square", [
        [(0,0),(0,1),(1,0),(1,1)],
    ]),
    ("column", [
        [(0,0),(1,0),(2,0)],
        [(0,0),(0,1),(0,2)],
    ]),
]


# ── Helpers ───────────────────────────────────────────────────

def normalize(frontier):
    """Trim leading full columns and trailing empty columns."""
    cols = list(frontier)
    while cols and cols[0] == FULL:
        cols.pop(0)
    while cols and cols[-1] == 0:
        cols.pop()
    return tuple(cols)


def leftmost_empty_in(frontier):
    """(row, col) of leftmost empty cell, or None if all full."""
    for c, mask in enumerate(frontier):
        for r in range(ROWS):
            if not (mask & (1 << r)):
                return (r, c)
    return None


def compute_dead_layers(reachable, transitions, is_terminal):
    """Iteratively compute dead states. Returns (dead_set, max_cascade_depth)."""
    dead = set()
    for s in reachable:
        if not is_terminal(s) and len(transitions.get(s, [])) == 0:
            dead.add(s)

    depth = 0
    while True:
        new_dead = set()
        for s in reachable:
            if s in dead or is_terminal(s):
                continue
            if all(x in dead for x in transitions.get(s, [])):
                new_dead.add(s)
        if not new_dead:
            break
        dead |= new_dead
        depth += 1

    return dead, (depth + 1) if dead else 0


# ── Infinite frontier model ──────────────────────────────────

def has_isolated_infinite(frontier):
    """Left of col 0 = filled. Right of last col = infinite empty space."""
    w = len(frontier)
    for c in range(w):
        for r in range(ROWS):
            if frontier[c] & (1 << r):
                continue
            ok = (
                (r > 0 and not (frontier[c] & (1 << (r - 1)))) or
                (r < ROWS - 1 and not (frontier[c] & (1 << (r + 1)))) or
                (c > 0 and not (frontier[c - 1] & (1 << r))) or
                (c < w - 1 and not (frontier[c + 1] & (1 << r))) or
                (c == w - 1)
            )
            if not ok:
                return True
    return False


def successors_infinite(state):
    working = state if state else (0,)
    target = leftmost_empty_in(working)
    if target is None:
        return []

    tr, tc = target
    w = len(working)
    seen = set()

    for _, rotations in PIECES:
        for rot in rotations:
            for dr, dc in rot:
                o_row, o_col = tr - dr, tc - dc
                cells = [(o_row + r, o_col + c) for r, c in rot]
                if any(r < 0 or r >= ROWS or c < 0 for r, c in cells):
                    continue

                max_col = max(c for _, c in cells)
                ext = list(working) + [0] * max(0, max_col + 1 - w)
                ew = len(ext)

                if any(ext[c] & (1 << r) for r, c in cells):
                    continue

                can_reach = True
                for anchor in range(ew - 1, o_col, -1):
                    for pr, pc in rot:
                        c = anchor + pc
                        if 0 <= c < ew and (ext[c] & (1 << (o_row + pr))):
                            can_reach = False
                            break
                    if not can_reach:
                        break
                if not can_reach:
                    continue

                new = list(ext)
                for r, c in cells:
                    new[c] |= (1 << r)
                result = normalize(tuple(new))

                if result and has_isolated_infinite(result):
                    continue
                seen.add(result)

    return list(seen)


def analyze_infinite():
    initial = ()
    reachable = {initial}
    transitions = {}
    queue = deque([initial])
    max_w = 0

    while queue:
        state = queue.popleft()
        max_w = max(max_w, len(state))
        succs = successors_infinite(state)
        transitions[state] = succs
        for s in succs:
            if s not in reachable:
                reachable.add(s)
                queue.append(s)

    dead, required = compute_dead_layers(
        reachable, transitions, is_terminal=lambda s: False
    )
    return len(reachable), max_w, len(dead), required


# ── Finite board model ───────────────────────────────────────

def has_isolated_finite(frontier, right_is_open):
    """right_is_open: True if empty space exists past the frontier's right edge.
    False if the frontier reaches the board boundary."""
    w = len(frontier)
    for c in range(w):
        for r in range(ROWS):
            if frontier[c] & (1 << r):
                continue
            ok = (
                (r > 0 and not (frontier[c] & (1 << (r - 1)))) or
                (r < ROWS - 1 and not (frontier[c] & (1 << (r + 1)))) or
                (c > 0 and not (frontier[c - 1] & (1 << r))) or
                (c < w - 1 and not (frontier[c + 1] & (1 << r))) or
                (c == w - 1 and right_is_open)
            )
            if not ok:
                return True
    return False


def successors_finite(frontier, pos, N):
    remaining = N - pos
    working = frontier if frontier else (0,)
    target = leftmost_empty_in(working)
    if target is None:
        return []

    tr, tc = target
    w = len(working)
    seen = set()

    for _, rotations in PIECES:
        for rot in rotations:
            for dr, dc in rot:
                o_row, o_col = tr - dr, tc - dc
                cells = [(o_row + r, o_col + c) for r, c in rot]

                if any(r < 0 or r >= ROWS for r, _ in cells):
                    continue
                if any(c < 0 or c >= remaining for _, c in cells):
                    continue

                max_col = max(c for _, c in cells)
                ext = list(working) + [0] * max(0, max_col + 1 - w)
                ew = len(ext)

                if any(ext[c] & (1 << r) for r, c in cells):
                    continue

                max_dc = max(dc for _, dc in rot)
                entry = remaining - 1 - max_dc
                can_reach = True
                for anchor in range(min(entry, ew - 1), o_col, -1):
                    for pr, pc in rot:
                        c = anchor + pc
                        if 0 <= c < ew and (ext[c] & (1 << (o_row + pr))):
                            can_reach = False
                            break
                    if not can_reach:
                        break
                if not can_reach:
                    continue

                new = list(ext)
                for r, c in cells:
                    new[c] |= (1 << r)

                advance = 0
                while advance < len(new) and new[advance] == FULL:
                    advance += 1

                new_frontier = normalize(tuple(new))
                new_pos = pos + advance

                if new_frontier:
                    right_is_open = (new_pos + len(new_frontier) < N)
                    if has_isolated_finite(new_frontier, right_is_open):
                        continue

                seen.add((new_frontier, new_pos))

    return list(seen)


def analyze_finite(N):
    initial = ((), 0)
    reachable = {initial}
    transitions = {}
    queue = deque([initial])

    while queue:
        state = queue.popleft()
        frontier, pos = state

        if not frontier and pos >= N:
            transitions[state] = None
            continue

        succs = successors_finite(frontier, pos, N)
        transitions[state] = succs
        for s in succs:
            if s not in reachable:
                reachable.add(s)
                queue.append(s)

    dead, required = compute_dead_layers(
        reachable, transitions,
        is_terminal=lambda s: transitions.get(s) is None,
    )
    return len(reachable), len(dead), required


# ── Main ─────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("INFINITE FRONTIER MODEL (no right-edge constraint)")
    print("=" * 60)
    states, max_w, dead_count, required = analyze_infinite()
    print(f"  Reachable states: {states}")
    print(f"  Max frontier width: {max_w} columns")
    print(f"  Dead states: {dead_count}")
    print(f"  Required depth: {required}")
    print()

    print("=" * 60)
    print("FINITE BOARD MODEL (right-edge constraint included)")
    print("=" * 60)
    worst_depth = 0
    worst_N = 0

    for N in range(1, 81):
        states, dead_count, required = analyze_finite(N)
        if required > worst_depth:
            worst_depth = required
            worst_N = N
        if dead_count > 0:
            print(f"  N={N:2d}: {states:5d} states, {dead_count:3d} dead, required depth: {required}")

    print()
    if worst_depth == 0:
        print("PROOF: No dead states for ANY board width 1-80.")
        print("Required lookahead depth: 0")
    else:
        print(f"PROOF: Worst case requires depth {worst_depth} (at N={worst_N}).")
        print(f"Depth-{worst_depth} lookahead is sufficient for all board widths 1-80.")


if __name__ == "__main__":
    main()
