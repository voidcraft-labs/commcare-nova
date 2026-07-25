/**
 * One row of a Project data table, edited in the inspector rail.
 *
 * The row is the unit of both editing and concurrency, which is what makes
 * the conflict story tractable: a save carries the snapshot's revision, and a
 * refusal is resolved by `rowWriteConflictVerdict` against a fresh read.
 *
 * **The draft is never discarded.** In every branch — a benign drift that
 * retried, a real conflict, a row deleted underneath — what the author typed
 * stays on screen. That is the acceptance criterion this surface exists to
 * meet, not a nicety: a grid where a co-member's edit silently swallows yours
 * is a data-loss bug wearing a save button.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import type { LookupColumn, LookupRow } from "@/lib/lookup/types";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import {
	type RowDraft,
	rowDraftToValues,
	rowValuesToDraft,
} from "./projectDataModel";
import { RowValueField } from "./RowValueField";

export function RowInspectorBody({
	row,
	columns,
	workspace,
	canEdit,
}: {
	row: LookupRow;
	columns: readonly LookupColumn[];
	workspace: ProjectDataWorkspace;
	canEdit: boolean;
}) {
	/* Keyed by the row's identity AND its stored content: a co-member's edit
	 * to this row arriving through the realtime clock should reset an
	 * untouched editor to the fresh values, while a dirty editor keeps the
	 * draft (`dirty` gates the reseed below). */
	const stored = useMemo(
		() => rowValuesToDraft(row.values, columns),
		[row.values, columns],
	);
	const [draft, setDraft] = useState<RowDraft>(stored);
	const [dirty, setDirty] = useState(false);
	const [errors, setErrors] = useState<ReadonlyMap<LookupColumnId, string>>(
		new Map(),
	);
	const [status, setStatus] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingDelete);

	/* Adopt fresh stored values only while the author has nothing in flight.
	 * Doing it during render (not in an effect) means the rail never paints one
	 * frame of the old values after the new ones arrive. */
	const lastStored = useRef(stored);
	if (lastStored.current !== stored) {
		lastStored.current = stored;
		if (!dirty) setDraft(stored);
	}

	const update = (columnId: LookupColumnId, next: string | undefined) => {
		setDirty(true);
		setStatus(null);
		setDraft((current) => ({ ...current, [columnId]: next }));
	};

	const save = async () => {
		const parsed = rowDraftToValues(draft, columns);
		if (!parsed.ok) {
			setErrors(parsed.errors);
			setFailure(null);
			return;
		}
		setErrors(new Map());
		setSaving(true);
		setFailure(null);
		setStatus(null);
		const outcome = await workspace.saveRow(row.id, parsed.values);
		setSaving(false);
		if (outcome.kind === "saved") {
			setDirty(false);
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
	};

	return (
		<div className="space-y-4">
			{!canEdit && (
				<p className="rounded-lg bg-nova-elevated px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary">
					You can read this row. Changing it needs edit access to this project.
				</p>
			)}
			<div className="space-y-3">
				{columns.map((column) => (
					<RowValueField
						key={column.id}
						column={column}
						value={draft[column.id]}
						invalid={errors.get(column.id)}
						onChange={(next) => update(column.id, next)}
					/>
				))}
			</div>

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
						disabled={!dirty || saving}
						onClick={() => void save()}
					>
						{saving ? "Saving…" : "Save row"}
					</Button>
					{dirty && (
						<Button
							type="button"
							variant="ghost"
							className="min-h-11"
							disabled={saving}
							onClick={() => {
								setDraft(stored);
								setDirty(false);
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
								onClick={() => setConfirmingDelete(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								variant="destructive"
								className="min-h-11"
								onClick={async () => {
									setConfirmingDelete(false);
									const outcome = await workspace.deleteRow(row.id);
									if (outcome.kind === "failed") {
										setFailure(outcome.failure.message);
									} else if (outcome.kind === "conflict") {
										workspace.setRowConflict(outcome.conflict);
									}
								}}
							>
								Delete row
							</Button>
						</div>
					</div>
				) : (
					<Button
						ref={triggerRef}
						type="button"
						variant="ghost"
						className="min-h-11 gap-2 text-nova-text-muted hover:text-nova-text"
						onClick={() => setConfirmingDelete(true)}
					>
						<Icon
							icon={tablerTrash}
							width="16"
							height="16"
							aria-hidden="true"
						/>
						Delete row
					</Button>
				))}
		</div>
	);
}
