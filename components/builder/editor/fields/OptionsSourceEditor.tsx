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
import { useId } from "react";
import { Button } from "@/components/shadcn/button";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { Field } from "@/lib/domain";
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
	onChange,
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
	const tables = useProjectLookupDefinitions(source?.tableId);
	const table =
		source === undefined ? undefined : tables.byId.get(source.tableId);

	const commit = (next: LookupOptionsSource | undefined) => {
		/* `onChange(undefined)` is the editor registry's own spelling for
		 * "remove this slot". The doc-diff persistence path turns it into the
		 * durable `null` — `lib/doc/lookupOptionsSourceMutations.ts` records why
		 * that distinction is load-bearing rather than cosmetic.
		 *
		 * The cast mirrors `OptionsEditor`'s: `onChange` is an indexed-access
		 * write over the generic, and every kind that declares `optionsSource`
		 * carries it as `LookupOptionsSource | undefined`. */
		onChange(next as F["optionsSource" & keyof F]);
	};

	return (
		<div className="space-y-3">
			<div>
				<Label htmlFor={modeId} className="text-[13px]">
					Where the choices come from
				</Label>
				<Select
					value={source === undefined ? INLINE : source.tableId}
					disabled={!canEdit}
					onValueChange={(next) => {
						if (next === INLINE) {
							commit(undefined);
							return;
						}
						const chosen = tables.byId.get(next as LookupTableId);
						const first = chosen?.columns[0];
						if (chosen === undefined || first === undefined) return;
						/* Seeded whole, never half-configured: a source without both
						 * columns is not a thing the wire can emit, so the first column
						 * stands in for both until the author says otherwise. */
						commit({
							kind: "lookup-table",
							tableId: chosen.id,
							valueColumnId: first.id,
							labelColumnId: first.id,
						});
					}}
				>
					<SelectTrigger id={modeId} className="mt-1 h-11 w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={INLINE}>The options typed in here</SelectItem>
						{tables.definitions.map((candidate) => (
							<SelectItem key={candidate.id} value={candidate.id}>
								{candidate.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{source === undefined ? (
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
							<SelectTrigger id={valueId} className="mt-1 h-11 w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{table.columns.map((column) => (
									<SelectItem key={column.id} value={column.id}>
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
							<SelectTrigger id={labelColumnId} className="mt-1 h-11 w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{table.columns.map((column) => (
									<SelectItem key={column.id} value={column.id}>
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

			{source !== undefined && (
				<p className="text-[12px] leading-snug text-nova-text-muted">
					The options typed into this question are kept. Switch back to them any
					time.
				</p>
			)}
		</div>
	);
}
