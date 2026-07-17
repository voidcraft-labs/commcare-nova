// components/builder/case-list-config/canvas/DisplayFieldComposer.tsx
//
// The direct-manipulation field stack shared by Results and Details.
// Each screen owns its own order: the row the author drags is the row the
// worker sees in that screen. The right rail remains the home for one field's
// formatting and data source; membership and order live here, where their
// effect is visible.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import { useId, useMemo, useState } from "react";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { Column } from "@/lib/domain";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { useCanEdit } from "@/lib/session/hooks";
import { renderColumnCell } from "../columnCellRenderer";
import { columnLabel } from "./ColumnInventory";
import { AddGhostButton } from "./canvasChrome";

export type DisplaySurface = "list" | "detail";

export interface DisplayFieldComposerProps {
	readonly columns: readonly Column[];
	readonly surface: DisplaySurface;
	readonly sampleRow: CaseRowWithCalculated | undefined;
	readonly selectedUuid: string | null;
	readonly brokenColumns: ReadonlySet<string>;
	readonly onSelect: (column: Column) => void;
	readonly onMove: (uuid: Column["uuid"], toIndex: number) => void;
}

export function DisplayFieldComposer({
	columns,
	surface,
	sampleRow,
	selectedUuid,
	brokenColumns,
	onSelect,
	onMove,
}: DisplayFieldComposerProps) {
	const canEdit = useCanEdit();
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: `case-${surface}-fields`,
		items: columns,
		getItemKey: (column) => column.uuid,
		onReorder: (_next, move) => {
			if (canEdit) onMove(move.item.uuid, move.toIndex);
		},
	});

	const screenName = surface === "list" ? "results" : "details";

	const moveByKeyboard = (
		index: number,
		key: "ArrowUp" | "ArrowDown" | "Home" | "End",
	) => {
		const column = columns[index];
		if (column === undefined || !canEdit) return;
		const targetIndex =
			key === "Home"
				? 0
				: key === "End"
					? columns.length - 1
					: index + (key === "ArrowUp" ? -1 : 1);
		if (
			targetIndex < 0 ||
			targetIndex >= columns.length ||
			targetIndex === index
		) {
			setMoveAnnouncement(
				`${columnLabel(column)} is already at the ${targetIndex <= 0 ? "beginning" : "end"} of ${screenName}.`,
			);
			return;
		}
		setMoveAnnouncement(
			`${columnLabel(column)} moved ${key === "ArrowUp" || key === "Home" ? "earlier" : "later"} in ${screenName}.`,
		);
		onMove(column.uuid, targetIndex);
	};

	return (
		<div className="space-y-2" data-display-field-composer={surface}>
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>
			{columns.map((column, index) => (
				<ReorderableRow
					key={column.uuid}
					index={index}
					itemKey={column.uuid}
					containerKey={containerKey}
					containerKind={`case-${surface}-fields`}
					pendingDrop={pendingDrop}
					preview={<FieldDragPreview column={column} />}
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
									className="absolute left-3 right-3 z-10 h-0.5 rounded-full bg-nova-violet"
									style={{
										top: closestEdge === "top" ? -5 : undefined,
										bottom: closestEdge === "bottom" ? -5 : undefined,
									}}
								/>
							)}
							<FieldRow
								column={column}
								surface={surface}
								sampleRow={sampleRow}
								selected={selectedUuid === column.uuid}
								broken={brokenColumns.has(column.uuid)}
								canEdit={canEdit}
								position={index + 1}
								total={columns.length}
								setHandleEl={setHandleEl}
								onMove={(key) => moveByKeyboard(index, key)}
								onSelect={() => onSelect(column)}
							/>
							{previewPortal}
						</div>
					)}
				</ReorderableRow>
			))}
		</div>
	);
}

function FieldRow({
	column,
	surface,
	sampleRow,
	selected,
	broken,
	canEdit,
	position,
	total,
	setHandleEl,
	onMove,
	onSelect,
}: {
	readonly column: Column;
	readonly surface: DisplaySurface;
	readonly sampleRow: CaseRowWithCalculated | undefined;
	readonly selected: boolean;
	readonly broken: boolean;
	readonly canEdit: boolean;
	readonly position: number;
	readonly total: number;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: "ArrowUp" | "ArrowDown" | "Home" | "End") => void;
	readonly onSelect: () => void;
}) {
	const label = columnLabel(column);
	const screenName = surface === "list" ? "results" : "details";
	const sample =
		sampleRow === undefined
			? "Example value"
			: renderColumnCell(column, sampleRow);

	return (
		<div
			className={`group/field flex min-h-[72px] items-stretch overflow-hidden rounded-xl border transition-colors ${
				selected
					? "border-nova-violet bg-nova-violet/[0.08] shadow-[0_0_0_1px_color-mix(in_oklab,var(--nova-violet),transparent_55%)]"
					: broken
						? "border-nova-rose/40 bg-nova-rose/[0.03]"
						: "border-white/[0.07] bg-nova-deep/35 hover:border-nova-border-bright hover:bg-white/[0.025]"
			}`}
			data-case-field-role="visible"
			data-column-uuid={column.uuid}
		>
			{canEdit && (
				<SimpleTooltip content="Drag to move · Arrow keys work too" side="left">
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
						aria-label={`Move ${label} in ${screenName}. Position ${position} of ${total}. Use arrow keys or drag.`}
						className="grid w-11 shrink-0 cursor-grab place-items-center text-nova-text-muted transition-colors hover:bg-white/[0.035] hover:text-nova-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
					>
						<Icon icon={tablerGripVertical} width="17" height="17" />
					</button>
				</SimpleTooltip>
			)}

			<button
				type="button"
				onClick={onSelect}
				disabled={!canEdit}
				aria-pressed={selected}
				className="grid min-w-0 flex-1 cursor-pointer grid-cols-1 items-center gap-1 px-3 py-3 text-left disabled:cursor-default @min-[34rem]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @min-[34rem]:gap-5"
			>
				<span className="min-w-0">
					<span className="flex items-center gap-2">
						<span className="truncate text-[13px] font-semibold text-nova-text">
							{label}
						</span>
						{broken && (
							<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-nova-rose">
								<Icon icon={tablerAlertCircle} width="14" height="14" />
								Needs attention
							</span>
						)}
					</span>
				</span>
				<span
					className={`min-w-0 break-words text-[13px] leading-relaxed ${
						sampleRow === undefined
							? "text-nova-text-muted"
							: "text-nova-text-secondary"
					}`}
				>
					{sample}
				</span>
			</button>
		</div>
	);
}

