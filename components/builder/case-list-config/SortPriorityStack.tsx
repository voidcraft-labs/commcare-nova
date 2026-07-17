// components/builder/case-list-config/SortPriorityStack.tsx
//
// Friendly center-canvas composition for the order cases appear in. A compact
// readable summary stays visible; the First / Then drag editor expands in
// place only when the author asks to change it. The persisted representation
// remains sort priorities rather than leaking numbered implementation details.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
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
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
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
import { handleMenuSearchInputKeyDown } from "@/lib/ui/menuSearchInput";
import { resolveSortedColumns } from "./sortPriority";

export interface CaseOrderingComposerProps {
	readonly value: readonly Column[];
	readonly caseType?: CaseType;
	readonly caseTypes?: readonly CaseType[];
	readonly onChange: (next: readonly Column[]) => void;
}

/**
 * Sorting is a relationship between fields, so its overview and full rule
 * sequence belong together here instead of being split between per-field
 * settings and numbered badges. The expanded language reads as a sentence:
 * "First … Then …".
 */
export function CaseOrderingComposer({
	value,
	caseType,
	caseTypes = caseType === undefined ? [] : [caseType],
	onChange,
}: CaseOrderingComposerProps) {
	const canEdit = useCanEdit();
	const containerKey = useId();
	const editorId = useId();
	const [expanded, setExpanded] = useState(false);
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const [sortQuery, setSortQuery] = useState("");
	const sorted = useMemo(() => resolveSortedColumns(value), [value]);
	const unsorted = useMemo(
		() => value.filter((column) => column.sort === undefined).sort(bySortKey),
		[value],
	);
	const visibleUnsorted = useMemo(() => {
		const normalized = sortQuery.trim().toLocaleLowerCase();
		if (normalized === "") return unsorted;
		return unsorted.filter((column) =>
			friendlyColumnLabel(column, caseType)
				.toLocaleLowerCase()
				.includes(normalized),
		);
	}, [caseType, sortQuery, unsorted]);
	const orderSummary = useMemo(() => {
		if (sorted.length === 0) return "No default order is set.";
		const shown = sorted
			.slice(0, 2)
			.map((column) => {
				const direction = column.sort?.direction ?? "asc";
				const label =
					directionOptions(column, caseType, caseTypes).find(
						(option) => option.value === direction,
					)?.label ?? "A to Z";
				return `${friendlyColumnLabel(column, caseType)}, ${label}`;
			})
			.join("; then ");
		const remaining = sorted.length - 2;
		return `${shown}${remaining > 0 ? `; and ${remaining} more` : ""}.`;
	}, [caseType, caseTypes, sorted]);

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
		<div className="w-full" data-case-ordering-composer>
			<div className="flex min-h-[72px] flex-wrap items-center gap-3 px-4 py-3">
				<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.035] text-nova-text-muted">
					<Icon icon={tablerArrowsSort} width="16" height="16" />
				</span>
				<div className="min-w-0 flex-1">
					<h3 className="text-[13px] font-semibold text-nova-text">
						Default order
					</h3>
					<p className="mt-0.5 text-[12px] leading-relaxed text-nova-text-muted">
						{orderSummary}
					</p>
				</div>
				{(canEdit || sorted.length > 0) && (
					<button
						type="button"
						onClick={() => setExpanded((open) => !open)}
						aria-expanded={expanded}
						aria-controls={editorId}
						aria-label={
							expanded
								? canEdit
									? "Finish editing default order"
									: "Close default order details"
								: sorted.length === 0
									? "Set default order"
									: canEdit
										? "Change default order"
										: "View full default order"
						}
						className="min-h-11 w-full shrink-0 cursor-pointer rounded-lg px-3 text-[12px] font-medium text-nova-violet-bright transition-colors hover:bg-nova-violet/[0.08] @min-[28rem]:w-auto"
					>
						{expanded
							? canEdit
								? "Done"
								: "Close"
							: sorted.length === 0
								? "Set order"
								: canEdit
									? "Change"
									: "View"}
					</button>
				)}
			</div>

			{expanded && (
				<div
					id={editorId}
					className="border-t border-white/[0.07] bg-nova-deep/20 px-4 pb-4 pt-3"
				>
					<p className="mb-3 text-xs leading-relaxed text-nova-text-muted">
						{canEdit
							? "Drag to decide what matters first. If two cases match, the next choice decides."
							: "Cases are compared in this order. If two cases match, the next choice decides."}
					</p>

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
							Choose what should decide which cases appear first.
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
							<DropdownMenu onOpenChange={(open) => !open && setSortQuery("")}>
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
								<DropdownMenuContent
									align="start"
									className="flex max-h-[min(28rem,var(--available-height))] min-w-72 flex-col overflow-hidden p-0"
								>
									<div className="shrink-0 border-b border-white/[0.06] p-2">
										<label className="flex min-h-11 items-center gap-2 rounded-lg border border-white/[0.08] bg-nova-deep/55 px-3 focus-within:border-nova-violet/40">
											<Icon
												icon={tablerSearch}
												width="14"
												height="14"
												className="shrink-0 text-nova-text-muted"
											/>
											<span className="sr-only">
												Find information to sort by
											</span>
											<input
												type="search"
												value={sortQuery}
												onChange={(event) => setSortQuery(event.target.value)}
												onKeyDown={handleMenuSearchInputKeyDown}
												placeholder="Find information"
												autoComplete="off"
												data-1p-ignore
												className="min-w-0 flex-1 bg-transparent text-[13px] text-nova-text outline-none placeholder:text-nova-text-muted"
											/>
										</label>
									</div>
									<div className="min-h-0 flex-1 overflow-y-auto p-1">
										{visibleUnsorted.map((column) => (
											<DropdownMenuItem
												key={column.uuid}
												onClick={() => addRule(column)}
												className="min-h-11"
											>
												{friendlyColumnLabel(column, caseType)}
											</DropdownMenuItem>
										))}
										{visibleUnsorted.length === 0 && (
											<p className="px-3 py-4 text-center text-[12px] text-nova-text-muted">
												No information matches “{sortQuery}”.
											</p>
										)}
									</div>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					)}
				</div>
			)}
		</div>
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
							<DropdownMenuRadioGroup
								value={direction}
								onValueChange={(value) =>
									onDirectionChange(value as SortDirection)
								}
							>
								{options.map((option) => (
									<DropdownMenuRadioItem
										key={option.value}
										value={option.value}
										closeOnClick
										className="min-h-11"
									>
										<span>{option.label}</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
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
