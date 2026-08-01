/**
 * The one source editor for select choices.
 *
 * A select persists exactly one required `optionsSource` arm. Inline choices
 * and Project-table choices are never parallel, nullable, dormant, or used as
 * fallbacks for one another. Switching arms is therefore staged locally and
 * replaces the complete source only when the author confirms a valid target;
 * Cancel leaves the committed source byte-for-byte untouched.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerFilter from "@iconify-icons/tabler/filter";
import { useCallback, useId, useMemo, useState } from "react";
import { useBuilderLookupCatalog } from "@/components/builder/lookup/BuilderLookupCatalogProvider";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import type { EditorFormFieldDecl } from "@/components/builder/shared/formFieldPresentation";
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
import { lookupFilterEligibleFormFields } from "@/lib/doc/formFieldEntries";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useFormFieldEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import {
	asUuid,
	DEFAULT_SELECT_OPTIONS,
	type InlineOptionsSource,
	type LookupColumnId,
	type LookupOptionsSource,
	type LookupTableId,
	type MultiSelectField,
	type SelectOptionsSource,
	type SingleSelectField,
} from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import type { Predicate } from "@/lib/domain/predicate";
import { useSelectedFormContext } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { OptionsEditorWidget } from "./OptionsEditor";

const INLINE = "inline";

interface LookupSourceDraft {
	readonly kind: "lookup";
	readonly tableId: LookupTableId;
	readonly valueColumnId?: LookupColumnId;
	readonly labelColumnId?: LookupColumnId;
	readonly filter?: Predicate;
}

type SourceDraft = InlineOptionsSource | LookupSourceDraft;

function freshInlineSource(): InlineOptionsSource {
	return {
		kind: "inline",
		options: DEFAULT_SELECT_OPTIONS.map((option) => ({
			...option,
			uuid: asUuid(crypto.randomUUID()),
		})),
	};
}

function withoutFilter(
	source: LookupSourceDraft | LookupOptionsSource,
): Omit<typeof source, "filter"> {
	const { filter: _filter, ...identity } = source;
	return identity;
}

/**
 * Generic across only the two select kinds. Both declare the same canonical
 * source union; a non-select field cannot type-check at this boundary.
 */
export function OptionsSourceEditor<
	F extends SingleSelectField | MultiSelectField,
