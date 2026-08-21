/**
 * EmptyContainerRow: drop target + placeholder for an empty
 * group/repeat/section.
 *
 * Rendered between a `group-open` and `group-close` row when the
 * container has no children, or under a page's heading when the page has
 * no questions yet. Provides the sole drop target for "make this the first
 * child of the empty container." The `section` variant reads as a page.
 *
 * Unlike field/group rows, an empty container can't participate in
 * live reorder (there are no siblings to shift), so it keeps a local
 * `isDragOver` highlight via the shared `useRowDnd` hook.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerDragDrop from "@iconify-icons/tabler/drag-drop";
import { memo, useCallback } from "react";
import type { Uuid } from "@/lib/doc/types";
import { makeDropEmptyContainerData } from "../dragData";
import { depthPadding, EMPTY_CONTAINER_HEIGHT_PX } from "../rowStyles";
import { useRowDnd } from "../useRowDnd";

interface EmptyContainerRowProps {
	readonly parentUuid: Uuid;
	readonly depth: number;
	readonly variant: "container" | "section";
}

export const EmptyContainerRow = memo(function EmptyContainerRow({
	parentUuid,
	depth,
	variant,
}: EmptyContainerRowProps) {
	const buildDropData = useCallback<
		Parameters<typeof useRowDnd>[0]["buildDropData"]
	>(() => makeDropEmptyContainerData(parentUuid), [parentUuid]);

	const { ref, isDragOver } = useRowDnd({
		draggableUuid: null,
		cycleTargetContainerUuid: parentUuid,
		buildDropData,
	});

	return (
		<div
			style={{
				paddingLeft: depthPadding(depth),
				paddingRight: depthPadding(depth),
			}}
		>
			<div
				ref={ref}
				className={`flex items-center justify-center gap-2 rounded-lg text-xs transition-colors ${
					isDragOver
						? "border-2 border-dashed border-nova-violet bg-nova-violet/20 text-nova-text"
						: "border border-dashed border-pv-input-border bg-pv-surface/30 text-nova-text-muted"
				}`}
				style={{ height: EMPTY_CONTAINER_HEIGHT_PX }}
			>
				<Icon icon={tablerDragDrop} width="14" height="14" />
				{variant === "section"
					? "This section has no questions yet: drop one here, or add one below"
					: "Empty: drag a field here"}
			</div>
		</div>
	);
});
