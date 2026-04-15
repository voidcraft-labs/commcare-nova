/**
 * EmptyContainerRow — drop target + placeholder for an empty group/repeat.
 *
 * In the legacy recursive renderer, an empty group was a `<GroupField>` with
 * a single leading `InsertionPoint` inside its body — the group body itself
 * carried the `useDroppable` ref so dropped questions would route into it.
 *
 * In the flat row model, the group's body is not a real DOM container, so
 * we emit this sibling row between the `group-open` and `group-close`
 * rows. It:
 *   - Is a dnd-kit droppable with the same `:container` suffix id the
 *     legacy code used. The `move()` helper already understands this key
 *     shape, so cross-group drops keep working without changes.
 *   - Displays a brief "Empty group" hint so the user understands they
 *     can drop here.
 *
 * Since the row is always adjacent (one virtual row apart) to the group's
 * open bracket, the drop experience reads continuously from the user's
 * point of view — they drag onto what looks like the group body, and
 * the `rangeExtractor` / overscan keep both rows mounted.
 */

"use client";
import { CollisionPriority } from "@dnd-kit/abstract";
import { useDroppable } from "@dnd-kit/react";
import { Icon } from "@iconify/react/offline";
import tablerDragDrop from "@iconify-icons/tabler/drag-drop";
import { memo } from "react";
import type { Uuid } from "@/lib/doc/types";
import { depthPadding, EMPTY_CONTAINER_HEIGHT_PX } from "../rowStyles";
import { CONTAINER_SUFFIX } from "../VirtualFormContext";

interface EmptyContainerRowProps {
	/** Parent container uuid — the group or repeat uuid. */
	readonly parentUuid: Uuid;
	readonly depth: number;
}

export const EmptyContainerRow = memo(function EmptyContainerRow({
	parentUuid,
	depth,
}: EmptyContainerRowProps) {
	// Droppable id matches the legacy `<GroupField>` / `<RepeatField>`
	// `useDroppable({ id: '<uuid>:container' })` — keeps the `move()`
	// helper's bucket routing consistent with the old behavior.
	const { ref } = useDroppable({
		id: `${parentUuid}${CONTAINER_SUFFIX}`,
		type: "container",
		accept: "question",
		collisionPriority: CollisionPriority.Low,
	});

	return (
		<div
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(0),
			}}
		>
			<div
				ref={ref}
				className="flex items-center justify-center gap-2 border border-dashed border-pv-input-border bg-pv-surface/30 rounded-lg text-xs text-nova-text-muted"
				style={{ height: EMPTY_CONTAINER_HEIGHT_PX }}
			>
				<Icon icon={tablerDragDrop} width="14" height="14" />
				Empty — drag a question here
			</div>
		</div>
	);
});
