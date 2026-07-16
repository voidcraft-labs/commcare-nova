// components/builder/case-list-config/SortPriorityStack.tsx
//
// Friendly center-canvas composition for the order cases appear in. The
// persisted representation remains sort priorities, but authors work with a
// readable First / Then sentence instead of numbered implementation details.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { useCallback, useId, useMemo, useState } from "react";
import { propertyDisplayLabelForName } from "@/components/builder/shared/primitives/propertyDisplay";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { bySortKey } from "@/lib/doc/order/compare";
import type {
	CasePropertyDataType,
	CaseType,
	Column,
	ColumnSort,
	SortDirection,
} from "@/lib/domain";
import {
	authorableCaseProperties,
	canonicalCasePropertyName,
} from "@/lib/domain";
import { effectiveDataType } from "@/lib/domain/casePropertyTypes";
import { checkExpression } from "@/lib/domain/predicate";
import { useCanEdit } from "@/lib/session/hooks";
import { resolveSortedColumns } from "./sortPriority";

export interface CaseOrderingComposerProps {
	readonly value: readonly Column[];
	readonly caseType?: CaseType;
	readonly caseTypes?: readonly CaseType[];
	readonly onChange: (next: readonly Column[]) => void;
}

/**
 * Friendly, center-canvas editor for the order cases appear in. Sorting is a
 * relationship between fields, so the whole rule sequence belongs together
 * here instead of being split between per-field settings and numbered badges.
 * The visible language reads as a sentence: "First … Then …".
 */
