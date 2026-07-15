// components/builder/case-list-config/DisplayOrderStack.tsx
//
// The one canonical display-order editor for case-list columns. Nova stores a
// single column sequence shared by the running list and case detail, so this
// stack deliberately includes every field — visible, screen-specific, and
// supporting — instead of letting either canvas reorder an incomplete view.
// Pointer users can drag; keyboard users focus the same handle and press
// Arrow Up / Arrow Down (or Home / End).

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import { useId, useMemo, useState } from "react";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { bySortKey } from "@/lib/doc/order/compare";
import type { Column } from "@/lib/domain";
import { columnLabel, columnSource } from "./canvas/ColumnInventory";

export interface DisplayOrderStackProps {
	readonly value: readonly Column[];
	readonly onChange: (next: readonly Column[]) => void;
}

export function DisplayOrderStack({ value, onChange }: DisplayOrderStackProps) {
	const ordered = useMemo(() => [...value].sort(bySortKey), [value]);
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: "case-column-display-order",
		items: ordered,
		onReorder: onChange,
	});

	if (ordered.length === 0) {
		return (
			<p className="text-[11px] leading-relaxed text-nova-text-muted">
				Add a field to begin arranging the list and case detail.
			</p>
		);
	}

	const moveByKeyboard = (
		index: number,
		key: "ArrowUp" | "ArrowDown" | "Home" | "End",
	) => {
		const column = ordered[index];
		if (column === undefined) return;
		const targetIndex =
			key === "Home"
				? 0
				: key === "End"
					? ordered.length - 1
					: index + (key === "ArrowUp" ? -1 : 1);
		if (
			targetIndex < 0 ||
			targetIndex >= ordered.length ||
			targetIndex === index
		) {
			setMoveAnnouncement(
				`${columnLabel(column)} is already at position ${index + 1} of ${ordered.length}.`,
			);
			return;
		}
		const next = [...ordered];
		const [moved] = next.splice(index, 1);
		if (moved === undefined) return;
		next.splice(targetIndex, 0, moved);
		setMoveAnnouncement(
			`${columnLabel(column)} moved to position ${targetIndex + 1} of ${ordered.length}.`,
		);
		onChange(next);
	};

	return (
		<div className="space-y-1.5" data-case-display-order>
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>
			{ordered.map((column, index) => (
				<ReorderableRow
					key={column.uuid}
					index={index}
					containerKey={containerKey}
					containerKind="case-column-display-order"
					pendingDrop={pendingDrop}
					preview={<DisplayOrderDragPreview column={column} />}
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
									className="absolute left-0 right-0 z-10 h-0.5 rounded-full bg-nova-violet"
									style={{
										top: closestEdge === "top" ? -3 : undefined,
										bottom: closestEdge === "bottom" ? -3 : undefined,
									}}
								/>
							)}
							<DisplayOrderRow
								column={column}
								position={index + 1}
								total={ordered.length}
								setHandleEl={setHandleEl}
								onMove={(key) => moveByKeyboard(index, key)}
							/>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
		</div>
	);
}

function DisplayOrderRow({
	column,
	position,
	total,
	setHandleEl,
	onMove,
}: {
	readonly column: Column;
	readonly position: number;
	readonly total: number;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: "ArrowUp" | "ArrowDown" | "Home" | "End") => void;
}) {
	const label = columnLabel(column);
	const visibleInList = column.visibleInList !== false;
	const visibleInDetail = column.visibleInDetail !== false;

	return (
		<div className="relative flex min-h-14 items-stretch rounded-lg border border-white/[0.06] bg-nova-deep/40 pl-9">
			<SimpleTooltip
				content="Drag to reorder · ↑/↓ moves one place"
				side="left"
			>
				<button
					type="button"
					ref={setHandleEl}
					onKeyDown={(event) => {
						if (
							event.key !== "ArrowUp" &&
							event.key !== "ArrowDown" &&
							event.key !== "Home" &&
							event.key !== "End"
						) {
							return;
						}
						event.preventDefault();
						onMove(event.key);
					}}
					aria-keyshortcuts="ArrowUp ArrowDown Home End"
					aria-label={`Reorder ${label}, position ${position} of ${total}. Use arrow keys or drag.`}
					className="absolute inset-y-0 left-0 grid w-9 cursor-grab place-items-center rounded-l-lg text-nova-text-muted transition-colors hover:text-nova-violet-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
				>
					<Icon icon={tablerGripVertical} width="14" height="14" />
				</button>
			</SimpleTooltip>
			<div className="flex min-w-0 flex-1 items-start gap-2 py-2 pr-2.5">
				<span className="mt-0.5 w-4 shrink-0 text-center font-mono text-[10px] text-nova-violet-bright">
					{position}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-medium text-nova-text">
						{label}
					</span>
					<span className="mt-0.5 block truncate font-mono text-[9px] text-nova-text-muted">
						{columnSource(column)}
					</span>
					<span className="mt-1 flex flex-wrap gap-1">
						{visibleInList && <PlacementBadge>List</PlacementBadge>}
						{visibleInDetail && <PlacementBadge>Detail</PlacementBadge>}
						{!visibleInList && !visibleInDetail && (
							<PlacementBadge>Supporting only</PlacementBadge>
						)}
					</span>
				</span>
			</div>
		</div>
	);
}

function PlacementBadge({ children }: { readonly children: React.ReactNode }) {
	return (
		<span className="rounded-full border border-nova-border px-1.5 py-px text-[9px] leading-none text-nova-text-muted">
			{children}
		</span>
	);
}

function DisplayOrderDragPreview({ column }: { readonly column: Column }) {
	return (
		<div className="inline-flex items-center gap-1.5 rounded-md border border-nova-violet/40 bg-nova-surface/95 px-2.5 py-1 text-xs text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerArrowsSort}
				width="12"
				height="12"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[220px] truncate">{columnLabel(column)}</span>
		</div>
	);
}
