/**
 * Where a select's choices come from: typed in here, or a column of a Project
 * data table.
 *
 * **The switch is asymmetric, and the asymmetry is the feature's correctness.**
 * `optionsSource` precedence is presence-based at every consumer, so:
 *
 *   - choosing a table SETS the source and leaves the typed-in options exactly
 *     where they are, so switching back restores the author's prior choices;
 *   - choosing typed-in options CLEARS the source. Anything less and the
 *     retained table keeps winning while the editor claims otherwise.
 *
 * `lib/doc/lookupOptionsSourceMutations.ts` records why the clear is spelled
 * `null` rather than `undefined`.
 *
 * A row filter mounts the shared predicate editor in its explicit table-row
 * scope. The active definition supplies only this table's columns; the form
 * projection supplies only earlier answers in root/current/enclosing repeat
 * scope. The commit gate derives the same admission from the same canonical
 * form walk and rechecks it against the exact lookup revision.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerFilter from "@iconify-icons/tabler/filter";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useFormFieldEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import type { Field, FieldPatchFor } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import type { LookupOptionsSource } from "@/lib/domain/lookupCarriers";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { Predicate } from "@/lib/domain/predicate";
import { useNavigate, useSelectedFormContext } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { useProjectLookupDefinitions } from "./useProjectLookupDefinitions";

/** The value the "typed in here" choice carries in the mode select. */
const INLINE = "inline";

/**
 * Generic over the field kind for the same reason `OptionsEditor` is: the
 * registry types each kind's schema against that exact kind, so a component
 * pinned to the union is not assignable to either. Only the two select kinds
 * declare `optionsSource`, which is what makes the indexed access safe.
 */
