// components/builder/case-list-config/sortPriority.ts
//
// Sort-priority resolution shared by the case-list canvas (header
// sort chips), the column inspector (priority position badge), and
// the sort-priority pill stack.

import type { Column } from "@/lib/domain";

/**
 * Resolve the sorted columns ordered by `sort.priority` ascending.
 * Tie-break to source-array index — the column appearing earlier
 * in `columns` wins on a priority collision. Same rule the
 * saga / preview / wire layers use; the editor maintains
 * uniqueness on save but the tie-break exists for transient
 * (undo / partial-save) states.
 *
 * The schema doesn't guarantee priority uniqueness or contiguity:
 * per-column sort toggles drop a column's sort slot without
 * renumbering its peers, which leaves gaps (e.g. priorities
 * `[0, 1, 2]` with the middle column cleared becomes `[0, 2]`).
 * Gaps are harmless — every consumer orders by this resolution, and
 * the pill stack's drag handler renumbers to a clean 0..N-1.
 */
export function resolveSortedColumns(
	columns: readonly Column[],
): readonly Column[] {
	const sorted: { column: Column; priority: number; index: number }[] = [];
	for (let i = 0; i < columns.length; i++) {
		const col = columns[i];
		if (col === undefined) continue;
		if (col.sort === undefined) continue;
		sorted.push({ column: col, priority: col.sort.priority, index: i });
	}
	sorted.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return a.index - b.index;
	});
	return sorted.map((entry) => entry.column);
}

/** Per-column 1-based position in the resolved sort order, keyed by
 *  column uuid. `undefined`-free: unsorted columns simply have no
 *  entry. */
export function sortPositionByUuid(
	columns: readonly Column[],
): ReadonlyMap<string, number> {
	const map = new Map<string, number>();
	resolveSortedColumns(columns).forEach((col, i) => {
		map.set(col.uuid, i + 1);
	});
	return map;
}

/** Human summary of the sort order — "follow-up ↑, name ↓" — for the
 *  canvas status line. Empty string when nothing is sorted. */
export function describeSortOrder(columns: readonly Column[]): string {
	return resolveSortedColumns(columns)
		.map((col) => {
			const label =
				col.kind === "calculated"
					? col.header || "calculated"
					: col.header || col.field;
			const glyph = (col.sort?.direction ?? "asc") === "asc" ? "↑" : "↓";
			return `${label} ${glyph}`;
		})
		.join(", ");
}
