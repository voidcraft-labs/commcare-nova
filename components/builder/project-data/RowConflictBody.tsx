/**
 * The recovery surface for a refused row write.
 *
 * A save conflict is an EDITOR over the fresh schema, not a read-only diff.
 * Retyped values must pass their new controls, new columns are available, and
 * removed-column values remain visible until the author acknowledges that
 * storage has nowhere to put them. The controller owns this editable draft, so
 * closing Properties or changing routes cannot erase the reconciliation work.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Checkbox } from "@/components/shadcn/checkbox";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import type { LookupColumn, LookupRowValues } from "@/lib/lookup/types";
import type {
	ProjectDataRowConflict,
	ProjectDataWorkspace,
} from "./ProjectDataWorkspaceProvider";
import { cellText, type RowDraft, rowDraftToValues } from "./projectDataModel";
import { RowValueField } from "./RowValueField";

export function RowConflictBody({
	conflict,
	workspace,
	canEdit,
}: {
	conflict: ProjectDataRowConflict;
	workspace: ProjectDataWorkspace;
	canEdit: boolean;
}) {
	const acknowledgementId = useId();
	const [removedAcknowledged, setRemovedAcknowledged] = useState(false);
	const [errors, setErrors] = useState<ReadonlyMap<LookupColumnId, string>>(
		new Map(),
	);
	const [working, setWorking] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const gone = conflict.verdict.kind === "gone";
	const deleting = conflict.attempted === "delete";
	const resolutionColumns = conflict.resolution?.columns ?? [];

	const reason = conflict.tableUnavailable
		? `The original “${conflict.tableName}” table is no longer available. This local row copy cannot be saved back to it.`
		: gone
			? deleting
				? "Someone else already deleted this row."
				: "Someone deleted this row while you were editing it."
			: conflict.verdict.kind === "ask" &&
					conflict.verdict.reason === "columns-changed"
				? "Someone changed this table’s columns while you were working. Reconcile your values with the current columns before saving."
				: deleting
					? "Someone else changed this row while you were deleting it."
					: "Someone else saved this row while you were editing it.";

	const finish = async (
		run: () => Promise<Awaited<ReturnType<ProjectDataWorkspace["saveRow"]>>>,
	) => {
		if (working) return;
		setWorking(true);
		setFailure(null);
		try {
			const outcome = await run();
			if (outcome.kind === "failed") setFailure(outcome.failure.message);
		} catch {
			setFailure(
				"Nova could not reach this data table. Check your connection and try again.",
			);
		} finally {
			setWorking(false);
		}
	};

	const saveReconciled = (
		run: (
			values: LookupRowValues,
		) => Promise<Awaited<ReturnType<ProjectDataWorkspace["saveRow"]>>>,
	) => {
		const parsed = rowDraftToValues(conflict.editableDraft, resolutionColumns);
		if (!parsed.ok) {
			setErrors(parsed.errors);
			setFailure(
				"Review the highlighted values before choosing which version to save.",
			);
			return;
		}
		if (conflict.removed.length > 0 && !removedAcknowledged) {
			setFailure(
				"Acknowledge the removed column values before saving the remaining values.",
			);
			return;
		}
		setErrors(new Map());
		void finish(() => run(parsed.values));
	};

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
						{conflict.tableUnavailable
							? "Local row copy recovered"
							: deleting
								? gone
									? "This row was already deleted"
									: "This row wasn’t deleted"
								: "This row wasn’t saved"}
					</p>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{reason}{" "}
						{conflict.tableUnavailable
							? "Copy anything you need; only the discard action below removes this local copy."
							: deleting
								? gone
									? "Nothing remains for you to delete."
									: "Nothing has been removed."
								: "Nothing you typed has been lost."}
					</p>
				</div>
			</div>

			{conflict.tableUnavailable ? (
				<DraftValues
					columns={conflict.displayColumns}
					draft={conflict.editableDraft}
					prefix="Your draft"
				/>
			) : deleting ? (
				<StoredDifference
					conflict={conflict}
					columns={conflict.displayColumns}
				/>
			) : !canEdit ? (
				<div className="space-y-4">
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						Your local reconciliation is shown as read-only text because saving
						Project data now needs edit access.
					</p>
					<ReadOnlySaveConflict
						conflict={conflict}
						columns={resolutionColumns}
					/>
				</div>
			) : (
				<div className="space-y-4">
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						These fields match the table’s current columns. Review them, then
						keep this row or save it as a new one.
					</p>
					<div className="space-y-3">
						{resolutionColumns.map((column) => (
							<div key={column.id} className="space-y-1">
								<RowValueField
									column={column}
									value={conflict.editableDraft[column.id]}
									invalid={errors.get(column.id)}
									disabled={working}
									onChange={(next) => {
										setFailure(null);
										workspace.updateRowConflictDraft(conflict, column.id, next);
									}}
								/>
								{conflict.current !== undefined && (
									<p className="text-[12px] text-nova-text-muted">
										Already saved:{" "}
										<VisibleValue
											text={cellText(conflict.current, column)}
											compact
										/>
									</p>
								)}
							</div>
						))}
					</div>
				</div>
			)}

			{!deleting && conflict.removed.length > 0 && (
				<div className="space-y-3 rounded-lg border border-nova-amber/30 bg-nova-amber/[0.06] p-3">
					<div>
						<p className="text-[13px] font-medium text-nova-text">
							Values from removed columns
						</p>
						<p className="mt-1 text-[12px] leading-snug text-nova-text-secondary">
							These columns no longer exist, so Nova cannot put their values
							into this table. Copy anything you need before continuing.
						</p>
					</div>
					<dl className="space-y-2">
						{conflict.removed.map(({ column, value }) => (
							<div key={column.id}>
								<dt className="text-[12px] font-medium text-nova-text">
									{column.label}
								</dt>
								<dd className="mt-1 text-[13px] text-nova-text-secondary">
									<VisibleValue text={value.text} />
								</dd>
							</div>
						))}
					</dl>
					{canEdit && (
						<label
							htmlFor={acknowledgementId}
							className="flex min-h-11 cursor-pointer items-center gap-2 text-[13px] text-nova-text"
						>
							<Checkbox
								id={acknowledgementId}
								checked={removedAcknowledged}
								disabled={working}
								onCheckedChange={setRemovedAcknowledged}
							/>
							I copied what I need; save without these removed columns
						</label>
					)}
				</div>
			)}

			{failure !== null && (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					{failure}
				</p>
			)}
			{!canEdit && !conflict.tableUnavailable && (
				<p className="rounded-lg bg-nova-elevated px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary">
					Your access changed while this decision was open. Your draft remains
					here, but changing Project data now needs edit access.
				</p>
			)}

			<div className="flex flex-wrap gap-2">
				{canEdit && deleting && !gone && (
					<Button
						type="button"
						variant="destructive"
						className=""
						disabled={working}
						onClick={() =>
							void finish(() => workspace.deleteConflictRow(conflict))
						}
					>
						Delete it anyway
					</Button>
				)}
				{canEdit && !deleting && !gone && !conflict.tableUnavailable && (
					<Button
						type="button"
						variant="default"
						className=""
						disabled={
							working || (conflict.removed.length > 0 && !removedAcknowledged)
						}
						onClick={() =>
							saveReconciled((values) =>
								workspace.overwriteConflictRow(conflict, values),
							)
						}
					>
						Keep my reconciled row
					</Button>
				)}
				{canEdit && !deleting && gone && !conflict.tableUnavailable && (
					<Button
						type="button"
						variant="default"
						className=""
						disabled={
							working || (conflict.removed.length > 0 && !removedAcknowledged)
						}
						onClick={() =>
							saveReconciled((values) =>
								workspace.saveConflictAsNewRow(conflict, values),
							)
						}
					>
						Save as a new row
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					className=""
					disabled={working}
					onClick={() => {
						workspace.discardRowConflict(conflict);
						if (!conflict.tableUnavailable) void workspace.reload();
					}}
				>
					{conflict.tableUnavailable
						? "Discard local copy"
						: deleting
							? gone
								? "Dismiss this decision"
								: "Keep the row"
							: gone
								? "Discard my draft"
								: "Use the saved version"}
				</Button>
			</div>
		</div>
	);
}

function ReadOnlySaveConflict({
	conflict,
	columns,
}: {
	conflict: ProjectDataRowConflict;
	columns: readonly LookupColumn[];
}) {
	return (
		<dl className="space-y-3">
			{columns.map((column) => (
				<div key={column.id} className="min-w-0">
					<dt className="text-[13px] font-medium text-nova-text [overflow-wrap:anywhere]">
						{column.label}
					</dt>
					<dd className="mt-1 space-y-2 text-[13px] text-nova-text-secondary">
						<p>
							<span className="text-nova-text-muted">Your local draft: </span>
							<VisibleValue text={conflict.editableDraft[column.id]?.text} />
						</p>
						{conflict.current !== undefined && (
							<p>
								<span className="text-nova-text-muted">Already saved: </span>
								<VisibleValue text={cellText(conflict.current, column)} />
							</p>
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function StoredDifference({
	conflict,
	columns,
}: {
	conflict: ProjectDataRowConflict;
	columns: readonly LookupColumn[];
}) {
	return (
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
						<dd className="mt-1 space-y-2 text-[13px]">
							<p className="text-nova-text-secondary">
								<span className="text-nova-text-muted">What you saw: </span>
								<VisibleValue text={mine} />
							</p>
							<p className="text-nova-text-secondary">
								<span className="text-nova-text-muted">What it says now: </span>
								<VisibleValue text={theirs} />
							</p>
						</dd>
					</div>
				);
			})}
		</dl>
	);
}

function DraftValues({
	columns,
	draft,
	prefix,
}: {
	columns: readonly LookupColumn[];
	draft: RowDraft;
	prefix: string;
}) {
	return (
		<dl className="space-y-3">
			{columns.map((column) => (
				<div key={column.id}>
					<dt className="text-[13px] font-medium text-nova-text">
						{column.label}
					</dt>
					<dd className="mt-1 text-[13px] text-nova-text-secondary">
						<span className="sr-only">{prefix}: </span>
						<VisibleValue text={draft[column.id]?.text} />
					</dd>
				</div>
			))}
		</dl>
	);
}

function VisibleValue({
	text,
	compact = false,
}: {
	text: string | undefined;
	compact?: boolean;
}) {
	if (text === undefined) {
		return <span className="italic text-nova-text-muted">No value</span>;
	}
	if (text === "") {
		return <span className="italic text-nova-text-muted">Empty text</span>;
	}
	return (
		<span
			className={`select-text whitespace-pre-wrap rounded bg-white/[0.05] [overflow-wrap:anywhere] ${
				compact ? "px-1" : "inline-block min-h-5 min-w-2 px-1.5 py-0.5"
			}`}
		>
			{text}
		</span>
	);
}
