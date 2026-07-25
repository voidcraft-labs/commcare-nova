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
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import type { LookupColumn, LookupRow } from "@/lib/lookup/types";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import type {
	ProjectDataRowConflict,
	ProjectDataWorkspace,
} from "./ProjectDataWorkspaceProvider";
import {
	cellText,
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
	const [conflict, setConflict] = useState<ProjectDataRowConflict | null>(null);
	const [saving, setSaving] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingDelete);

	/* Adopt fresh stored values only while the author has nothing in flight.
	 * Doing it during render (not in an effect) means the rail never paints one
	 * frame of the old values after the new ones arrive. */
	const lastStored = useRef(stored);
	if (lastStored.current !== stored) {
		lastStored.current = stored;
		if (!dirty && conflict === null) setDraft(stored);
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
			setConflict(null);
			setStatus("Saved.");
			return;
		}
		if (outcome.kind === "failed") {
			setFailure(outcome.failure.message);
			return;
		}
		setConflict(outcome.conflict);
	};

	if (conflict !== null) {
		return (
			<ConflictResolution
				conflict={conflict}
				columns={columns}
				onKeepMine={async () => {
					setConflict(null);
					await save();
				}}
				onUseTheirs={() => {
					setConflict(null);
					setDirty(false);
					setDraft(
						conflict.current === undefined
							? stored
							: rowValuesToDraft(conflict.current, columns),
					);
					setStatus("Kept the version that was already saved.");
				}}
			/>
		);
	}

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
										setConflict(outcome.conflict);
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

/**
 * The side-by-side an author sees when a save could not be applied safely.
 *
 * It shows both versions of every cell that differs, because the decision is
 * "which of these two is right" and it cannot be made from one of them. The
 * two actions are the two real answers; there is deliberately no third
 * "merge" affordance, which would ask the author to hand-reconcile values the
 * surface could show them directly.
 */
function ConflictResolution({
	conflict,
	columns,
	onKeepMine,
	onUseTheirs,
}: {
	conflict: ProjectDataRowConflict;
	columns: readonly LookupColumn[];
	onKeepMine: () => void;
	onUseTheirs: () => void;
}) {
	const gone = conflict.verdict.kind === "gone";
	const reason = gone
		? "Someone deleted this row while you were editing it."
		: conflict.verdict.reason === "columns-changed"
			? "Someone changed this table's columns while you were editing this row, so your values may not mean the same thing anymore."
			: "Someone else saved this row while you were editing it.";

	return (
		<div className="space-y-4">
			<div
				role="alert"
				className="flex gap-2 rounded-lg border border-nova-amber/30 bg-nova-amber/[0.08] p-3"
			>
				<Icon
					icon={tablerAlertTriangle}
					width="16"
					height="16"
					className="mt-0.5 shrink-0 text-nova-amber"
					aria-hidden="true"
				/>
				<div className="min-w-0 space-y-1">
					<p className="text-[13px] font-medium text-nova-text">
						This row wasn’t saved
					</p>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{reason} Nothing you typed has been lost — pick which version to
						keep.
					</p>
				</div>
			</div>

			<dl className="space-y-3">
				{columns.map((column) => {
					const mine = cellText(conflict.draft, column);
					const theirs =
						conflict.current === undefined
							? undefined
							: cellText(conflict.current, column);
					if (mine === theirs) return null;
					return (
						<div key={column.id} className="min-w-0">
							<dt className="text-[13px] font-medium text-nova-text [overflow-wrap:anywhere]">
								{column.label}
							</dt>
							<dd className="mt-1 space-y-1 text-[13px]">
								<p className="text-nova-text-secondary [overflow-wrap:anywhere]">
									<span className="text-nova-text-muted">Yours: </span>
									{mine ?? "No value"}
								</p>
								<p className="text-nova-text-secondary [overflow-wrap:anywhere]">
									<span className="text-nova-text-muted">
										{gone ? "Deleted" : "Already saved"}:{" "}
									</span>
									{gone ? "—" : (theirs ?? "No value")}
								</p>
							</dd>
						</div>
					);
				})}
			</dl>

			<div className="flex flex-wrap gap-2">
				{!gone && (
					<Button
						type="button"
						variant="default"
						className="min-h-11"
						onClick={onKeepMine}
					>
						Keep mine
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					className="min-h-11"
					onClick={onUseTheirs}
				>
					{gone ? "Discard my changes" : "Keep the saved version"}
				</Button>
			</div>
		</div>
	);
}
