// components/builder/case-list-config/SortPriorityStack.tsx
//
// The ordered list of sorted columns — drag to reorder which sorts
// first. The top row is the primary sort. Mounted in the case-list
// panel inspector (the canvas's header sort chips are the read-only
// mirror). The drag handler always emits a clean 0..N-1 priority
// sequence so the visible order stays readable even though the
// schema tolerates gaps (see `sortPriority.ts`).

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerSortAscending from "@iconify-icons/tabler/sort-ascending";
import tablerSortDescending from "@iconify-icons/tabler/sort-descending";
import tablerX from "@iconify-icons/tabler/x";
import { useId, useMemo } from "react";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { Column, ColumnSort } from "@/lib/domain";
import { resolveSortedColumns } from "./sortPriority";

interface SortPriorityStackProps {
	readonly value: readonly Column[];
	readonly onChange: (next: readonly Column[]) => void;
}

/**
 * Sort order stack. Renders the sorted columns top-to-bottom in
 * priority order; each row carries the column's name, its direction,
 * a full-height grab rail, and a remove affordance — all full-size
 * targets. Renders an explanatory resting line when no column is
 * sorted so the section doesn't read as broken.
 */
export function SortPriorityStack({ value, onChange }: SortPriorityStackProps) {
	const sorted = useMemo(() => resolveSortedColumns(value), [value]);
	const containerKey = useId();

	const reorderSorted = (nextOrder: readonly Column[]) => {
		// Renumber the reordered sorted list 0..N-1, then write back
		// into the full column array preserving every non-sorted
		// column's position. The non-sorted columns keep their array
		// indices; only the sort fields on the sorted columns change.
		const priorityByUuid = new Map<string, number>();
		nextOrder.forEach((col, idx) => {
			priorityByUuid.set(col.uuid, idx);
		});
		const updated = value.map((col) => {
			if (col.sort === undefined) return col;
			const newPriority = priorityByUuid.get(col.uuid);
			if (newPriority === undefined) return col;
			if (col.sort.priority === newPriority) return col;
			const nextSort: ColumnSort = { ...col.sort, priority: newPriority };
			return { ...col, sort: nextSort } as Column;
		});
		onChange(updated);
	};

	const removeSort = (uuid: string) => {
		const updated = value.map((col) => {
			if (col.uuid !== uuid) return col;
			// Drop the sort slot via a key-stripping rebuild so the
			// schema's strip-mode parse omits the absent slot.
			const { sort: _s, ...rest } = col;
			return rest as Column;
		});
		onChange(updated);
	};

	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: "sort-priority-stack",
		items: sorted,
		onReorder: reorderSorted,
	});

	if (sorted.length === 0) {
		return (
			<p className="text-[11px] leading-relaxed text-nova-text-muted">
				Nothing sorts the list yet — pick Ascending or Descending on a column.
			</p>
		);
	}

	return (
		<div className="space-y-1.5">
			{sorted.map((col, i) => (
				<ReorderableRow
					key={col.uuid}
					index={i}
					containerKey={containerKey}
					containerKind="sort-priority-stack"
					pendingDrop={pendingDrop}
					preview={<SortPriorityDragPreview column={col} />}
				>
					{({
						wrapperRef,
						setHandleEl,
						closestEdge,
						previewPortal,
						beingMoved,
					}) => (
						<div
							ref={wrapperRef}
							className={`relative ${beingMoved ? "opacity-50" : ""}`}
						>
							{closestEdge !== null && (
								<div
									aria-hidden="true"
									className="absolute left-0 right-0 h-0.5 bg-nova-violet rounded-full z-10"
									style={{
										top: closestEdge === "top" ? -3 : undefined,
										bottom: closestEdge === "bottom" ? -3 : undefined,
									}}
								/>
							)}
							<SortPriorityRowItem
								column={col}
								position={i + 1}
								setHandleEl={setHandleEl}
								onRemove={() => removeSort(col.uuid)}
							/>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
		</div>
	);
}

interface SortPriorityRowItemProps {
	readonly column: Column;
	readonly position: number;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onRemove: () => void;
}

/** One row of the sort order — position, column name, direction, and
 *  the grab / remove affordances at full row height. */
function SortPriorityRowItem({
	column,
	position,
	setHandleEl,
	onRemove,
}: SortPriorityRowItemProps) {
	const direction = column.sort?.direction ?? "asc";
	const directionLabel = direction === "asc" ? "Ascending" : "Descending";
	const directionIcon =
		direction === "asc" ? tablerSortAscending : tablerSortDescending;
	// Calculated columns have no `field`; use the header alone (or a
	// fallback marker when both are blank).
	const labelSource =
		column.kind === "calculated"
			? column.header || "(unnamed)"
			: column.header || column.field || "(unnamed)";
	return (
		<div className="relative flex items-center gap-2 min-h-11 pl-8 pr-1 rounded-lg border border-nova-violet/25 bg-nova-violet/[0.06]">
			<SimpleTooltip
				content="Drag to reorder — the top one sorts first"
				side="left"
			>
				<button
					type="button"
					ref={setHandleEl}
					aria-label={`Drag to reorder the sort position of ${labelSource}`}
					className="absolute left-0 top-0 bottom-0 w-7 grid place-items-center rounded-l-lg cursor-grab text-nova-violet-bright hover:text-nova-violet-bright transition-colors"
				>
					<Icon icon={tablerGripVertical} width="14" height="14" />
				</button>
			</SimpleTooltip>
			<span className="font-mono text-[10px] text-nova-violet-bright shrink-0">
				{position}
			</span>
			<span className="flex-1 min-w-0 truncate text-[13px] text-nova-text">
				{labelSource}
			</span>
			<span className="inline-flex items-center gap-1 text-[11px] text-nova-violet-bright shrink-0">
				<Icon icon={directionIcon} width="13" height="13" aria-hidden="true" />
				{directionLabel}
			</span>
			<SimpleTooltip content="Stop sorting by this column">
				<button
					type="button"
					onClick={onRemove}
					aria-label={`Stop sorting by ${labelSource}`}
					className="w-10 self-stretch min-h-11 grid place-items-center rounded-r-lg text-nova-violet-bright hover:text-nova-rose transition-colors cursor-pointer"
				>
					<Icon icon={tablerX} width="14" height="14" />
				</button>
			</SimpleTooltip>
		</div>
	);
}

function SortPriorityDragPreview({ column }: { readonly column: Column }) {
	const labelSource =
		column.kind === "calculated"
			? column.header || "(unnamed)"
			: column.header || column.field || "(unnamed)";
	return (
		<div className="inline-flex items-center gap-1.5 rounded-md border border-nova-violet/40 bg-nova-surface/95 px-2.5 py-1 text-xs text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerArrowsSort}
				width="12"
				height="12"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[200px] truncate">{labelSource}</span>
		</div>
	);
}
