/**
 * One row of a Project data table, edited in the inspector rail.
 *
 * The row is the unit of both editing and concurrency, which is what makes
 * the conflict story tractable: a save carries the snapshot's revision, and a
 * refusal is resolved by `rowWriteConflictVerdict` against a fresh read.
 *
 * **The draft is never discarded** — but this component is not where that
 * promise is kept, and an earlier version of it claimed otherwise and was
 * wrong. A refused write is handed to the CONTROLLER, which renders
 * `RowConflictBody`; this body unmounts the moment its row leaves the table,
 * which is exactly what a co-member's delete does, so holding the conflict
 * here lost the draft in the one branch that mattered most.
 *
 * The component is keyed on the row's id by `projectDataInspector`. Without
 * that key React preserves this local draft across a change of selection, and
 * Save writes one row's values to another row's id.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import type { LookupRow, LookupTableSnapshot } from "@/lib/lookup/types";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import {
	captureRowEditBaseline,
	cellText,
	type RowDraft,
	rowDraftToValues,
	rowValuesToDraft,
} from "./projectDataModel";
import { RowValueField } from "./RowValueField";

export function RowInspectorBody({
	row,
	table,
	workspace,
	canEdit,
}: {
	row: LookupRow;
	table: LookupTableSnapshot;
	workspace: ProjectDataWorkspace;
	canEdit: boolean;
}) {
	const columns = table.columns;
	/* Keyed by the row's identity AND its stored content: a co-member's edit
	 * to this row arriving through the realtime clock should reset an
	 * untouched editor to the fresh values, while a dirty editor keeps the
	 * draft (`dirty` gates the reseed below). */
	const stored = useMemo(
		() => rowValuesToDraft(row.values, columns),
		[row.values, columns],
	);
	const incomingBaseline = useMemo(
		() => captureRowEditBaseline(table, row),
		[table, row],
	);
	const [edit, setEdit] = useState<{
		readonly draft: RowDraft;
		readonly dirty: boolean;
		readonly baseline: ReturnType<typeof captureRowEditBaseline>;
	}>({
		draft: stored,
		dirty: false,
		baseline: incomingBaseline,
	});
	const [errors, setErrors] = useState<ReadonlyMap<LookupColumnId, string>>(
		new Map(),
	);
	const [status, setStatus] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingDelete);

	/* Adopt fresh stored values only while the author has nothing in flight.
	 * Doing it during render (not in an effect) means the rail never paints one
	 * frame of the old values after the new ones arrive. */
	const lastIncomingRevision = useRef(incomingBaseline.tableRevision);
	if (
		lastIncomingRevision.current !== incomingBaseline.tableRevision &&
		!edit.dirty
	) {
		lastIncomingRevision.current = incomingBaseline.tableRevision;
		setEdit({
			draft: stored,
			dirty: false,
			baseline: incomingBaseline,
		});
	}

	const update = (columnId: LookupColumnId, next: RowDraft[LookupColumnId]) => {
		setStatus(null);
		setEdit((current) => ({
			...current,
			dirty: true,
			draft: { ...current.draft, [columnId]: next },
		}));
	};

	const save = async () => {
		if (!canEdit || saving || deleting) return;
		const parsed = rowDraftToValues(edit.draft, edit.baseline.columns);
		if (!parsed.ok) {
			setErrors(parsed.errors);
			setFailure(null);
			return;
		}
		setErrors(new Map());
		setSaving(true);
		setFailure(null);
		setStatus(null);
		try {
			const outcome = await workspace.saveRow(
				row.id,
				parsed.values,
				edit.baseline,
			);
			if (outcome.kind === "saved") {
				setEdit((current) => ({ ...current, dirty: false }));
				setStatus("Saved.");
				return;
			}
			if (outcome.kind === "failed") {
				setFailure(outcome.failure.message);
				return;
			}
			/* Handed to the controller, which renders it as its own body — this one
			 * unmounts the moment the row leaves the table, which is exactly what a
			 * co-member's delete does. */
			workspace.setRowConflict(outcome.conflict);
		} catch {
			setFailure(
				"Nova could not reach this data table. Check your connection and try again.",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-4">
			{!canEdit && (
				<p className="rounded-lg bg-nova-elevated px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary">
					You can read this row. Changing it needs edit access to this project.
				</p>
			)}
			{canEdit ? (
				<div className="space-y-3">
					{edit.baseline.columns.map((column) => (
						<RowValueField
							key={column.id}
							column={column}
							value={edit.draft[column.id]}
							invalid={errors.get(column.id)}
							onChange={(next) => update(column.id, next)}
						/>
					))}
				</div>
			) : (
				<dl className="space-y-3">
					{columns.map((column) => {
						const value = cellText(row.values, column);
						return (
							<div key={column.id} className="min-w-0">
								<dt className="text-[13px] font-medium text-nova-text [overflow-wrap:anywhere]">
									{column.label}
								</dt>
								<dd className="mt-1 text-[13px] text-nova-text-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
									{value === undefined
										? "No value"
										: value === ""
											? "Empty text"
											: value}
								</dd>
							</div>
						);
					})}
				</dl>
			)}

			{failure !== null && (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					{failure}
				</p>
			)}
			{status !== null && (
				<p
					role="status"
					className="text-[13px] leading-relaxed text-nova-text-secondary"
				>
					{status}
				</p>
			)}

			{canEdit && (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="default"
						className="min-h-11"
						disabled={!edit.dirty || saving || deleting || confirmingDelete}
						onClick={() => void save()}
					>
						{saving ? "Saving…" : "Save row"}
					</Button>
					{edit.dirty && (
						<Button
							type="button"
							variant="ghost"
							className="min-h-11"
							disabled={saving || deleting || confirmingDelete}
							onClick={() => {
								setEdit({
									draft: stored,
									dirty: false,
									baseline: incomingBaseline,
								});
								setErrors(new Map());
								setFailure(null);
								setStatus(null);
							}}
						>
							Discard changes
						</Button>
					)}
				</div>
			)}

			{canEdit &&
				(confirmingDelete ? (
					<div
						ref={panelRef}
						tabIndex={-1}
						className="space-y-2 rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3 outline-none"
					>
						<p className="text-[13px] font-medium text-nova-text">
							Delete this row?
						</p>
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							Every app in this project that offers this table’s values stops
							offering this one.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="ghost"
								className="min-h-11"
								disabled={deleting}
								onClick={() => setConfirmingDelete(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								variant="destructive"
								className="min-h-11"
								disabled={deleting}
								onClick={async () => {
									if (deleting) return;
									setDeleting(true);
									setConfirmingDelete(false);
									try {
										const outcome = await workspace.deleteRow(
											row.id,
											edit.baseline,
										);
										if (outcome.kind === "failed") {
											setFailure(outcome.failure.message);
										} else if (outcome.kind === "conflict") {
											workspace.setRowConflict(outcome.conflict);
										}
									} catch {
										setFailure(
											"Nova could not reach this data table. Check your connection and try again.",
										);
									} finally {
										setDeleting(false);
									}
								}}
							>
								{deleting ? "Deleting…" : "Delete row"}
							</Button>
						</div>
					</div>
				) : (
					<Button
						ref={triggerRef}
						type="button"
						variant="ghost"
						className="min-h-11 gap-2 text-nova-text-muted hover:text-nova-text"
						disabled={saving || deleting}
						onClick={() => setConfirmingDelete(true)}
					>
						<Icon
							icon={tablerTrash}
							width="16"
							height="16"
							aria-hidden="true"
						/>
						{deleting ? "Deleting…" : "Delete row"}
					</Button>
				))}
		</div>
	);
}
