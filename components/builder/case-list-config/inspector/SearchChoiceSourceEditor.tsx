// components/builder/case-list-config/inspector/SearchChoiceSourceEditor.tsx
//
// Where a choice search field's options come from. A `select` or
// `multi-select` prompt reads its choices from one Project data table, the
// same source vocabulary a lookup-backed form question uses: the table, the
// column whose value is saved as the answer, the column people read, the
// column whose text orders the choices (the label column unless another is
// chosen), and an optional rule over the table's rows.
//
// Two modes share one body. With a SAVED source, each column change commits
// on its own (both columns are still chosen, so every intermediate state is a
// complete source) and picking another table stages a replacement. With NO
// saved source (the author just chose a choice widget for a field that had
// none) the whole thing is a staged draft, and the field only changes type
// once the draft is complete. Cancel leaves the field exactly as it was.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerFilter from "@iconify-icons/tabler/filter";
import { useId, useMemo, useState } from "react";
import { useBuilderLookupCatalog } from "@/components/builder/lookup/BuilderLookupCatalogProvider";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import { editorAxesOf } from "@/components/builder/shared/editorAxes";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useExpressionSlotContext } from "@/lib/doc/hooks/useExpressionSlotContext";
import type {
	CaseType,
	LookupColumnId,
	LookupTableId,
	SearchInputDef,
	SearchInputLookupOptions,
	UserProperty,
} from "@/lib/domain";
import type { Expression, ExpressionSlotRef } from "@/lib/domain/expression";
import { useCanEdit } from "@/lib/session/hooks";

export interface SearchChoiceSourceEditorProps {
	readonly slot: ExpressionSlotRef | undefined;
	readonly candidateForSource: (
		source: SearchInputLookupOptions,
	) => SearchInputDef;
	/** The saved source, or `undefined` while the author is still choosing
	 *  one for a field that has no choices yet. */
	readonly value: SearchInputLookupOptions | undefined;
	readonly caseTypes: readonly CaseType[];
	readonly userProperties: readonly UserProperty[];
	readonly rowIndex: number;
	/** Receives only complete sources. */
	readonly onCommit: (next: SearchInputLookupOptions) => void;
	/** Offered only while no source is saved: leaves the field unchanged. */
	readonly onCancel?: () => void;
}

interface LookupSourceDraft {
	readonly tableId: LookupTableId;
	readonly valueColumnId?: LookupColumnId;
	readonly labelColumnId?: LookupColumnId;
	/** Absent means the choices are ordered by the label column. */
	readonly sortColumnId?: LookupColumnId;
	readonly filter?: Expression;
}

/** The sort picker's item for "order by the label column". */
const LABEL_COLUMN_SORT = "label-column";

function completeSource(
	draft: LookupSourceDraft,
	columnIds: ReadonlySet<LookupColumnId>,
): SearchInputLookupOptions | undefined {
	if (
		draft.valueColumnId === undefined ||
		draft.labelColumnId === undefined ||
		!columnIds.has(draft.valueColumnId) ||
		!columnIds.has(draft.labelColumnId)
	) {
		return undefined;
	}
	return {
		kind: "lookup",
		tableId: draft.tableId,
		valueColumnId: draft.valueColumnId,
		labelColumnId: draft.labelColumnId,
		/* A sort column equal to the label column is the default's other
		 * spelling, and one that left the table orders by the label too. */
		...(draft.sortColumnId === undefined ||
		draft.sortColumnId === draft.labelColumnId ||
		!columnIds.has(draft.sortColumnId)
			? {}
			: { sortColumnId: draft.sortColumnId }),
		...(draft.filter === undefined ? {} : { filter: draft.filter }),
	};
}

