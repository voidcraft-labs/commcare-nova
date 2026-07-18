// components/builder/case-list-config/sortPriority.ts
//
// Sort-priority resolution for the canvas-owned Default order editor.

import { byListColumnOrder } from "@/lib/doc/order/compare";
import type { Column } from "@/lib/domain";

/**
 * Resolve the sorted columns ordered by `sort.priority` ascending.
 * Tie-break to Results order — the column appearing earlier on the running
 * list wins on a priority collision. Same rule the
 * saga / preview / wire layers use; the editor maintains
 * uniqueness on save but the tie-break exists for transient
 * (undo / partial-save) states.
 *
 * The schema doesn't guarantee priority uniqueness or contiguity:
 * per-column sort toggles drop a column's sort slot without
 * renumbering its peers, which leaves gaps (e.g. priorities
 * `[0, 1, 2]` with the middle column cleared becomes `[0, 2]`).
 * Gaps are harmless — every consumer orders by this resolution, and
 * the editor's drag handler renumbers to a clean 0..N-1.
 */
export function resolveSortedColumns(
	columns: readonly Column[],
): readonly Column[] {
	const sorted: { column: Column; priority: number; index: number }[] = [];
	const resultsOrdered = [...columns].sort(byListColumnOrder);
	for (let i = 0; i < resultsOrdered.length; i++) {
		const col = resultsOrdered[i];
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