>({ field, value, onChange }: FieldEditorComponentProps<F, "optionsSource">) {
	const modeId = useId();
	const valueColumnSelectId = useId();
	const labelColumnSelectId = useId();
	const canEdit = useCanEdit();
	const catalog = useBuilderLookupCatalog();
	const formContext = useSelectedFormContext();
	const formUuid = formContext?.form.uuid;
	const entries = useFormFieldEntries(formUuid ?? field.uuid);
	const caseTypes = useCaseTypes();
	const userProperties = useUserProperties();
	const source = value as SelectOptionsSource;
	const [draft, setDraft] = useState<SourceDraft | null>(null);
	const [rejection, setRejection] = useState<string | null>(null);

	const tables = catalog.kind === "ready" ? catalog.tables : [];
	const tablesById =
		catalog.kind === "ready"
			? catalog.byId
			: new Map<LookupTableId, (typeof tables)[number]>();
	const active = draft ?? source;
	const activeLookup = active.kind === "lookup" ? active : undefined;
	const table =
		activeLookup === undefined
			? undefined
			: tablesById.get(activeLookup.tableId);
	const tableScope =
		table === undefined
			? undefined
			: { tableId: table.id, columns: table.columns };
	const formFields = useMemo<readonly EditorFormFieldDecl[]>(
		() =>
			formUuid === undefined
				? []
				: lookupFilterEligibleFormFields(entries, field.uuid).map((entry) => ({
						uuid: entry.uuid,
						id: entry.id,
						label: entry.label,
						dataType: entry.dataType,
					})),
		[entries, field.uuid, formUuid],
	);

	const commit = useCallback(
		(next: SelectOptionsSource) => {
			const outcome = onChange(next);
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
			if (outcome.ok) setDraft(null);
			return outcome;
		},
		[onChange],
	);

	const selectedSource = active.kind === "inline" ? INLINE : active.tableId;

	const beginSource = (next: string | null): void => {
		if (next === null) return;
		setRejection(null);
		if (next === INLINE) {
			if (source.kind === "inline") {
				setDraft(null);
				return;
			}
			setDraft(freshInlineSource());
			return;
		}
		const selectedTable = tables.find((candidate) => candidate.id === next);
		if (selectedTable === undefined) {
			setRejection(
				"That Project data table is no longer available. Choose another table.",
			);
			return;
		}
		const tableId = selectedTable.id;
		if (source.kind === "lookup" && source.tableId === tableId) {
			setDraft(null);
			return;
		}
		/* Columns intentionally start unchosen. Silently binding both roles to
		 * the first column makes a complete-looking source without the author
		 * ever saying which value is stored or shown. */
		setDraft({ kind: "lookup", tableId });
	};

	const writeLookup = (next: LookupSourceDraft | LookupOptionsSource): void => {
		if (draft?.kind === "lookup") {
			setDraft(next);
			setRejection(null);
			return;
		}
		if (next.valueColumnId === undefined || next.labelColumnId === undefined) {
			setRejection(
				"Choose both the saved-value column and the display column.",
			);
			return;
		}
		commit({
			kind: "lookup",
			tableId: next.tableId,
			valueColumnId: next.valueColumnId,
			labelColumnId: next.labelColumnId,
			...(next.filter === undefined ? {} : { filter: next.filter }),
		});
	};

	const changeFilter = (next: Predicate | undefined): void => {
		if (activeLookup === undefined) return;
		const identity = withoutFilter(activeLookup);
		writeLookup(next === undefined ? identity : { ...identity, filter: next });
	};

	const completeLookupDraft = useMemo<LookupOptionsSource | undefined>(() => {
		if (
			draft?.kind !== "lookup" ||
			table === undefined ||
			draft.valueColumnId === undefined ||
			draft.labelColumnId === undefined ||
			!table.columns.some((column) => column.id === draft.valueColumnId) ||
			!table.columns.some((column) => column.id === draft.labelColumnId)
		) {
			return undefined;
		}
		return {
			kind: "lookup",
			tableId: draft.tableId,
			valueColumnId: draft.valueColumnId,
			labelColumnId: draft.labelColumnId,
			...(draft.filter === undefined ? {} : { filter: draft.filter }),
		};
	}, [draft, table]);

	return (
		<div className="space-y-3" data-field-id="options-source">
			<div>
				<Label htmlFor={modeId} className="text-[13px]">
					Where the choices come from
				</Label>
				<Select
					value={selectedSource}
					disabled={!canEdit}
					onValueChange={beginSource}
				>
					<SelectTrigger id={modeId} wrapValue className="mt-1 min-h-11 w-full">
						<SelectValue>
							{(selected) => {
								if (selected === INLINE) return "Options in this question";
								const selectedTable = tables.find(
									(candidate) => candidate.id === selected,
								);
								if (selectedTable !== undefined) return selectedTable.name;
								if (catalog.kind === "loading") {
									return "Loading Project data tables…";
								}
								if (catalog.kind === "error") {
									return "Project data tables didn’t load";
								}
								return "A data table that is no longer available";
							}}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={INLINE}>Options in this question</SelectItem>
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
					Loading this Project’s data-table definitions…
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
			) : null}

			{active.kind === "inline" ? (
				<>
					<OptionsEditorWidget
						key={draft?.kind === "inline" ? "draft-inline" : "current-inline"}
						options={active.options}
						slotKeyBase={field.uuid}
						onSave={(options) => {
							const next: InlineOptionsSource = { kind: "inline", options };
							if (draft?.kind === "inline") {
								setDraft(next);
								setRejection(null);
								return { ok: true };
							}
							return commit(next);
						}}
					/>
					{draft?.kind === "inline" ? (
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								onClick={() => {
									setDraft(null);
									setRejection(null);
								}}
							>
								Cancel
							</Button>
							<Button
								type="button"
								disabled={!canEdit || draft.options.length < 2}
								onClick={() => commit(draft)}
							>
								Use these options
							</Button>
						</div>
					) : null}
				</>
			) : table === undefined ? (
				catalog.kind === "ready" ? (
					<p
						role="alert"
						className="text-[13px] leading-relaxed text-nova-rose"
					>
						This question points at a data table that isn’t in this Project
						anymore. Choose another table or author new inline options.
					</p>
				) : null
			) : (
				<>
					<div>
						<Label htmlFor={valueColumnSelectId} className="text-[13px]">
							Value that gets saved
						</Label>
						<Select
							value={active.valueColumnId ?? null}
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
								writeLookup({
									...active,
									valueColumnId: column.id,
								});
							}}
						>
							<SelectTrigger
								id={valueColumnSelectId}
								wrapValue
								className="mt-1 min-h-11 w-full"
							>
								<SelectValue placeholder="Choose a column">
									{(selected) =>
										/* A render function replaces the placeholder entirely, so
										 * the unchosen case has to be handled here: a column
										 * nobody has picked yet is not a column that went
										 * missing. */
										selected === null || selected === undefined
											? "Choose a column"
											: (table.columns.find((column) => column.id === selected)
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

					<div>
						<Label htmlFor={labelColumnSelectId} className="text-[13px]">
							Value people see
						</Label>
						<Select
							value={active.labelColumnId ?? null}
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
								writeLookup({
									...active,
									labelColumnId: column.id,
								});
							}}
						>
							<SelectTrigger
								id={labelColumnSelectId}
								wrapValue
								className="mt-1 min-h-11 w-full"
							>
								<SelectValue placeholder="Choose a column">
									{(selected) =>
										/* A render function replaces the placeholder entirely, so
										 * the unchosen case has to be handled here: a column
										 * nobody has picked yet is not a column that went
										 * missing. */
										selected === null || selected === undefined
											? "Choose a column"
											: (table.columns.find((column) => column.id === selected)
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
						{active.filter === undefined ? (
							<>
								<p className="text-[13px] leading-relaxed text-nova-text-secondary">
									Every row of “{table.name}” is offered. Add a rule to match
									this table’s columns against an earlier answer, fixed value,
									or current-user information.
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
										variant="outline"
										className="w-full border-dashed"
										onClick={() => {
											if (tableScope === undefined) return;
											changeFilter(
												firstComparisonDefault({
													caseTypes,
													currentCaseType: "",
													knownInputs: [],
													userProperties,
													formFields,
													lookupTables: tables,
													tableScope,
													caseDataScope: "table-row",
												}),
											);
										}}
									>
										Add row rule
									</Button>
								) : null}
							</>
						) : (
							<>
								<p className="text-[13px] leading-relaxed text-nova-text-secondary">
									Only matching rows are offered. These choices are built before
									there is a case row or a search screen, so case data and
									case-search answers are unavailable here, as are later answers
									and answers inside a child or sibling repeat.
								</p>
								<fieldset disabled={!canEdit} className="contents">
									<PredicateWorkbench
										value={active.filter}
										onChange={changeFilter}
										onRemoveRoot={() => changeFilter(undefined)}
										removeRootLabel="Offer every row"
										rootLabel="Row rule"
										caseTypes={caseTypes}
										currentCaseType=""
										knownInputs={[]}
										userProperties={userProperties}
										formFields={formFields}
										lookupTables={tables}
										tableScope={tableScope}
										caseDataScope="table-row"
										evaluationTarget="on-device"
									/>
								</fieldset>
							</>
						)}
					</div>

					{draft?.kind === "lookup" ? (
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								onClick={() => {
									setDraft(null);
									setRejection(null);
								}}
							>
								Cancel
							</Button>
							<Button
								type="button"
								disabled={!canEdit || completeLookupDraft === undefined}
								onClick={() => {
									if (completeLookupDraft !== undefined) {
										commit(completeLookupDraft);
									}
								}}
							>
								Use this table
							</Button>
						</div>
					) : null}
				</>
			)}

			<RejectionInline message={rejection} />
		</div>
	);
}