export function SearchChoiceSourceEditor({
	slot,
	candidateForSource,
	value,
	caseTypes,
	userProperties,
	rowIndex,
	onCommit,
	onCancel,
}: SearchChoiceSourceEditorProps) {
	const tableSelectId = useId();
	const valueColumnSelectId = useId();
	const labelColumnSelectId = useId();
	const sortColumnSelectId = useId();
	const canEdit = useCanEdit();
	const catalog = useBuilderLookupCatalog();
	const [draft, setDraft] = useState<LookupSourceDraft | null>(null);
	const [rejection, setRejection] = useState<string | null>(null);

	const tables = catalog.kind === "ready" ? catalog.tables : [];
	const active: LookupSourceDraft | undefined = draft ?? value;
	const table =
		active === undefined || catalog.kind !== "ready"
			? undefined
			: catalog.byId.get(active.tableId);
	const columnIds = useMemo(
		() => new Set(table?.columns.map((column) => column.id) ?? []),
		[table],
	);
	const staging = draft !== null || value === undefined;
	const completeDraft =
		draft === null ? undefined : completeSource(draft, columnIds);
	const completeActive =
		active === undefined ? undefined : completeSource(active, columnIds);
	const expressionContext = useExpressionSlotContext(
		completeActive === undefined ? undefined : slot,
		completeActive === undefined
			? undefined
			: { entity: "search-input", value: candidateForSource(completeActive) },
	);

	const chooseTable = (next: string | null) => {
		if (next === null) return;
		setRejection(null);
		const selected = tables.find((candidate) => candidate.id === next);
		if (selected === undefined) {
			setRejection(
				"That Project data table is no longer available. Choose another table.",
			);
			return;
		}
		if (value !== undefined && value.tableId === selected.id) {
			setDraft(null);
			return;
		}
		/* Columns start unchosen on purpose: binding both roles to the first
		 * column would make a complete-looking source nobody chose. */
		setDraft({ tableId: selected.id });
	};

	const write = (next: LookupSourceDraft) => {
		if (staging) {
			setDraft(next);
			setRejection(null);
			return;
		}
		const complete = completeSource(next, columnIds);
		if (complete === undefined) {
			setRejection(
				"Choose both the saved-value column and the display column.",
			);
			return;
		}
		onCommit(complete);
	};

	const changeFilter = (next: Expression | undefined) => {
		if (active === undefined) return;
		const { filter: _filter, ...identity } = active;
		write(next === undefined ? identity : { ...identity, filter: next });
	};

	const columnSelect = (
		id: string,
		label: string,
		selected: LookupColumnId | undefined,
		onPick: (columnId: LookupColumnId) => void,
	) => {
		if (table === undefined) return null;
		return (
			<div>
				<Label htmlFor={id} className="text-[13px]">
					{label}
				</Label>
				<Select
					value={selected ?? null}
					disabled={!canEdit}
					onValueChange={(next) => {
						const column = table.columns.find(
							(candidate) => candidate.id === next,
						);
						if (column === undefined) {
							setRejection(
								"That column is no longer available. Choose another column.",
							);
							return;
						}
						onPick(column.id);
					}}
				>
					<SelectTrigger id={id} wrapValue className="mt-1 min-h-11 w-full">
						<SelectValue placeholder="Choose a column">
							{(current) =>
								current === null || current === undefined
									? "Choose a column"
									: (table.columns.find((column) => column.id === current)
											?.label ?? "A column that is no longer available")
							}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{table.columns.map((column) => (
							<SelectItem key={column.id} value={column.id} wrap>
								{column.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		);
	};

	return (
		<section
			className="space-y-3"
			data-search-choice-source
			aria-label={`Search field ${rowIndex + 1} choices`}
		>
			<div>
				<Label htmlFor={tableSelectId} className="text-[13px]">
					Table the choices come from
				</Label>
				<Select
					value={active?.tableId ?? null}
					disabled={!canEdit || catalog.kind !== "ready"}
					onValueChange={chooseTable}
				>
					<SelectTrigger
						id={tableSelectId}
						wrapValue
						className="mt-1 min-h-11 w-full"
					>
						<SelectValue placeholder="Choose a table">
							{(selected) => {
								if (selected === null || selected === undefined) {
									return catalog.kind === "loading"
										? "Loading Project data tables"
										: "Choose a table";
								}
								const selectedTable = tables.find(
									(candidate) => candidate.id === selected,
								);
								if (selectedTable !== undefined) return selectedTable.name;
								if (catalog.kind === "loading") {
									return "Loading Project data tables";
								}
								if (catalog.kind === "error") {
									return "Project data tables didn't load";
								}
								return "A data table that is no longer available";
							}}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{tables.map((candidate) => (
							<SelectItem key={candidate.id} value={candidate.id} wrap>
								{candidate.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{catalog.kind === "loading" ? (
				<p
					role="status"
					className="text-[12px] leading-snug text-nova-text-muted"
				>
					Loading this Project's data-table definitions
				</p>
			) : catalog.kind === "error" ? (
				<div
					role="alert"
					className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3"
				>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{catalog.message}
					</p>
					<Button
						type="button"
						variant="outline"
						className="mt-2"
						onClick={() => void catalog.retry()}
					>
						Try again
					</Button>
				</div>
			) : catalog.kind === "ready" && tables.length === 0 ? (
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					This Project has no data tables yet. Add one in Project data, then
					come back to choose it here.
				</p>
			) : null}

			{active !== undefined &&
			table === undefined &&
			catalog.kind === "ready" ? (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					This field points at a data table that isn't in this Project anymore.
					Choose another table.
				</p>
			) : null}

			{active !== undefined && table !== undefined ? (
				<>
					{columnSelect(
						valueColumnSelectId,
						"Value that gets saved",
						active.valueColumnId,
						(columnId) => write({ ...active, valueColumnId: columnId }),
					)}
					{columnSelect(
						labelColumnSelectId,
						"Value people see",
						active.labelColumnId,
						(columnId) => write({ ...active, labelColumnId: columnId }),
					)}
					<div>
						<Label htmlFor={sortColumnSelectId} className="text-[13px]">
							Sort choices by
						</Label>
						<Select
							value={active.sortColumnId ?? LABEL_COLUMN_SORT}
							disabled={!canEdit}
							onValueChange={(next) => {
								const { sortColumnId: _sort, ...rest } = active;
								if (next === LABEL_COLUMN_SORT) {
									write(rest);
									return;
								}
								const column = table.columns.find(
									(candidate) => candidate.id === next,
								);
								if (column === undefined) {
									setRejection(
										"That column is no longer available. Choose another column.",
									);
									return;
								}
								write({ ...rest, sortColumnId: column.id });
							}}
						>
							<SelectTrigger
								id={sortColumnSelectId}
								wrapValue
								className="mt-1 min-h-11 w-full"
							>
								<SelectValue>
									{(current) =>
										current === LABEL_COLUMN_SORT ||
										current === null ||
										current === undefined
											? "Label column"
											: (table.columns.find((column) => column.id === current)
													?.label ?? "A column that is no longer available")
									}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={LABEL_COLUMN_SORT} wrap>
									Label column
								</SelectItem>
								{table.columns.map((column) => (
									<SelectItem key={column.id} value={column.id} wrap>
										{column.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
							Choices are listed in the order of this column's text.
						</p>
					</div>

					<div className="space-y-3 rounded-lg border border-nova-border bg-nova-elevated p-3">
						<p className="flex items-start gap-2 text-[13px] font-medium text-nova-text">
							<Icon
								icon={tablerFilter}
								width="16"
								height="16"
								className="mt-0.5 shrink-0 text-nova-text-muted"
								aria-hidden="true"
							/>
							Rows people can choose
						</p>
						{expressionContext === undefined ? (
							<p role="status" className="text-[13px] text-nova-text-muted">
								Choose the saved value and label columns to add a row rule.
							</p>
						) : active.filter === undefined ? (
							<>
								<p className="text-[13px] leading-relaxed text-nova-text-secondary">
									Every row of “{table.name}” is offered. Add a rule to match
									this table's columns against a fixed value or current-user
									information.
								</p>
								{table.columns.length === 0 ? (
									<p
										role="status"
										className="text-[12px] leading-snug text-nova-text-muted"
									>
										Add a column to this table before authoring a row rule.
									</p>
								) : canEdit ? (
									<Button
										type="button"
										variant="ghost"
										className="nova-add-slot w-full"
										onClick={() =>
											changeFilter(
												firstComparisonDefault({
													expressionContext,
													caseTypes,
													currentCaseType: "",
													knownInputs: [],
													userProperties,
													lookupTables: tables,
													...editorAxesOf(expressionContext, tables),
												}),
											)
										}
									>
										Add row rule
									</Button>
								) : null}
							</>
						) : (
							<>
								<p className="text-[13px] leading-relaxed text-nova-text-secondary">
									Only matching rows are offered. The choices are built when the
									Search screen opens, so case data and other search answers are
									unavailable here.
								</p>
								<fieldset disabled={!canEdit} className="contents">
									<PredicateWorkbench
										expressionContext={expressionContext}
										value={active.filter}
										onChange={changeFilter}
										onRemoveRoot={() => changeFilter(undefined)}
										removeRootLabel="Offer every row"
										rootLabel="Row rule"
										caseTypes={caseTypes}
										currentCaseType=""
										knownInputs={[]}
										userProperties={userProperties}
										lookupTables={tables}
									/>
								</fieldset>
							</>
						)}
					</div>
				</>
			) : null}

			{staging ? (
				<div className="flex justify-end gap-2">
					{onCancel !== undefined || draft !== null ? (
						<Button
							type="button"
							variant="ghost"
							onClick={() => {
								setDraft(null);
								setRejection(null);
								if (value === undefined) onCancel?.();
							}}
						>
							Cancel
						</Button>
					) : null}
					<Button
						type="button"
						disabled={!canEdit || completeDraft === undefined}
						onClick={() => {
							if (completeDraft === undefined) return;
							setDraft(null);
							onCommit(completeDraft);
						}}
					>
						Use this table
					</Button>
				</div>
			) : null}

			<RejectionInline message={rejection} />
		</section>
	);
}
