/**
 * The drag drop-target no-op predicate, extracted from `useDragIntent`'s
 * `onDrop` so it's testable without mounting the hook.
 *
 * A field drop is a no-op when the dragged field would land in the position
 * it already holds — dropped just BEFORE the sibling that already follows it
 * (edge `top`), or just AFTER the sibling that already precedes it (any other
 * edge). Adjacency is measured in `fieldOrder` array position, the same sequence
 * the onDrag placeholder renders.
 */

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Uuid } from "@/lib/doc/types";

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
