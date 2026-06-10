// components/builder/case-list-config/SortPriorityStack.tsx
//
// Sort-priority pill stack — the ordered list of sorted columns,
// drag-to-reorder priority. The first pill is the primary sort.
// Mounted in the case-list panel inspector (the canvas's header sort
// chips are the read-only mirror). The drag handler always emits a
// clean 0..N-1 priority sequence so the visible order stays readable
// even though the schema tolerates gaps (see `sortPriority.ts`).

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerSortAscending from "@iconify-icons/tabler/sort-ascending";
import tablerSortDescending from "@iconify-icons/tabler/sort-descending";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useMemo } from "react";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import type { Column, ColumnSort } from "@/lib/domain";
import { resolveSortedColumns } from "./sortPriority";

interface SortPriorityStackProps {
	readonly value: readonly Column[];
	readonly onChange: (next: readonly Column[]) => void;
}

/**
 * Sort priority pill stack. Renders the sorted columns in priority
 * order; each pill carries the column's header (or field), the sort
 * direction icon, a drag handle, and a clear affordance. Renders an
 * explanatory resting line when no column is sorted so the inspector
 * section doesn't read as broken.
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
			<p className="text-[11px] text-nova-text-muted/70">
				No sort yet — pick a direction on a column to sort the list by it.
			</p>
		);
	}

	return (
		<div className="flex flex-wrap items-stretch gap-1.5">
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
									className="absolute top-0 bottom-0 w-0.5 bg-nova-violet rounded-full"
									style={{
										left: closestEdge === "top" ? -3 : undefined,
										right: closestEdge === "bottom" ? -3 : undefined,
									}}
								/>
							)}
							<SortPriorityPill
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

interface SortPriorityPillProps {
	readonly column: Column;
	readonly position: number;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onRemove: () => void;
}

/** Single pill in the sort priority stack. Carries the column's
 *  label + a direction icon + a remove affordance. */
function SortPriorityPill({
	column,
	position,
	setHandleEl,
	onRemove,
}: SortPriorityPillProps) {
	const direction = column.sort?.direction ?? "asc";
	const directionIcon =
		direction === "asc" ? tablerSortAscending : tablerSortDescending;
	// Calculated columns have no `field`; use the header alone (or a
	// fallback marker when both are blank).
	const labelSource =
		column.kind === "calculated"
			? column.header || "(unnamed)"
			: column.header || column.field || "(unnamed)";
	return (
		<div className="inline-flex items-center gap-1.5 rounded-md border border-nova-violet/30 bg-nova-violet/[0.08] px-2 py-1 text-xs">
			<button
				type="button"
				ref={setHandleEl}
				aria-label={`Reorder sort priority for ${labelSource}`}
				className="cursor-grab text-nova-violet-bright/60 hover:text-nova-violet-bright transition-colors"
			>
				<Icon icon={tablerGripVertical} width="12" height="12" />
			</button>
			<span className="text-[10px] font-mono text-nova-violet-bright/60">
				{position}
			</span>
			<span className="truncate max-w-[160px] text-nova-text">
				{labelSource}
			</span>
			<Icon
				icon={directionIcon}
				width="12"
				height="12"
				className="text-nova-violet-bright/80"
				aria-label={`Sorted ${direction === "asc" ? "ascending" : "descending"}`}
			/>
			<button
				type="button"
				onClick={onRemove}
				aria-label={`Clear sort for ${labelSource}`}
				className="rounded p-0.5 text-nova-violet-bright/60 hover:text-nova-rose hover:bg-white/[0.05] transition-colors cursor-pointer"
			>
				<Icon icon={tablerTrash} width="11" height="11" />
			</button>
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
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[200px] truncate">{labelSource}</span>
		</div>
	);
}
