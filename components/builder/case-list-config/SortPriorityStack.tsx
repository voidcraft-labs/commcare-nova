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
import { ExpressionSlotEditor } from "@/components/builder/shared/ExpressionSlotEditors";
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
import { Input } from "@/components/shadcn/input";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import {
	useCaseListOrderChoiceRefusal,
	useCaseListOrderControls,
} from "@/lib/doc/hooks/useCaseWorkspaceVerdicts";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import { useExpressionSlotContextBuilder } from "@/lib/doc/hooks/useExpressionSlotContext";
import {
	type ProseProjector,
	useProseProjection,
} from "@/lib/doc/hooks/useProseProjection";
import type {
	CasePropertyDataType,
	CaseType,
	Column,
	SortBlanks,
	SortComparison,
	SortDirection,
	Uuid,
} from "@/lib/domain";
import {
	type CalculatedSort,
	type CaseListConfig,
	columnSort,
	orderedColumns,
	sortBlanks,
	type UserProperty,
} from "@/lib/domain";
import { effectiveDataType } from "@/lib/domain/casePropertyTypes";
import {
	type ExpressionContext,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression";
import { prop, term } from "@/lib/domain/expression/builders";
import { platformRefusal, platformSentence } from "@/lib/domain/platforms";
import {
	propertyDisplayLabel,
	propertyDisplayLabelForName,
} from "@/lib/domain/propertyDisplay";
import { useCanEdit } from "@/lib/session/hooks";
import { AuthoredDragPreviewLabel } from "./canvas/canvasChrome";
import { seedColumnForProperty } from "./seeds";
import { blanksAfterDirectionChange } from "./sortBlanksChoice";
import {
	choicesAfterMove,
	columnsAfterRuleSequence,
	columnsWithChoiceOrder,
	orderChoiceColumn,
	orderingCalculationRow,
	resolveSortedColumns,
	ruleWithComparison,
} from "./sortPriority";
import { newUuid } from "./uuid";

export interface CaseOrderingComposerProps {
	/** The module whose list this orders: the Add menu asks the gate's order
	 *  rules about each choice against that module's list. */
	readonly moduleUuid: Uuid;
	/** The whole config, because both lists this composer shows are Results
	 *  sequences: the sorted carriers and the fields still available to add. */
	readonly config: CaseListConfig;
	readonly value: readonly Column[];
	readonly caseType?: CaseType;
	readonly caseTypes?: readonly CaseType[];
	readonly userProperties?: readonly UserProperty[];
	readonly onChange: (
		next: readonly Column[],
		calculations?: readonly CalculatedSort[],
	) => void;
}

/** The column a choice would put in the default order: a stored column, or a
 *  new column over the property, hidden from both screens. The same column is
 *  asked about and committed, so its reason is the commit's. */
interface OrderChoice {
	readonly column: Column;
}

/**
 * Sorting is a relationship between fields, so its overview and full rule
 * sequence belong together here instead of being split between per-field
 * settings and numbered badges. The expanded language reads as a sentence:
 * "First … Then …".
 */
export function CaseOrderingComposer({
	moduleUuid,
	config,
	value,
	caseType,
	caseTypes = [],
	userProperties,
	onChange,
}: CaseOrderingComposerProps) {
	const projectProse = useProseProjection();
	const buildExpressionContext = useExpressionSlotContextBuilder();
	const [draftCalculation, setDraftCalculation] = useState<CalculatedSort>();
	const independent = useMemo(
		() =>
			new Map((config.calculatedSorts ?? []).map((rule) => [rule.uuid, rule])),
		[config.calculatedSorts],
	);
	const columnExpressionContext = useCallback(
		(column: Column) =>
			independent.has(column.uuid)
				? buildExpressionContext({
						entity: "module",
						uuid: moduleUuid,
						slot: "case_list_sort_expression",
						member: { sortUuid: column.uuid },
					})
				: buildExpressionContext(
						{
							entity: "module",
							uuid: moduleUuid,
							slot: "case_list_column_expression",
							member: { columnUuid: column.uuid },
						},
						{ entity: "column", value: column },
					),
		[buildExpressionContext, moduleUuid, independent],
	);
	const canEdit = useCanEdit();
	const containerKey = useId();
	const orderAddReasonId = useId();
	const [expanded, setExpanded] = useState(false);
	const { comparisons, extraFields } = useCaseListOrderControls(
		moduleUuid,
		config,
		expanded,
	);
	const [moveAnnouncement, setMoveAnnouncement] = useState("");
	/* The side of the Blank values control the person last picked, per
	 * column, while this workspace is open: a rule stores `blanks` only where
	 * it differs from its direction's own, so a turn of direction reads the
	 * choice from here (`blanksAfterDirectionChange`). */
	const [pickedBlanks, setPickedBlanks] = useState<
		ReadonlyMap<Uuid, SortBlanks>
	>(() => new Map());
	const pendingRemovalFocusRef = useRef<{
		readonly removedUuid: string;
		readonly nextUuid?: string;
	} | null>(null);
	const composerRef = useRef<HTMLDivElement | null>(null);
	const addRuleTriggerRef = useRef<HTMLButtonElement | null>(null);
	const sorted = useMemo(
		() =>
			[
				...resolveSortedColumns(config),
				...[...independent.values()].map(orderingCalculationRow),
			].sort((a, b) => (a.sort?.priority ?? 0) - (b.sort?.priority ?? 0)),
		[config, independent],
	);
	/* The Add control exists only in the expanded editor, so the document is
	 * read for the menu only while it can open. */
	const orderChoiceRefusal = useCaseListOrderChoiceRefusal(
		moduleUuid,
		expanded && canEdit,
	);
	// Unsorted fields are offered in Results order, which is the order the
	// author sees them on the screen they came from.
	const unsorted = useMemo(
		() =>
			orderedColumns(config, "list").filter(
				(column) => column.sort === undefined,
			),
		[config],
	);
	const orderChoices = useMemo<readonly SearchableChoice<OrderChoice>[]>(() => {
		const choices: SearchableChoice<OrderChoice>[] = [];
		const properties = caseType?.properties ?? [];
		const propertyByName = new Map(
			properties.map((property) => [property.name, property]),
		);
		const sortedPropertyNames = new Set(
			sorted.flatMap((column) =>
				column.kind === "calculated" ? [] : [column.field],
			),
		);
		const unsortedByProperty = new Map<string, Column>();
		for (const column of unsorted) {
			if (column.kind === "calculated") continue;
			const name = column.field;
			const held = unsortedByProperty.get(name);
			/* The first column over the property, unless it is off the list and
			 * a later one is on it: that one can take the rule as it is. */
			if (
				held === undefined ||
				(held.notOnList === true && column.notOnList !== true)
			) {
				unsortedByProperty.set(name, column);
			}
		}
		const tiled = config.tile !== undefined;
		const offered = (column: Column): Column =>
			orderChoiceColumn(column, tiled);
		/* A choice an order rule would refuse stays in the menu, disabled, with
		 * the refusal's own line as its reason: the column `addRule` would
		 * commit, carrying the rule it would take, is put to the gate's order
		 * rules over the list as the choice would leave it. */
		const withheld = (column: Column) =>
			orderChoiceRefusal({
				...column,
				sort: columnSort("asc", sorted.length),
			} as Column);

		for (const property of properties) {
			const name = property.name;
			if (sortedPropertyNames.has(name)) continue;
			const existing = unsortedByProperty.get(name);
			const column =
				(existing === undefined ? undefined : offered(existing)) ??
				seedColumnForProperty(property, projectProse, {
					visibleInList: false,
					visibleInDetail: false,
				});
			const disabledReason = withheld(column);
			choices.push({
				id: `property:${name}`,
				label:
					existing === undefined
						? propertyDisplayLabel(property, projectProse)
						: friendlyColumnLabel(existing, caseType, projectProse),
				group: "Case information",
				value: { column },
				...(disabledReason !== undefined && { disabledReason }),
			});
		}

		for (const column of unsorted) {
			if (column.kind !== "calculated" && propertyByName.has(column.field)) {
				continue;
			}
			const choice = offered(column);
			const disabledReason = withheld(choice);
			choices.push({
				id: `saved:${column.uuid}`,
				label: friendlyColumnLabel(column, caseType, projectProse),
				detail:
					column.kind === "calculated"
						? "Calculated from case information"
						: "Saved information",
				group:
					column.kind === "calculated"
						? "Calculated information"
						: "More information",
				value: { column: choice },
				...(disabledReason !== undefined && { disabledReason }),
			});
		}
		return choices;
	}, [
		caseType,
		config.tile,
		orderChoiceRefusal,
		sorted,
		unsorted,
		projectProse,
	]);
	const orderSummary = useMemo(() => {
		if (sorted.length === 0) return "Ordered by the first column";
		const shown = sorted.slice(0, 2).map((column) => {
			const direction = column.sort?.direction ?? "asc";
			const directionLabel =
				directionOptions(
					column,
					caseType,
					columnExpressionContext(column),
				).find((option) => option.value === direction)?.label ?? "A to Z";
			const blanks = column.sort?.blanks;
			const blanksPhrase = blanks === undefined ? "" : `, blanks ${blanks}`;
			return `${friendlyColumnLabel(column, caseType, projectProse)} ${directionSummaryPhrase(directionLabel)}${blanksPhrase}`;
		});
		const sentence =
			shown.length === 1
				? `Cases are sorted by ${shown[0]}`
				: `Cases are sorted first by ${shown[0]}, then by ${shown[1]}`;
		const remaining = sorted.length - 2;
		return remaining > 0
			? `${sentence}. ${remaining.toLocaleString()} more ${remaining === 1 ? "item breaks" : "items break"} ties.`
			: sentence;
	}, [caseType, columnExpressionContext, projectProse, sorted]);

	const applyRuleSequence = useCallback(
		(nextRules: readonly Column[]) => {
			const positions = new Map(
				nextRules.map((row, index) => [row.uuid, index]),
			);
			const isCalculation = (row: Column) =>
				independent.has(row.uuid) || draftCalculation?.uuid === row.uuid;
			const columns = columnsAfterRuleSequence(
				value,
				nextRules.filter((row) => !isCalculation(row)),
				positions,
			);
			if (!independent.size && !draftCalculation) {
				onChange(columns);
				return;
			}
			// Default order edits priority. A calculation already offered to workers
			// keeps its place in Sort by, including when an HQ edit gave it another priority.
			const byId = new Map(nextRules.map((row) => [row.uuid, row]));
			const calculationIds = [...independent.keys()];
			if (draftCalculation && !independent.has(draftCalculation.uuid))
				calculationIds.push(draftCalculation.uuid);
			const calculations: CalculatedSort[] = calculationIds.flatMap((uuid) => {
				const row = byId.get(uuid);
				const priority = positions.get(uuid);
				if (
					row?.kind !== "calculated" ||
					!row.sort ||
					row.sort.comparator === "distance" ||
					priority === undefined
				)
					return [];
				const { direction, label, blanks, comparator } = row.sort;
				return [
					{
						uuid,
						expression: row.expression,
						priority,
						direction,
						...(label && { label }),
						...(blanks && { blanks }),
						...(comparator && { comparator }),
					},
				];
			});
			onChange(columns, calculations);
		},
		[onChange, value, independent, draftCalculation],
	);

	useEffect(() => {
		if (draftCalculation && independent.has(draftCalculation.uuid))
			setDraftCalculation(undefined);
	}, [draftCalculation, independent]);

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
			const label = friendlyColumnLabel(column, caseType, projectProse);
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
					: `${label} now comes after ${friendlyColumnLabel(preceding, caseType, projectProse)}`,
			);
			applyRuleSequence(next);
		},
		[applyRuleSequence, canEdit, caseType, projectProse, sorted],
	);

	const setDirection = useCallback(
		(columnUuid: Uuid, direction: SortDirection) => {
			if (!canEdit) return;
			applyRuleSequence(
				sorted.map((column) =>
					column.uuid === columnUuid
						? {
								...column,
								sort: blanksAfterDirectionChange(
									column.sort ?? columnSort("asc", 0),
									direction,
									pickedBlanks.get(columnUuid),
								),
							}
						: column,
				),
			);
		},
		[applyRuleSequence, canEdit, pickedBlanks, sorted],
	);

	const setBlanks = useCallback(
		(columnUuid: Uuid, blanks: SortBlanks) => {
			if (!canEdit) return;
			setPickedBlanks((current) => new Map(current).set(columnUuid, blanks));
			applyRuleSequence(
				sorted.map((column) =>
					column.uuid === columnUuid
						? {
								...column,
								sort: columnSort(
									column.sort?.direction ?? "asc",
									column.sort?.priority ?? 0,
									blanks,
									column.sort?.label,
									column.sort?.comparator,
									column.sort?.menuPosition,
								),
							}
						: column,
				),
			);
		},
		[applyRuleSequence, canEdit, sorted],
	);

	/* A rule's name in Sort by, on a column hidden from Results: blank text
	 * removes the name. */
	const setLabel = useCallback(
		(columnUuid: Uuid, label: string | undefined) => {
			if (!canEdit) return;
			applyRuleSequence(
				sorted.map((column) =>
					column.uuid === columnUuid
						? {
								...column,
								sort: columnSort(
									column.sort?.direction ?? "asc",
									column.sort?.priority ?? 0,
									column.sort?.blanks,
									label,
									column.sort?.comparator,
									column.sort?.menuPosition,
								),
							}
						: column,
				),
			);
		},
		[applyRuleSequence, canEdit, sorted],
	);

	const setComparison = (uuid: Uuid, choice: SortComparison | undefined) => {
		if (!canEdit) return;
		applyRuleSequence(
			sorted.map((column) =>
				column.uuid !== uuid || !column.sort
					? column
					: {
							...column,
							sort: ruleWithComparison(
								column.sort,
								choice,
								comparisons.get(uuid),
							),
						},
			),
		);
	};

	const calculatedChoices = [...independent.keys()];
	const fieldById = new Map(value.map((column) => [column.uuid, column]));
	const choiceGroup = (uuid: Uuid) =>
		independent.has(uuid) ? calculatedChoices : extraFields;
	const isNamed = (id: Uuid) =>
		(independent.get(id)?.label ?? fieldById.get(id)?.sort?.label) !==
		undefined;
	const namedChoices = (uuid: Uuid) => choiceGroup(uuid).filter(isNamed);
	const moveChoice = (uuid: Uuid, position: number) => {
		if (!canEdit) return;
		const choices = choicesAfterMove(
			choiceGroup(uuid),
			isNamed,
			uuid,
			position,
		);
		if (choices === undefined) return;
		if (independent.has(uuid)) {
			onChange(
				value,
				choices.map((id) => independent.get(id) as CalculatedSort),
			);
			return;
		}
		onChange(columnsWithChoiceOrder(value, choices), config.calculatedSorts);
	};

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
			applyRuleSequence([
				...sorted,
				{
					...choice.column,
					sort: columnSort("asc", sorted.length),
				} as Column,
			]);
		},
		[applyRuleSequence, canEdit, sorted],
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
							{sorted.length === 0
								? "Ordered by the first column"
								: orderSummary}
						</p>
					</div>
					{(canEdit || sorted.length > 0) && (
						<CollapsibleTrigger
							render={
								<Button
									type="button"
									variant="ghost-action"
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
									className="w-full shrink-0 @min-[28rem]:w-auto"
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
												label={friendlyColumnLabel(
													column,
													caseType,
													projectProse,
												)}
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
													expressionContext={columnExpressionContext(column)}
													connector={index === 0 ? "First" : "Then"}
													canEdit={canEdit}
													setHandleEl={setHandleEl}
													onMove={(key) => moveByKeyboard(index, key)}
													onDirectionChange={(direction) =>
														setDirection(column.uuid, direction)
													}
													independent={independent.has(column.uuid)}
													defaultComparison={comparisons.get(column.uuid)}
													menuChoices={namedChoices(column.uuid)}
													onMenuPositionChange={(position) =>
														moveChoice(column.uuid, position)
													}
													onComparisonChange={(choice) =>
														setComparison(column.uuid, choice)
													}
													onBlanksChange={(blanks) =>
														setBlanks(column.uuid, blanks)
													}
													onLabelChange={(label) =>
														setLabel(column.uuid, label)
													}
													onRemove={() => removeRule(column.uuid)}
												/>
												{canEdit &&
													independent.has(column.uuid) &&
													column.kind === "calculated" && (
														<div className="mt-2 rounded-lg border border-nova-border p-3">
															<ExpressionSlotEditor
																slot={{
																	entity: "module",
																	uuid: moduleUuid,
																	slot: "case_list_sort_expression",
																	member: { sortUuid: column.uuid },
																}}
																value={column.expression}
																onChange={(expression) =>
																	applyRuleSequence(
																		sorted.map((one) =>
																			one.uuid === column.uuid
																				? { ...column, expression }
																				: one,
																		),
																	)
																}
																currentCaseType={caseType?.name ?? ""}
																caseTypes={caseTypes}
																userProperties={userProperties}
															/>
														</div>
													)}
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
										disabled={orderChoices.length === 0}
										aria-describedby={
											orderChoices.length === 0 ? orderAddReasonId : undefined
										}
										className="nova-add-slot w-full"
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
							{caseType &&
								(draftCalculation ? (
									<div className="mt-3 space-y-3 rounded-lg border border-nova-border p-3">
										<p className="font-medium text-nova-text">
											Order calculation
										</p>
										<ExpressionSlotEditor
											slot={{
												entity: "module",
												uuid: moduleUuid,
												slot: "case_list_sort_expression",
												member: { sortUuid: draftCalculation.uuid },
											}}
											candidate={{
												entity: "case-sort",
												value: draftCalculation,
											}}
											value={draftCalculation.expression}
											onChange={(expression) =>
												setDraftCalculation({ ...draftCalculation, expression })
											}
											currentCaseType={caseType.name}
											caseTypes={caseTypes}
											userProperties={userProperties}
										/>
										<div className="flex gap-2">
											<Button
												type="button"
												variant="ghost"
												onClick={() => setDraftCalculation(undefined)}
											>
												Cancel
											</Button>
											<Button
												type="button"
												onClick={() =>
													applyRuleSequence([
														...sorted,
														orderingCalculationRow(draftCalculation),
													])
												}
											>
												Add calculation to order
											</Button>
										</div>
									</div>
								) : (
									<Button
										type="button"
										variant="ghost"
										onClick={() =>
											setDraftCalculation({
												uuid: newUuid(),
												expression: term(prop(caseType.name, "case_name")),
												direction: "asc",
												priority: sorted.length,
											})
										}
									>
										Add calculation
									</Button>
								))}
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
	expressionContext,
	connector,
	canEdit,
	setHandleEl,
	onMove,
	onDirectionChange,
	defaultComparison,
	onComparisonChange,
	menuChoices,
	onMenuPositionChange,
	independent,
	onBlanksChange,
	onLabelChange,
	onRemove,
}: {
	readonly column: Column;
	readonly caseType: CaseType | undefined;
	readonly expressionContext: ExpressionContext | undefined;
	readonly connector: "First" | "Then";
	readonly canEdit: boolean;
	readonly setHandleEl: (el: HTMLElement | null) => void;
	readonly onMove: (key: "ArrowUp" | "ArrowDown" | "Home" | "End") => void;
	readonly onDirectionChange: (direction: SortDirection) => void;
	readonly independent: boolean;
	readonly defaultComparison: SortComparison | undefined;
	readonly onComparisonChange: (choice: SortComparison | undefined) => void;
	readonly menuChoices: readonly Uuid[];
	readonly onMenuPositionChange: (position: number) => void;
	readonly onBlanksChange: (blanks: SortBlanks) => void;
	readonly onLabelChange: (label: string | undefined) => void;
	readonly onRemove: () => void;
}) {
	const projectProse = useProseProjection();
	const platforms = useDeclaredPlatforms();
	const distanceRefusal = platformRefusal("sort-by-distance", platforms);
	/* A field whose display format orders by its own labels takes precedence
	 * over a comparison chosen before it had them; distance alone replaces
	 * the format's order. */
	const chosenComparison =
		defaultComparison === undefined && column.sort?.comparator !== "distance"
			? undefined
			: column.sort?.comparator;
	const comparisonLabel = chosenComparison ?? defaultComparison;
	const shownComparison = comparisonLabel
		? comparisonNames[comparisonLabel]
		: "Field order";
	const choices: readonly SortComparison[] =
		defaultComparison === undefined ? ["distance"] : comparisonOptions;
	const distanceAvailable =
		!independent &&
		(column.sort?.comparator === "distance" ||
			columnDataType(column, caseType, expressionContext) === "geopoint");
	const alternatives = choices.filter(
		(choice) =>
			choice !== defaultComparison &&
			(choice !== "distance" || distanceAvailable),
	);
	const menuPosition = menuChoices.indexOf(column.uuid);
	const menuGroup = independent ? "named calculations" : "extra fields";
	const label = friendlyColumnLabel(column, caseType, projectProse);
	const direction = column.sort?.direction ?? "asc";
	const options = directionOptions(column, caseType, expressionContext);
	const currentDirection =
		options.find((option) => option.value === direction)?.label ??
		options[0].label;
	const blanks = sortBlanks(column.sort ?? columnSort(direction, 0));
	const currentBlanks = BLANKS_OPTIONS.find(
		(option) => option.value === blanks,
	)?.label;

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
						className="nova-focusable-inset h-auto min-h-11 w-11 shrink-0 cursor-grab rounded-l-lg rounded-r-none px-0 text-nova-text-muted hover:bg-white/[0.035] dark:hover:bg-white/[0.035]"
					>
						<Icon icon={tablerGripVertical} width="16" height="16" />
					</Button>
				</SimpleTooltip>
			) : (
				<span className="w-3 shrink-0" aria-hidden="true" />
			)}

			<div className="flex min-w-0 flex-1 flex-col">
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

					{canEdit && alternatives.length > 0 ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button type="button" variant="field" />}
								aria-label={`Compare values for ${label}`}
							>
								{shownComparison}
								<Icon icon={tablerChevronDown} width="14" height="14" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuRadioGroup
									value={chosenComparison ?? "automatic"}
									onValueChange={(value) =>
										onComparisonChange(
											value === "automatic"
												? undefined
												: (value as SortComparison),
										)
									}
								>
									<DropdownMenuRadioItem value="automatic" closeOnClick>
										Use field order
										{defaultComparison
											? ` (${comparisonNames[defaultComparison].toLowerCase()})`
											: ""}
									</DropdownMenuRadioItem>
									{alternatives.map((choice) => (
										<DropdownMenuRadioItem
											key={choice}
											value={choice}
											disabled={
												choice === "distance" && distanceRefusal !== undefined
											}
											closeOnClick
										>
											{comparisonNames[choice]}
											{choice === "distance" && distanceRefusal !== undefined
												? " (Android only)"
												: ""}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					) : (
						<span>{shownComparison}</span>
					)}

					{canEdit ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button type="button" variant="field" />}
								aria-label={`Change direction for ${label}, currently ${currentDirection}`}
								data-case-ordering-direction
								className="w-full shrink-0 @min-[28rem]:w-auto"
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

					{canEdit ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button type="button" variant="field" />}
								aria-label={`Change where blank values sort for ${label}, currently ${currentBlanks}`}
								data-case-ordering-blanks={blanks}
								className="w-full shrink-0 @min-[28rem]:w-auto"
							>
								<span className="text-nova-text-muted">Blank values</span>
								{currentBlanks}
								<Icon icon={tablerChevronDown} width="14" height="14" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" preferredMinWidth="11rem">
								<DropdownMenuRadioGroup
									value={blanks}
									onValueChange={(value) => onBlanksChange(value as SortBlanks)}
								>
									{BLANKS_OPTIONS.map((option) => (
										<DropdownMenuRadioItem
											key={option.value}
											value={option.value}
											closeOnClick
										>
											<span>{option.label}</span>
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					) : (
						<span className="inline-flex min-h-11 w-full items-center gap-1 text-[14px] font-medium text-nova-text-secondary @min-[28rem]:w-auto">
							<span className="text-nova-text-muted">Blank values</span>
							{currentBlanks}
						</span>
					)}
				</div>
				{menuPosition >= 0 &&
					menuChoices.length > 1 &&
					(canEdit ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button type="button" variant="field" />}
								aria-label={`Position of ${label} among ${menuGroup} in Sort by`}
							>
								Sort by position {menuPosition + 1} of {menuChoices.length}
								<Icon icon={tablerChevronDown} width="14" height="14" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuRadioGroup
									value={String(menuPosition)}
									onValueChange={(position) =>
										onMenuPositionChange(Number(position))
									}
								>
									{menuChoices.map((uuid, index) => (
										<DropdownMenuRadioItem
											key={uuid}
											value={String(index)}
											closeOnClick
										>
											{index + 1} of {menuChoices.length} {menuGroup}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					) : (
						<span className="text-sm text-nova-text-secondary">
							Sort by position {menuPosition + 1} of {menuChoices.length}{" "}
							{menuGroup}
						</span>
					))}

				{column.visibleInList === false && column.notOnList !== true && (
					<SortNameField
						columnUuid={column.uuid}
						label={column.sort?.label}
						canEdit={canEdit}
						onChange={onLabelChange}
					/>
				)}
			</div>

			{canEdit && (
				<SimpleTooltip content={`Remove ${label} from the default order`}>
					<Button
						type="button"
						variant="ghost-destructive"
						size="icon"
						onClick={onRemove}
						aria-label={`Remove ${label} from default order`}
					>
						<Icon icon={tablerX} width="15" height="15" />
					</Button>
				</SimpleTooltip>
			)}
		</div>
	);
}
/**
 * The name a column hidden from Results goes by in the list's Sort by menu.
 * The text commits on blur; a blank text removes the name, so the column
 * stays out of Sort by.
 */
function SortNameField({
	columnUuid,
	label,
	canEdit,
	onChange,
}: {
	readonly columnUuid: Uuid;
	readonly label: string | undefined;
	readonly canEdit: boolean;
	readonly onChange: (label: string | undefined) => void;
}) {
	const id = useId();
	const helpId = `${id}-help`;
	const inputRef = useRef<HTMLInputElement>(null);
	const platforms = useDeclaredPlatforms();
	const stored = label ?? "";
	const [draft, setDraft] = useState(stored);
	useEffect(() => {
		if (stored !== draft && document.activeElement !== inputRef.current)
			setDraft(stored);
	}, [stored, draft]);
	const commit = () => {
		const next = draft.trim() === "" ? undefined : draft;
		if (next === label) return;
		if (next === undefined) setDraft("");
		onChange(next);
	};
	const platformNote = platformSentence("case-list-sort-label", platforms);
	return (
		<div className="pb-2.5 pr-2" data-case-ordering-sort-name={columnUuid}>
			<label
				htmlFor={id}
				className="block text-[12px] font-medium text-nova-text-secondary"
			>
				Name in Sort by
			</label>
			<Input
				id={id}
				ref={inputRef}
				value={draft}
				disabled={!canEdit}
				placeholder="Not in Sort by"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
				autoComplete="off"
				data-1p-ignore
				aria-describedby={helpId}
				className="nova-focusable mt-1 h-auto min-h-11 w-full border border-white/[0.06] bg-nova-deep/50 px-3 text-[14px] text-nova-text placeholder:text-nova-text-muted md:text-[14px] dark:bg-nova-deep/50"
			/>
			<p
				id={helpId}
				className="mt-1 text-[12px] leading-5 text-nova-text-muted"
			>
				Workers can order the list by this from Sort by, under this name.
				{platformNote === "" ? "" : ` ${platformNote}`}
			</p>
		</div>
	);
}

/** The Blank values control's two sides. */
const BLANKS_OPTIONS: ReadonlyArray<{
	readonly value: SortBlanks;
	readonly label: string;
}> = [
	{ value: "first", label: "First" },
	{ value: "last", label: "Last" },
];

const comparisonOptions = ["text", "integer", "decimal", "distance"] as const;
const comparisonNames: Record<SortComparison, string> = {
	text: "Text",
	integer: "Whole numbers",
	decimal: "Decimals",
	distance: "Distance from worker",
};

function directionOptions(
	column: Column,
	caseType: CaseType | undefined,
	expressionContext: ExpressionContext | undefined,
): ReadonlyArray<{ readonly value: SortDirection; readonly label: string }> {
	const comparison = column.sort?.comparator;
	if (comparison === "distance")
		return [
			{ value: "asc", label: "Nearest first" },
			{ value: "desc", label: "Farthest first" },
		];
	const dataType =
		comparison === "text"
			? "string"
			: comparison === "integer"
				? "int"
				: comparison === "decimal"
					? "decimal"
					: columnDataType(column, caseType, expressionContext);
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
	expressionContext: ExpressionContext | undefined,
): CasePropertyDataType | undefined {
	if (column.kind === "date" || column.kind === "interval") return "date";
	if (column.kind === "calculated") {
		if (expressionContext === undefined) return undefined;
		const resolved = scalarDataType(
			typeOf(column.expression, expressionContext)?.data,
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
	const property = (caseType?.properties ?? []).find(
		(candidate) => candidate.name === column.field,
	);
	return property === undefined ? undefined : effectiveDataType(property);
}

function friendlyColumnLabel(
	column: Column | undefined,
	caseType: CaseType | undefined,
	project: ProseProjector,
): string {
	if (column === undefined) return "the previous item";
	const authored = column.header.trim();
	if (authored.length > 0) return authored;
	if (!("field" in column)) return "Calculated value";
	return propertyDisplayLabelForName(
		column.field,
		caseType?.properties ?? [],
		project,
	);
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
