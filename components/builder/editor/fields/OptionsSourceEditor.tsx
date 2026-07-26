/**
 * Where a select's choices come from: typed in here, or a column of a Project
 * data table.
 *
 * **The switch is asymmetric, and the asymmetry is the feature's correctness.**
 * `optionsSource` precedence is presence-based at every consumer, so:
 *
 *   - choosing a table SETS the source and leaves the typed-in options exactly
 *     where they are — they are the fallback an older receiver reads, and they
 *     are what the field goes back to;
 *   - choosing typed-in options CLEARS the source. Anything less and the
 *     retained table keeps winning while the editor claims otherwise.
 *
 * `lib/doc/lookupOptionsSourceMutations.ts` records why the clear is spelled
 * `null` rather than `undefined`.
 *
 * A saved row FILTER is shown, explained, and clearable, but not editable
 * here. Editing one means offering the lookup-row expression vocabulary — a
 * table's own columns and an earlier answer in this form — which is a scope
 * the shared expression editor gains separately. Rendering a saved filter
 * read-only keeps it honest in the meantime: an author can see that the
 * choices are narrowed, and by what.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerFilter from "@iconify-icons/tabler/filter";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { Field, FieldPatchFor } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import type { LookupOptionsSource } from "@/lib/domain/lookupCarriers";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { useNavigate } from "@/lib/routing/hooks";
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: the focused column identity and context-bound `commit` are the complete inputs; re-running on `tables` identity alone would re-commit.
	useEffect(() => {
		if (considering === null) return;
		const first = consideredColumns[0];
		if (first === undefined) return;
		/* Seeded whole, never half-configured: a source without both columns is
		 * not a thing the wire can emit, so the first column stands in for both
		 * until the author says otherwise. */
		commit({
			kind: "lookup-table",
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

			{considering !== null || tables.loadingList || tables.loadingFocused ? (
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

					{source.filter !== undefined && (
						<div className="space-y-2 rounded-lg border border-nova-border bg-nova-elevated p-3">
							<p className="flex items-start gap-2 text-[13px] font-medium text-nova-text">
								<Icon
									icon={tablerFilter}
									width="16"
									height="16"
									className="mt-0.5 shrink-0 text-nova-text-muted"
									aria-hidden="true"
								/>
								Only some rows are offered
							</p>
							<p className="text-[13px] leading-relaxed text-nova-text-secondary">
								A rule on this question narrows which rows of “{table.name}”
								people can choose from. You can remove the rule here; changing
								it isn’t available yet.
							</p>
							{canEdit && (
								<Button
									type="button"
									variant="ghost"
									className="min-h-11"
									onClick={() => {
										const { filter: _dropped, ...rest } = source;
										commit(rest);
									}}
								>
									Offer every row
								</Button>
							)}
						</div>
					)}

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