/**
 * One calm add affordance owns both normal creation and the rare recovery of
 * information removed from this screen. Off-screen fields never occupy
 * permanent canvas real estate; they appear only after the author asks to add
 * something.
 */
export function AddInformationControl({
	surface,
	columns,
	brokenColumns,
	onShow,
	onRepair,
	onCreate,
	createDisabledReason,
}: {
	readonly surface: DisplaySurface;
	readonly columns: readonly Column[];
	readonly brokenColumns: ReadonlySet<string>;
	readonly onShow: (column: Column) => void;
	readonly onRepair: (column: Column) => void;
	readonly onCreate: () => void;
	readonly createDisabledReason: string | undefined;
}) {
	const canEdit = useCanEdit();
	const [query, setQuery] = useState("");
	const hasBrokenRecovery = columns.some((column) =>
		brokenColumns.has(column.uuid),
	);
	const filteredColumns = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (normalized === "") return columns;
		return columns.filter((column) =>
			columnLabel(column).toLocaleLowerCase().includes(normalized),
		);
	}, [columns, query]);
	if (!canEdit) return null;

	if (columns.length === 0) {
		return (
			<AddGhostButton
				label="Add information"
				onClick={onCreate}
				disabledReason={createDisabledReason}
				className="w-full"
				dataCaseAdd={surface}
			/>
		);
	}

	return (
		<DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
			<DropdownMenuTrigger
				type="button"
				aria-label={
					hasBrokenRecovery
						? "Add information, one existing item needs attention"
						: "Add information"
				}
				data-case-add={surface}
				className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-nova-border-bright px-4 text-[13px] text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.06]"
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span>Add information</span>
				{hasBrokenRecovery && (
					<span
						className="size-1.5 rounded-full bg-nova-rose"
						aria-hidden="true"
					/>
				)}
				<Icon icon={tablerChevronDown} width="14" height="14" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="flex max-h-[min(28rem,var(--available-height))] min-w-72 flex-col overflow-hidden py-0"
			>
				<div className="shrink-0 border-b border-white/[0.06] p-2">
					<label className="flex min-h-11 items-center gap-2 rounded-lg border border-white/[0.08] bg-nova-deep/55 px-3 focus-within:border-nova-violet/40">
						<Icon
							icon={tablerSearch}
							width="14"
							height="14"
							className="shrink-0 text-nova-text-muted"
						/>
						<span className="sr-only">Find information</span>
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Find information"
							autoComplete="off"
							data-1p-ignore
							className="min-w-0 flex-1 bg-transparent text-[13px] text-nova-text outline-none placeholder:text-nova-text-muted"
						/>
					</label>
				</div>
				<DropdownMenuGroup
					className="min-h-0 flex-1 overflow-y-auto py-1"
					data-add-information-scroll-region
				>
					<DropdownMenuLabel>Available information</DropdownMenuLabel>
					{filteredColumns.map((column) => (
						<DropdownMenuItem
							key={column.uuid}
							onClick={() =>
								brokenColumns.has(column.uuid)
									? onRepair(column)
									: onShow(column)
							}
							className="min-h-11"
						>
							<Icon icon={tablerPlus} width="14" height="14" />
							<span className="min-w-0 flex-1 truncate">
								{columnLabel(column)}
							</span>
							{brokenColumns.has(column.uuid) && (
								<span className="text-[11px] text-nova-rose">
									Fix before adding
								</span>
							)}
						</DropdownMenuItem>
					))}
					{filteredColumns.length === 0 && (
						<p className="px-2 py-4 text-center text-[12px] text-nova-text-muted">
							No information matches “{query}”.
						</p>
					)}
				</DropdownMenuGroup>
				<div
					className="shrink-0 border-t border-white/[0.06] p-1"
					data-add-information-footer
				>
					<DropdownMenuItem
						disabled={createDisabledReason !== undefined}
						onClick={onCreate}
						className="min-h-11 rounded-lg"
					>
						<Icon icon={tablerPlus} width="14" height="14" />
						<span className="min-w-0 flex-1">Create new information</span>
						{createDisabledReason !== undefined && (
							<span className="text-[10px] text-nova-text-muted">
								{createDisabledReason}
							</span>
						)}
					</DropdownMenuItem>
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function FieldDragPreview({ column }: { readonly column: Column }) {
	return (
		<div className="inline-flex items-center gap-2 rounded-xl border border-nova-violet/35 bg-nova-surface/95 px-3 py-2 text-[13px] text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="15"
				height="15"
				className="text-nova-text-muted"
			/>
			<span className="max-w-[240px] truncate">{columnLabel(column)}</span>
		</div>
	);
}
