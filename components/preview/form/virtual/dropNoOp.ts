/** The rendered span of a draggable field, group, or page. */
import type { Uuid } from "@/lib/doc/types";
import type { FormRow } from "./rowModel";

/**
 * The contiguous row span the dragged item occupies in the flat row list:
 * `[start, end]` inclusive, or `null` when it has no row (collapsed away,
 * or a stale uuid). A leaf is its one `field` row; a group runs from its
 * `group-open` to its `group-close`; a section runs from its heading to the
 * last row before the next root-level row (its trailing insertion gap
 * included), because a page has no close row.
 *
 * `useDragIntent` uses the span to suppress the placeholder in the gap
 * immediately before or after the dragged item: dropping there is its
 * current position, a cancel rather than a move.
 */
export function draggedRowSpan(
	rows: readonly FormRow[],
	dragUuid: Uuid,
): readonly [number, number] | null {
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row === undefined) continue;
		if (row.kind === "field" && row.uuid === dragUuid) return [i, i];
		if (row.kind === "group-open" && row.uuid === dragUuid) {
			for (let j = i; j < rows.length; j++) {
				const close = rows[j];
				if (close?.kind === "group-close" && close.uuid === dragUuid) {
					return [i, j];
				}
			}
			return [i, i];
		}
		if (row.kind === "section-header" && row.uuid === dragUuid) {
			// The page ends where the root resumes: the next heading, or a
			// root-level insertion gap (its parent is the form), or the end.
			let end = i;
			for (let j = i + 1; j < rows.length; j++) {
				const next = rows[j];
				if (next === undefined) continue;
				if (next.kind === "section-header") break;
				if (next.kind === "insertion" && next.parentUuid === row.parentUuid) {
					break;
				}
				end = j;
			}
			return [i, end];
		}
	}
	return null;
}
