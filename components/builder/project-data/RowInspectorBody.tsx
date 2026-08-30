/**
 * One row of a Project data table, edited in the inspector rail.
 *
 * The row is the unit of both editing and concurrency, which is what makes
 * the conflict story tractable: a save carries the snapshot's revision, and a
 * refusal is resolved by `rowWriteConflictVerdict` against a fresh read.
 *
 * **The draft is never discarded.** This body is only a view over a
 * controller-owned edit session. Closing Properties, pressing Escape,
 * selecting another row, changing routes, and losing the table to a peer all
 * unmount this component without touching the session.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import type { LookupRow, LookupTableSnapshot } from "@/lib/lookup/types";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { LookupOrderingSection } from "./LookupOrderingSection";
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
	const stored = useMemo(
		() => rowValuesToDraft(row.values, columns),
		[row.values, columns],
	);
	const incomingBaseline = useMemo(
		() => captureRowEditBaseline(table, row),
		[table, row],
	);
	const freshEdit = useMemo(
		() => ({
			projectId: table.projectId,
			tableId: table.id,
			tableName: table.name,
			rowId: row.id,
			draft: stored,
			baseline: incomingBaseline,
		}),
		[table.projectId, table.id, table.name, row.id, stored, incomingBaseline],
	);
	const edit = workspace.rowEditFor(row.id) ?? freshEdit;
	const dirty = workspace.rowEditFor(row.id) !== undefined;
	const [errors, setErrors] = useState<ReadonlyMap<LookupColumnId, string>>(
		new Map(),
	);
	const [status, setStatus] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingDelete);

	const update = (columnId: LookupColumnId, next: RowDraft[LookupColumnId]) => {
		setStatus(null);
		workspace.retainRowEdit({
			...edit,
			draft: { ...edit.draft, [columnId]: next },
		});
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
				setStatus("Saved.");
				return;
			}
			if (outcome.kind === "failed") {
				setFailure(outcome.failure.message);
				return;
			}
			/* Handed to the controller, which renders it as its own body, this one
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
					{dirty
						? "Your edit access changed, so this local row draft cannot be saved. Nova kept it here for you to copy or explicitly discard."
						: "You can read this row. Changing it needs edit access to this Project."}
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
					{(dirty ? edit.baseline.columns : columns).map((column) => {
						const value = dirty
							? edit.draft[column.id]?.text
							: cellText(row.values, column);
						return (
							<div key={column.id} className="min-w-0">
								<dt className="text-[13px] font-medium text-nova-text [overflow-wrap:anywhere]">
									{column.label}
								</dt>
								<dd className="mt-1 select-text text-[13px] text-nova-text-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
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
			{!canEdit && dirty && (
				<Button
					type="button"
					variant="ghost"
					className=""
					onClick={() => {
						workspace.discardRowEdit(row.id);
						setErrors(new Map());
						setFailure(null);
						setStatus(null);
					}}
				>
					Discard local draft
				</Button>
			)}

			<LookupOrderingSection
				kind="row"
				itemId={row.id}
				table={table}
				workspace={workspace}
				canEdit={canEdit}
				disabled={dirty || saving || deleting || confirmingDelete}
				disabledReason={
					dirty
						? "Save or discard your row changes before moving this row."
						: undefined
				}
			/>

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
						className=""
						disabled={!dirty || saving || deleting || confirmingDelete}
						onClick={() => void save()}
					>
						{saving ? "Saving" : "Save row"}
					</Button>
					{dirty && (
						<Button
							type="button"
							variant="ghost"
							className=""
							disabled={saving || deleting || confirmingDelete}
							onClick={() => {
								workspace.discardRowEdit(row.id);
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
							Every app in this Project that offers this table's values stops
							offering this one.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="ghost"
								className=""
								disabled={deleting}
								onClick={() => setConfirmingDelete(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								variant="destructive"
								className=""
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
								{deleting ? "Deleting" : "Delete row"}
							</Button>
						</div>
					</div>
				) : (
					<div className="space-y-1">
						<Button
							ref={triggerRef}
							type="button"
							variant="ghost"
							disabled={saving || deleting || dirty}
							onClick={() => setConfirmingDelete(true)}
						>
							<Icon
								icon={tablerTrash}
								width="16"
								height="16"
								aria-hidden="true"
							/>
							{deleting ? "Deleting" : "Delete row"}
						</Button>
						{dirty && (
							<p className="text-[12px] leading-snug text-nova-text-muted">
								Save or discard your row changes before deleting it.
							</p>
						)}
					</div>
				))}
		</div>
	);
}
