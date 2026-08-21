/**
 * The drag drop-target no-op predicate, extracted from `useDragIntent`'s
 * `onDrop` so it's testable without mounting the hook.
 *
 * A field drop is a no-op when the dragged field would land in the position
 * it already holds: dropped just BEFORE the sibling that already follows it
 * (edge `top`), or just AFTER the sibling that already precedes it (any other
 * edge). Adjacency is measured in `fieldOrder` array position, the same sequence
 * the onDrag placeholder renders.
 */

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Uuid } from "@/lib/doc/types";
import type { FormRow } from "./rowModel";

/**
 * True when dragging `sourceUuid` onto `targetUuid` at `edge` lands it in its
 * current display position (a cancel, not a move).
 *
 * @param orderedSiblings the parent's children in `fieldOrder` sequence.
 */
export function isNoOpFieldDrop(
	orderedSiblings: readonly Uuid[],
	sourceUuid: Uuid,
	targetUuid: Uuid,
	edge: Edge | null,
): boolean {
	const sourceIdx = orderedSiblings.indexOf(sourceUuid);
	const targetIdx = orderedSiblings.indexOf(targetUuid);
	if (sourceIdx < 0 || targetIdx < 0) return false;
	// edge `top` → dropping before `target`: no-op iff source already sits
	// immediately before it. Any other edge → dropping after `target`: no-op
	// iff source already sits immediately after it.
	return edge === "top"
		? sourceIdx === targetIdx - 1
		: sourceIdx === targetIdx + 1;
}

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
