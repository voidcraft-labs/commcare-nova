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
import tablerX from "@iconify-icons/tabler/x";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type SearchableChoice,
	SearchableChoiceCombobox,
} from "@/components/builder/case-list-config/SearchableChoiceCombobox";
import {
	propertyDisplayLabel,
	propertyDisplayLabelForName,
} from "@/components/builder/shared/primitives/propertyDisplay";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { appendOrderKey } from "@/lib/doc/order/append";
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
import { AuthoredDragPreviewLabel } from "./canvas/canvasChrome";
import { seedColumnForProperty } from "./seeds";
import { resolveSortedColumns } from "./sortPriority";

export interface CaseOrderingComposerProps {
	readonly value: readonly Column[];
	readonly caseType?: CaseType;
	readonly caseTypes?: readonly CaseType[];
	readonly onChange: (next: readonly Column[]) => void;
}

type OrderChoice =
	| { readonly kind: "existing"; readonly column: Column }
	| {
			readonly kind: "property";
			readonly property: CaseType["properties"][number];
	  };

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
	const orderAddReasonId = useId();
	const [expanded, setExpanded] = useState(false);
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	const pendingRemovalFocusRef = useRef<{
		readonly removedUuid: string;
		readonly nextUuid?: string;
	} | null>(null);
	const composerRef = useRef<HTMLDivElement | null>(null);
	const addRuleTriggerRef = useRef<HTMLButtonElement | null>(null);
	const sorted = useMemo(() => resolveSortedColumns(value), [value]);
	const unsorted = useMemo(
		() => value.filter((column) => column.sort === undefined).sort(bySortKey),
		[value],
	);
	const orderChoices = useMemo<readonly SearchableChoice<OrderChoice>[]>(() => {
		const choices: SearchableChoice<OrderChoice>[] = [];
		const properties = authorableCaseProperties(caseType?.properties ?? []);
		const propertyByName = new Map(
			properties.map((property) => [
				canonicalCasePropertyName(property.name),
				property,
			]),
		);
		const sortedPropertyNames = new Set(
			sorted.flatMap((column) =>
				column.kind === "calculated"
					? []
					: [canonicalCasePropertyName(column.field)],
			),
		);
		const unsortedByProperty = new Map<string, Column>();
		for (const column of unsorted) {
			if (column.kind === "calculated") continue;
			const name = canonicalCasePropertyName(column.field);
			if (!unsortedByProperty.has(name)) unsortedByProperty.set(name, column);
		}

		for (const property of properties) {
			const name = canonicalCasePropertyName(property.name);
			if (sortedPropertyNames.has(name)) continue;
			const existing = unsortedByProperty.get(name);
			choices.push({
				id: `property:${name}`,
				label:
					existing === undefined
						? propertyDisplayLabel(property)
						: friendlyColumnLabel(existing, caseType),
				group: "Case information",
				value:
					existing === undefined
						? { kind: "property", property }
						: { kind: "existing", column: existing },
			});
		}

		for (const column of unsorted) {
			if (
				column.kind !== "calculated" &&
				propertyByName.has(canonicalCasePropertyName(column.field))
			) {
				continue;
			}
			choices.push({
				id: `saved:${column.uuid}`,
				label: friendlyColumnLabel(column, caseType),
				detail:
					column.kind === "calculated"
						? "Calculated from case information"
						: "Saved information",
				group:
					column.kind === "calculated"
						? "Calculated information"
						: "More information",
				value: { kind: "existing", column },
			});
		}
		return choices;
	}, [caseType, sorted, unsorted]);
	const orderSummary = useMemo(() => {
		if (sorted.length === 0) return "No default order";
		const shown = sorted.slice(0, 2).map((column) => {
			const direction = column.sort?.direction ?? "asc";
			const directionLabel =
				directionOptions(column, caseType, caseTypes).find(
					(option) => option.value === direction,
				)?.label ?? "A to Z";
			return `${friendlyColumnLabel(column, caseType)} ${directionSummaryPhrase(directionLabel)}`;
		});
		const sentence =
			shown.length === 1
				? `Cases are sorted by ${shown[0]}`
				: `Cases are sorted first by ${shown[0]}, then by ${shown[1]}`;
		const remaining = sorted.length - 2;
		return remaining > 0
			? `${sentence}. ${remaining.toLocaleString()} more ${remaining === 1 ? "item breaks" : "items break"} ties.`
			: sentence;
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
			const nextColumns = [...value];
			const knownUuids = new Set(value.map((column) => column.uuid));
			for (const column of nextRules) {
				if (knownUuids.has(column.uuid)) continue;
				knownUuids.add(column.uuid);
				nextColumns.push(column);
			}
			onChange(
				nextColumns.map((column) => {
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
		itemKeys: sorted.map((column) => column.uuid),
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
						? `${label} is already first`
						: `${label} is already last`,
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
					? `${label} now comes first`
					: `${label} now comes after ${friendlyColumnLabel(preceding, caseType)}`,
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
			const index = sorted.findIndex((column) => column.uuid === columnUuid);
			const adjacent =
				index < 0 ? undefined : (sorted[index + 1] ?? sorted[index - 1]);
			pendingRemovalFocusRef.current = {
				removedUuid: columnUuid,
				...(adjacent === undefined ? {} : { nextUuid: adjacent.uuid }),
			};
			applyRuleSequence(sorted.filter((column) => column.uuid !== columnUuid));
		},
		[applyRuleSequence, canEdit, sorted],
	);

	/* Removing a rule unmounts the button that initiated the action. Once the
	 * controlled value confirms that removal, hand focus to the adjacent rule's
	 * move handle, or to Add to order when the sequence is empty. Keeping this
	 * pending in a ref also works with an asynchronous controlled parent and
	 * never steals focus when a removal is rejected. */
	useEffect(() => {
		const pending = pendingRemovalFocusRef.current;
		if (
			pending === null ||
			sorted.some((column) => column.uuid === pending.removedUuid)
		) {
			return;
		}
		pendingRemovalFocusRef.current = null;
		const handles = Array.from(
			composerRef.current?.querySelectorAll<HTMLElement>(
				"[data-case-ordering-focus-key]",
			) ?? [],
		);
		const preferred =
			pending.nextUuid === undefined
				? undefined
				: handles.find(
						(handle) =>
							handle.dataset.caseOrderingFocusKey === pending.nextUuid,
					);
		const fallback =
			preferred ??
			(sorted[0] === undefined ? addRuleTriggerRef.current : handles[0]);
		fallback?.focus();
	}, [sorted]);

	const addRule = useCallback(
		(choice: OrderChoice) => {
			if (!canEdit) return;
			const column =
				choice.kind === "existing"
					? choice.column
					: {
							...seedColumnForProperty(choice.property, {
								visibleInList: false,
								visibleInDetail: false,
							}),
							order: appendOrderKey(value),
						};
			applyRuleSequence([
				...sorted,
				{ ...column, sort: { direction: "asc", priority: sorted.length } },
			]);
		},
		[applyRuleSequence, canEdit, sorted, value],
	);

	return (
		<div ref={composerRef} className="w-full" data-case-ordering-composer>
			<Collapsible open={expanded} onOpenChange={setExpanded}>
				<div className="flex min-h-[72px] flex-wrap items-center gap-3 px-4 py-3">
					<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.035] text-nova-text-muted">
						<Icon icon={tablerArrowsSort} width="16" height="16" />
					</span>
					<div className="min-w-0 flex-1">
						<p
							className={`break-words text-[14px] leading-relaxed ${sorted.length === 0 ? "text-nova-text-muted" : "font-medium text-nova-text"}`}
						>
							<span className="sr-only">Current order </span>
							{sorted.length === 0 ? "No order set" : orderSummary}
						</p>
					</div>
					{(canEdit || sorted.length > 0) && (
						<CollapsibleTrigger
							render={
								<Button
									type="button"
									variant="ghost"
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
									className="min-h-11 w-full shrink-0 px-3 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.08] dark:not-disabled:hover:bg-nova-violet/[0.08] @min-[28rem]:w-auto"
								/>
							}
						>
							{expanded
								? canEdit
									? "Done"
									: "Close"
								: sorted.length === 0
									? "Set order"
									: canEdit
										? "Change order"
										: "View order"}
						</CollapsibleTrigger>
					)}
				</div>

				<CollapsibleContent className="border-t border-white/[0.07] bg-nova-deep/20 px-4 pb-4 pt-3">
					<p className="mb-3 text-[13px] leading-relaxed text-nova-text-muted">
						{canEdit
							? "The first item decides the order. If two cases have the same value, drag the next item into place to break the tie."
							: "The first item decides the order. If two cases have the same value, the next item breaks the tie."}
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
						<p className="rounded-lg border border-dashed border-nova-border-bright px-4 py-5 text-center text-[13px] leading-relaxed text-nova-text-muted">
							Choose what decides which cases appear first
						</p>
					) : (
						<ol
							aria-label="Default order"
							className="list-none space-y-2 p-0"
							data-case-ordering-rules
						>
							{sorted.map((column, index) => (
								<li key={column.uuid}>
									<ReorderableRow
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
								</li>
							))}
						</ol>
					)}

					{canEdit && (
						<div className="mt-3">
							<SearchableChoiceCombobox
								choices={orderChoices}
								onChoose={(choice) => addRule(choice.value)}
								trigger={
									<Button
										ref={addRuleTriggerRef}
										type="button"
										variant="ghost"
										size="xl"
										disabled={orderChoices.length === 0}
										aria-describedby={
											orderChoices.length === 0 ? orderAddReasonId : undefined
										}
										className="w-full border border-dashed border-nova-border-bright px-4 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.06] dark:not-disabled:hover:bg-nova-violet/[0.06]"
									/>
								}
								triggerLabel="Add to default order"
								triggerContent={
									<>
										<Icon icon={tablerPlus} width="15" height="15" />
										<span className="flex-1">Add to order</span>
									</>
								}
								heading="Add to default order"
								description="Choose what decides which cases appear first"
								searchLabel="Search case information"
								searchPlaceholder="Search case information"
								contentClassName="max-h-[min(22rem,var(--available-height))]"
							/>
							{orderChoices.length === 0 && (
								<p
									id={orderAddReasonId}
									className="mt-2 text-center text-[13px] leading-relaxed text-nova-text-muted"
								>
									All available case information is already in the default order
								</p>
							)}
						</div>
					)}
				</CollapsibleContent>
			</Collapsible>
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
				<SimpleTooltip content="Drag or use arrow keys">
					<Button
						type="button"
						variant="ghost"
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
						aria-label={`Move ${label}. ${connector} in the order. Use arrow keys or drag.`}
						data-case-ordering-focus-key={column.uuid}
						className="h-auto min-h-11 w-11 shrink-0 cursor-grab rounded-l-lg rounded-r-none px-0 text-nova-text-muted hover:bg-white/[0.035] hover:text-nova-text focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-nova-violet dark:hover:bg-white/[0.035]"
					>
						<Icon icon={tablerGripVertical} width="16" height="16" />
					</Button>
				</SimpleTooltip>
			) : (
				<span className="w-3 shrink-0" aria-hidden="true" />
			)}

			<div
				className="flex min-w-0 flex-1 flex-col items-stretch gap-2 py-2.5 pr-2 @min-[28rem]:flex-row @min-[28rem]:items-center @min-[28rem]:gap-3"
				data-case-ordering-rule-body
			>
				<div className="min-w-0 w-full @min-[28rem]:flex-1">
					<span className="block text-[12px] font-medium text-nova-violet-bright">
						{connector}
					</span>
					<span className="block min-w-0 break-words whitespace-normal text-[14px] font-medium text-nova-text">
						{label}
					</span>
				</div>

				{canEdit ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={<Button type="button" variant="outline" size="xl" />}
							aria-label={`Change direction for ${label}, currently ${currentDirection}`}
							data-case-ordering-direction
							className="min-h-11 w-full shrink-0 justify-between border-nova-border bg-transparent px-3 text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-border-bright not-disabled:hover:bg-transparent not-disabled:hover:text-nova-text dark:bg-transparent dark:not-disabled:hover:bg-transparent @min-[28rem]:w-auto"
						>
							{currentDirection}
							<Icon icon={tablerChevronDown} width="14" height="14" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" preferredMinWidth="11rem">
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
					<span className="inline-flex min-h-11 w-full items-center text-[14px] font-medium text-nova-text-secondary @min-[28rem]:w-auto">
						{currentDirection}
					</span>
				)}
			</div>

			{canEdit && (
				<SimpleTooltip content={`Remove ${label} from the default order`}>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={onRemove}
						aria-label={`Remove ${label} from default order`}
						className="min-h-11 w-11 rounded-l-none rounded-r-lg text-nova-text-muted not-disabled:hover:bg-transparent not-disabled:hover:text-nova-rose dark:not-disabled:hover:bg-transparent"
					>
						<Icon icon={tablerX} width="15" height="15" />
					</Button>
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

/** Turn a standalone menu choice into a phrase that reads naturally after a
 * field name in the overview sentence. */
function directionSummaryPhrase(label: string): string {
	switch (label) {
		case "A to Z":
			return "from A to Z";
		case "Z to A":
			return "from Z to A";
		case "Earliest first":
			return "from earliest to latest";
		case "Latest first":
			return "from latest to earliest";
		case "Lowest first":
			return "with the lowest value first";
		case "Highest first":
			return "with the highest value first";
		default:
			return label.toLocaleLowerCase();
	}
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
	if (column === undefined) return "the previous item";
	const authored = column.header.trim();
	if (authored.length > 0) return authored;
	if (!("field" in column)) return "Calculated value";
	return propertyDisplayLabelForName(column.field, caseType?.properties ?? []);
}

function CaseOrderingDragPreview({ label }: { readonly label: string }) {
	return (
		<div className="inline-flex items-center gap-2 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-2 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerArrowsSort}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<AuthoredDragPreviewLabel>{label}</AuthoredDragPreviewLabel>
		</div>
	);
}