export function OptionsSourceEditor<F extends Field>({
	field,
}: FieldEditorComponentProps<F, "optionsSource" & keyof F>) {
	const modeId = useId();
	const valueId = useId();
	const labelColumnId = useId();
	const canEdit = useCanEdit();
	const navigate = useNavigate();
	const formContext = useSelectedFormContext();
	const formUuid = formContext?.form.uuid;
	const fieldEntries = useFormFieldEntries(formUuid ?? field.uuid);
	const caseTypes = useCaseTypes();
	const userProperties = useUserProperties();
	const source =
		"optionsSource" in field
			? (field.optionsSource as LookupOptionsSource | undefined)
			: undefined;
	/* The table being CONSIDERED, held until its columns arrive.
	 *
	 * Binding needs a value and a label column, and columns are a separate read
	 * from the table list. Choosing a table therefore cannot commit in the same
	 * tick: the pick records an intent here, the hook fetches that table, and
	 * the effect below commits once there is something to bind to. Committing
	 * immediately with whatever columns happened to be loaded is what made the
	 * picker a silent no-op — nothing was loaded, so nothing ever committed. */
	const [considering, setConsidering] = useState<LookupTableId | null>(null);
	const tables = useProjectLookupDefinitions(considering ?? source?.tableId);
	const {
		inline: { updateField },
	} = useBlueprintMutations(tables.lookupContext);
	const [commitFailure, setCommitFailure] = useState<readonly string[]>([]);
	const table =
		source === undefined ? undefined : tables.byId.get(source.tableId);
	const formFields = useMemo<readonly EditorFormFieldDecl[]>(
		() =>
			formUuid === undefined
				? []
				: lookupFilterEligibleFormFields(fieldEntries, field.uuid).map(
						(entry) => ({
							uuid: entry.uuid,
							id: entry.id,
							label: entry.label,
							dataType: entry.dataType,
						}),
					),
		[field.uuid, fieldEntries, formUuid],
	);
	const tableVocabulary = useMemo(
		() =>
			table === undefined
				? []
				: [
						{
							id: table.id,
							name: table.name,
							columns: table.columns,
						},
					],
		[table],
	);
	const tableScope = useMemo(
		() =>
			table === undefined
				? undefined
				: { tableId: table.id, columns: table.columns },
		[table],
	);

	const commit = useCallback(
		(next: LookupOptionsSource | undefined) => {
			/* `undefined` is the builder's in-memory spelling for "remove this
			 * slot". The doc-diff persistence path turns it into the durable
			 * `null` — `lib/doc/lookupOptionsSourceMutations.ts` records why that
			 * distinction is load-bearing rather than cosmetic.
			 *
			 * This editor dispatches directly because it owns the exact focused
			 * lookup-definition snapshot the valid-by-construction gate needs.
			 * The generic registry callback has no external-resource context. */
			const outcome = updateField(field.uuid, field.kind, {
				optionsSource: next,
			} as unknown as FieldPatchFor<F["kind"]>);
			setCommitFailure(outcome.ok ? [] : [...new Set(outcome.messages)]);
			return outcome;
		},
		[updateField, field.uuid, field.kind],
	);

	const consideredColumns = considering
		? (tables.byId.get(considering)?.columns ?? [])
		: [];
	const consideredName = considering
		? tables.byId.get(considering)?.name
		: undefined;
	const changeFilter = useCallback(
		(next: Predicate | undefined) => {
			if (source === undefined) return;
			const { filter: _previous, ...identity } = source;
			commit(next === undefined ? identity : { ...identity, filter: next });
		},
		[commit, source],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the focused column identity and context-bound `commit` are the complete inputs; re-running on `tables` identity alone would re-commit.
	useEffect(() => {
		if (considering === null) return;
		const first = consideredColumns[0];
		if (first === undefined) return;
		/* Seeded whole, never half-configured: a source without both columns is
		 * not a thing the wire can emit, so the first column stands in for both
		 * until the author says otherwise. */
		commit({
			kind: "lookup",
			tableId: considering,
			valueColumnId: first.id,
			labelColumnId: first.id,
		});
		setConsidering(null);
	}, [considering, consideredColumns[0]?.id, commit]);

	return (
		<div className="space-y-3">
			<div>
				<Label htmlFor={modeId} className="text-[13px]">
					Where the choices come from
				</Label>
				<Select
					value={
						considering ?? (source === undefined ? INLINE : source.tableId)
					}
					disabled={!canEdit}
					onValueChange={(next) => {
						if (next === INLINE) {
							setConsidering(null);
							commit(undefined);
							return;
						}
						setCommitFailure([]);
						setConsidering(next as LookupTableId);
					}}
				>
					<SelectTrigger id={modeId} wrapValue className="mt-1 min-h-11 w-full">
						{/* Base UI cannot resolve a closed popup's dynamic item label on
						 *  first paint. Format its controlled value explicitly so neither
						 *  the inline sentinel nor a table UUID becomes visible. */}
						<SelectValue>
							{(selected) => {
								if (selected === INLINE) return "The options typed in here";
								const selectedTable = tables.byId.get(
									selected as LookupTableId,
								);
								if (selectedTable !== undefined) return selectedTable.name;
								if (tables.loadingList) return "Loading data table…";
								if (tables.listFailure !== null) {
									return "Data tables didn’t load";
								}
								return "A table that is no longer here";
							}}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={INLINE}>The options typed in here</SelectItem>
						{tables.definitions.map((candidate) => (
							<SelectItem key={candidate.id} value={candidate.id} wrap>
								{candidate.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{tables.listFailure !== null || tables.focusedFailure !== null ? (
				<div
					role="alert"
					className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3"
				>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{tables.focusedFailure ?? tables.listFailure}
					</p>
					<Button
						type="button"
						variant="outline"
						className="mt-2 min-h-11"
						onClick={() =>
							void (tables.focusedFailure !== null
								? tables.retryFocused()
								: tables.retryList())
						}
					>
						Try again
					</Button>
				</div>
			) : considering !== null ||
				tables.loadingList ||
				tables.loadingFocused ? (
				<p
					role="status"
					className="text-[12px] leading-snug text-nova-text-muted"
				>
					{considering === null
						? "Loading this project’s data tables…"
						: `Loading “${consideredName ?? "that table"}”…`}
				</p>
			) : source === undefined ? (
				<p className="text-[12px] leading-snug text-nova-text-muted">
					{tables.definitions.length === 0
						? "This project has no data tables yet. Create one to offer the same list in more than one place."
						: "Pick a data table to offer the same list here and in every other app in this project."}
				</p>
			) : table === undefined ? (
				/* The doc references a table this session cannot see — deleted, or
				 * in another project after a move. Say so plainly rather than
				 * rendering empty column pickers that look broken. */
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					This question points at a data table that isn’t in this project
					anymore. Choose another table, or go back to the options typed in
					here.
				</p>
			) : (
				<>
					<div>
						<Label htmlFor={valueId} className="text-[13px]">
							Value that gets saved
						</Label>
						<Select
							value={source.valueColumnId}
							disabled={!canEdit}
							onValueChange={(next) =>
								commit({ ...source, valueColumnId: next as LookupColumnId })
							}
						>
							<SelectTrigger
								id={valueId}
								wrapValue
								className="mt-1 min-h-11 w-full"
							>
								<SelectValue>
									{(selected) =>
										table.columns.find((column) => column.id === selected)
											?.label ?? "A column that is no longer here"
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
						<Label htmlFor={labelColumnId} className="text-[13px]">
							Value people see
						</Label>
						<Select
							value={source.labelColumnId}
							disabled={!canEdit}
							onValueChange={(next) =>
								commit({ ...source, labelColumnId: next as LookupColumnId })
							}
						>
							<SelectTrigger
								id={labelColumnId}
								wrapValue
								className="mt-1 min-h-11 w-full"
							>
								<SelectValue>
									{(selected) =>
										table.columns.find((column) => column.id === selected)
											?.label ?? "A column that is no longer here"
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
						{source.filter === undefined ? (
							<>
								<p className="text-[13px] leading-relaxed text-nova-text-secondary">
									Every row of “{table.name}” is offered. Add a rule to match
									this table’s columns against an earlier answer, fixed value,
									or current-user information.
								</p>
								{canEdit ? (
									<Button
										type="button"
										variant="outline"
										className="min-h-11 w-full border-dashed"
										onClick={() => {
											if (tableScope === undefined) return;
											changeFilter(
												firstComparisonDefault({
													caseTypes,
													currentCaseType: "",
													knownInputs: [],
													userProperties,
													formFields,
													lookupTables: tableVocabulary,
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
									Only rows matching this rule are offered. An earlier answer
									can filter later questions; answers from later, child, or
									sibling repeat questions are unavailable.
								</p>
								<fieldset disabled={!canEdit} className="contents">
									<PredicateWorkbench
										value={source.filter}
										onChange={changeFilter}
										onRemoveRoot={() => changeFilter(undefined)}
										removeRootLabel="Offer every row"
										rootLabel="Row rule"
										caseTypes={caseTypes}
										currentCaseType=""
										knownInputs={[]}
										userProperties={userProperties}
										formFields={formFields}
										lookupTables={tableVocabulary}
										tableScope={tableScope}
										caseDataScope="table-row"
										evaluationTarget="on-device"
									/>
								</fieldset>
							</>
						)}
					</div>

					<Button
						type="button"
						variant="ghost"
						className="min-h-11 text-[13px] text-nova-violet-bright"
						onClick={() => navigate.openProjectData(table.id)}
					>
						Open “{table.name}”
					</Button>
				</>
			)}

			{commitFailure.length > 0 && (
				<div
					role="alert"
					className="space-y-1 text-[13px] leading-relaxed text-nova-rose"
				>
					{commitFailure.map((message) => (
						<p key={message}>{message}</p>
					))}
				</div>
			)}

			{source !== undefined && (
				<p className="text-[12px] leading-snug text-nova-text-muted">
					The options typed into this question are kept. Switch back to them any
					time.
				</p>
			)}
		</div>
	);
}