export function CaseOrderingComposer({
	value,
	caseType,
	caseTypes = caseType === undefined ? [] : [caseType],
	onChange,
}: CaseOrderingComposerProps) {
	const canEdit = useCanEdit();
	const containerKey = useId();
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const sorted = useMemo(() => resolveSortedColumns(value), [value]);
	const unsorted = useMemo(
		() => value.filter((column) => column.sort === undefined).sort(bySortKey),
		[value],
	);

	const applyRuleSequence = useCallback(
		(nextRules: readonly Column[]) => {
			const sortByUuid = new Map<string, ColumnSort>();
			nextRules.forEach((column, index) => {
				sortByUuid.set(column.uuid, {
					direction: column.sort?.direction ?? "asc",
					priority: index,
				});
			});
			onChange(
				value.map((column) => {
					const nextSort = sortByUuid.get(column.uuid);
					if (nextSort !== undefined) {
						return { ...column, sort: nextSort } as Column;
					}
					if (column.sort === undefined) return column;
					const { sort: _sort, ...withoutSort } = column;
					return withoutSort as Column;
				}),
			);
		},
		[onChange, value],
	);

	const { pendingDrop } = useReorderableList<Column>({
		containerKey,
		containerKind: "case-default-order",
		items: sorted,
		getItemKey: (column) => column.uuid,
		onReorder: applyRuleSequence,
	});

	const moveByKeyboard = useCallback(
		(index: number, key: "ArrowUp" | "ArrowDown" | "Home" | "End") => {
			if (!canEdit) return;
			const column = sorted[index];
			if (column === undefined) return;
			const label = friendlyColumnLabel(column, caseType);
			const targetIndex =
				key === "Home"
					? 0
					: key === "End"
						? sorted.length - 1
						: index + (key === "ArrowUp" ? -1 : 1);
			if (
				targetIndex < 0 ||
				targetIndex >= sorted.length ||
				targetIndex === index
			) {
				setMoveAnnouncement(
					key === "ArrowUp" || key === "Home"
						? `${label} is already first.`
						: `${label} is already last.`,
				);
				return;
			}

			const next = [...sorted];
			const [moved] = next.splice(index, 1);
			if (moved === undefined) return;
			next.splice(targetIndex, 0, moved);
			const preceding = next[targetIndex - 1];
			setMoveAnnouncement(
				targetIndex === 0
					? `${label} now comes first.`
					: `${label} now comes after ${friendlyColumnLabel(preceding, caseType)}.`,
			);
			applyRuleSequence(next);
		},
		[applyRuleSequence, canEdit, caseType, sorted],
	);

	const setDirection = useCallback(
		(columnUuid: string, direction: SortDirection) => {
			if (!canEdit) return;
			applyRuleSequence(
				sorted.map((column) =>
					column.uuid === columnUuid
						? {
								...column,
								sort: {
									direction,
									priority: column.sort?.priority ?? 0,
								},
							}
						: column,
				),
			);
		},
		[applyRuleSequence, canEdit, sorted],
	);

	const removeRule = useCallback(
		(columnUuid: string) => {
			if (!canEdit) return;
			applyRuleSequence(sorted.filter((column) => column.uuid !== columnUuid));
		},
		[applyRuleSequence, canEdit, sorted],
	);

	const addRule = useCallback(
		(column: Column) => {
			if (!canEdit) return;
			applyRuleSequence([
				...sorted,
				{ ...column, sort: { direction: "asc", priority: sorted.length } },
			]);
		},
		[applyRuleSequence, canEdit, sorted],
	);

	return (
		<section
			className="w-full rounded-xl border border-nova-border bg-nova-surface/30 p-4"
			data-case-ordering-composer
		>
			<div className="mb-4">
				<h2 className="font-display text-base font-semibold text-nova-text">
					Default order
				</h2>
				<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
					{canEdit
						? "Choose what matters first. If two cases are the same, the next choice decides."
						: "Cases appear in this order. If two cases are the same, the next choice decides."}
				</p>
			</div>

			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{moveAnnouncement}
			</p>

			{sorted.length === 0 ? (
				<p className="rounded-lg border border-dashed border-nova-border-bright px-4 py-5 text-center text-xs leading-relaxed text-nova-text-muted">
					{canEdit
						? "No default order yet. Choose what should decide which cases appear first."
						: "No default order is set."}
				</p>
			) : (
				<div className="space-y-2" data-case-ordering-rules>
					{sorted.map((column, index) => (
						<ReorderableRow
							key={column.uuid}
							index={index}
							itemKey={column.uuid}
							containerKey={containerKey}
							containerKind="case-default-order"
							pendingDrop={pendingDrop}
							preview={
								<CaseOrderingDragPreview
									label={friendlyColumnLabel(column, caseType)}
								/>
							}
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
												top: closestEdge === "top" ? -5 : undefined,
												bottom: closestEdge === "bottom" ? -5 : undefined,
											}}
										/>
									)}
									<CaseOrderingRuleRow
										column={column}
										caseType={caseType}
										caseTypes={caseTypes}
										connector={index === 0 ? "First" : "Then"}
										canEdit={canEdit}
										setHandleEl={setHandleEl}
										onMove={(key) => moveByKeyboard(index, key)}
										onDirectionChange={(direction) =>
											setDirection(column.uuid, direction)
										}
										onRemove={() => removeRule(column.uuid)}
									/>
									{previewPortal}
								</div>
							)}
						</ReorderableRow>
					))}
				</div>
			)}

			{canEdit && (
				<div className="mt-3">
					<DropdownMenu>
						<DropdownMenuTrigger
							type="button"
							disabled={unsorted.length === 0}
							aria-label="Add another way to sort cases"
							className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-nova-border-bright px-4 text-[13px] font-medium text-nova-violet-bright transition-colors not-disabled:hover:bg-nova-violet/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
						>
							<Icon icon={tablerPlus} width="15" height="15" />
							{unsorted.length === 0
								? "All available information is used"
								: "Add another way to sort"}
							<Icon icon={tablerChevronDown} width="14" height="14" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="min-w-64">
							{unsorted.map((column) => (
								<DropdownMenuItem
									key={column.uuid}
									onClick={() => addRule(column)}
									className="min-h-11"
								>
									{friendlyColumnLabel(column, caseType)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}
		</section>
	);
}

function CaseOrderingRuleRow({
	column,
	caseType,
	caseTypes,
	connector,
	canEdit,
	setHandleEl,
	onMove,
	onDirectionChange,
	onRemove,
}: {
	readonly column: Column;
	readonly caseType: CaseType | undefined;
	readonly caseTypes: readonly CaseType[];
	readonly connector: "First" | "Then";
	readonly canEdit: boolean;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: "ArrowUp" | "ArrowDown" | "Home" | "End") => void;
	readonly onDirectionChange: (direction: SortDirection) => void;
	readonly onRemove: () => void;
}) {
	const label = friendlyColumnLabel(column, caseType);
	const direction = column.sort?.direction ?? "asc";
	const options = directionOptions(column, caseType, caseTypes);
	const currentDirection =
		options.find((option) => option.value === direction)?.label ??
		options[0].label;

	return (
		<div
			className="flex min-h-16 w-full items-stretch rounded-lg border border-white/[0.06] bg-nova-deep/40"
			data-case-ordering-rule={column.uuid}
		>
			{canEdit ? (
				<SimpleTooltip content="Drag to reorder · arrow keys move this rule">
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
						aria-label={`Reorder ${label}. ${connector} rule. Use arrow keys or drag.`}
						className="grid min-h-11 w-11 shrink-0 cursor-grab place-items-center rounded-l-lg text-nova-text-muted transition-colors hover:text-nova-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
					>
						<Icon icon={tablerGripVertical} width="16" height="16" />
					</button>
				</SimpleTooltip>
			) : (
				<span className="w-3 shrink-0" aria-hidden="true" />
			)}

			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-2">
				<div className="min-w-0 flex-1">
					<span className="block text-[11px] font-medium text-nova-violet-bright">
						{connector}
					</span>
					<span className="block truncate text-[13px] font-medium text-nova-text">
						{label}
					</span>
				</div>

				{canEdit ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							type="button"
							aria-label={`Change direction for ${label}. Current: ${currentDirection}.`}
							className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-nova-border px-3 text-xs font-medium text-nova-text-secondary transition-colors hover:border-nova-border-bright hover:text-nova-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nova-violet"
						>
							{currentDirection}
							<Icon icon={tablerChevronDown} width="14" height="14" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-44">
							{options.map((option) => (
								<DropdownMenuItem
									key={option.value}
									onClick={() => onDirectionChange(option.value)}
									className="min-h-11"
								>
									<span>{option.label}</span>
									{option.value === direction && (
										<Icon
											icon={tablerCheck}
											width="14"
											height="14"
											className="ml-auto text-nova-violet-bright"
										/>
									)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					<span className="inline-flex min-h-11 items-center text-xs font-medium text-nova-text-secondary">
						{currentDirection}
					</span>
				)}
			</div>

			{canEdit && (
				<SimpleTooltip content={`Remove ${label} from the default order`}>
					<button
						type="button"
						onClick={onRemove}
						aria-label={`Remove ${label} from default order`}
						className="grid min-h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-r-lg text-nova-text-muted transition-colors hover:text-nova-rose focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet"
					>
						<Icon icon={tablerX} width="15" height="15" />
					</button>
				</SimpleTooltip>
			)}
		</div>
	);
}
function directionOptions(
	column: Column,
	caseType: CaseType | undefined,
	caseTypes: readonly CaseType[],
): ReadonlyArray<{ readonly value: SortDirection; readonly label: string }> {
	const dataType = columnDataType(column, caseType, caseTypes);
	if (dataType === "date" || dataType === "datetime" || dataType === "time") {
		return [
			{ value: "asc", label: "Earliest first" },
			{ value: "desc", label: "Latest first" },
		];
	}
	if (dataType === "int" || dataType === "decimal") {
		return [
			{ value: "asc", label: "Lowest first" },
			{ value: "desc", label: "Highest first" },
		];
	}
	return [
		{ value: "asc", label: "A to Z" },
		{ value: "desc", label: "Z to A" },
	];
}

function columnDataType(
	column: Column,
	caseType: CaseType | undefined,
	caseTypes: readonly CaseType[],
): CasePropertyDataType | undefined {
	if (column.kind === "date" || column.kind === "interval") return "date";
	if (column.kind === "calculated") {
		if (caseType === undefined) return undefined;
		const resolved = checkExpression(
			column.expression,
			{
				caseTypes: [...caseTypes],
				knownInputs: [],
				currentCaseType: caseType.name,
			},
			[],
			[],
		);
		if (
			resolved === "int" ||
			resolved === "decimal" ||
			resolved === "date" ||
			resolved === "datetime" ||
			resolved === "time" ||
			resolved === "text" ||
			resolved === "single_select" ||
			resolved === "multi_select" ||
			resolved === "geopoint"
		) {
			return resolved;
		}
		return undefined;
	}
	if (!("field" in column)) return undefined;
	const property = authorableCaseProperties(caseType?.properties ?? []).find(
		(candidate) => candidate.name === canonicalCasePropertyName(column.field),
	);
	return property === undefined ? undefined : effectiveDataType(property);
}

function friendlyColumnLabel(
	column: Column | undefined,
	caseType: CaseType | undefined,
): string {
	if (column === undefined) return "the previous rule";
	const authored = column.header.trim();
	if (authored.length > 0) return authored;
	if (!("field" in column)) return "Calculated field";
	return propertyDisplayLabelForName(column.field, caseType?.properties ?? []);
}

function CaseOrderingDragPreview({ label }: { readonly label: string }) {
	return (
		<div className="inline-flex items-center gap-2 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-2 text-xs text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerArrowsSort}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<span className="max-w-[220px] truncate">{label}</span>
		</div>
	);
}
