/**
 * What you can do to a whole table: add a row, add a column, replace every row
 * from a CSV, rename it, and delete it.
 *
 * The actions sit in one row above the grid rather than behind a menu, because
 * every one of them is a thing an author comes to this screen to do. Capability
 * decides what appears: an editor sees the first three, and the two that need
 * `delete` are absent rather than present-and-disabled for someone who can
 * never use them.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTableImport from "@iconify-icons/tabler/table-import";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	addLookupColumnAction,
	deleteLookupTableAction,
	updateLookupTableNameAction,
} from "@/lib/lookup/actions";
import type {
	LookupGovernanceFailure,
	LookupRowValues,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanDelete, useCanEdit, useProjectId } from "@/lib/session/hooks";
import { AddColumnDialog } from "./AddColumnDialog";
import { CsvImportDialog } from "./CsvImportDialog";
import { DestructiveChangeDialog } from "./DestructiveChangeDialog";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import { rowAdditionRefusal, tableCapacity } from "./projectDataModel";

export function TableActions({
	table,
	workspace,
}: {
	table: LookupTableSnapshot;
	workspace: ProjectDataWorkspace;
}) {
	const canEdit = useCanEdit();
	const canDelete = useCanDelete();
	const projectId = useProjectId();
	const navigate = useNavigate();
	const [name, setName] = useState(table.name);
	const [renaming, setRenaming] = useState(false);
	const [importing, setImporting] = useState(false);
	const [addingColumn, setAddingColumn] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);

	const capacity = tableCapacity(table);
	const full = rowAdditionRefusal(capacity);

	const addRow = async () => {
		setFailure(null);
		/* An empty row, appended. Adding a row and filling it in are two
		 * gestures, and a dialog demanding every value before the row existed
		 * would make adding fifty rows fifty dialogs. The row lands at the end,
		 * so the status below says where to find it rather than leaving the
		 * author to hunt an unchanged-looking table. */
		const outcome = await workspace.addRow({} as LookupRowValues);
		if (outcome.kind === "failed") {
			setFailure(outcome.failure.message);
			return;
		}
		setStatus(
			"Added an empty row at the end of the table. Open it to fill it in.",
		);
	};

	return (
		<div className="mt-4 space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				{canEdit && (
					<>
						<Button
							type="button"
							variant="outline"
							className="min-h-11 gap-2"
							disabled={full !== undefined}
							onClick={() => void addRow()}
						>
							<Icon
								icon={tablerPlus}
								width="16"
								height="16"
								aria-hidden="true"
							/>
							Add row
						</Button>
						<Button
							type="button"
							variant="outline"
							className="min-h-11 gap-2"
							onClick={() => setAddingColumn(true)}
						>
							<Icon
								icon={tablerPlus}
								width="16"
								height="16"
								aria-hidden="true"
							/>
							Add column
						</Button>
						<Button
							type="button"
							variant="outline"
							className="min-h-11 gap-2"
							onClick={() => setImporting(true)}
						>
							<Icon
								icon={tablerTableImport}
								width="16"
								height="16"
								aria-hidden="true"
							/>
							Replace rows from CSV
						</Button>
						<Button
							type="button"
							variant="ghost"
							className="min-h-11"
							onClick={() => setRenaming(true)}
						>
							Rename
						</Button>
					</>
				)}
				{canDelete && (
					<Button
						type="button"
						variant="ghost"
						className="min-h-11 gap-2 text-nova-text-muted hover:text-nova-text"
						onClick={() => setDeleting(true)}
					>
						<Icon
							icon={tablerTrash}
							width="16"
							height="16"
							aria-hidden="true"
						/>
						Delete table
					</Button>
				)}
			</div>

			{full !== undefined && (
				<p className="max-w-prose text-[12px] leading-snug text-nova-text-muted">
					{full}
				</p>
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

			{renaming && (
				<div className="flex flex-wrap items-center gap-2">
					<Input
						value={name}
						autoComplete="off"
						data-1p-ignore
						aria-label="Table name"
						onChange={(event) => setName(event.target.value)}
						className="h-11 max-w-xs"
					/>
					<Button
						type="button"
						variant="default"
						className="min-h-11"
						onClick={async () => {
							if (projectId === undefined) return;
							const result = await updateLookupTableNameAction(projectId, {
								tableId: table.id,
								expectedTableRevision: table.tableRevision,
								name,
							});
							if (result.success) {
								setRenaming(false);
								await workspace.reload();
							} else {
								setFailure(result.message);
							}
						}}
					>
						Save name
					</Button>
					<Button
						type="button"
						variant="ghost"
						className="min-h-11"
						onClick={() => {
							setName(table.name);
							setRenaming(false);
						}}
					>
						Cancel
					</Button>
				</div>
			)}

			{addingColumn && (
				<AddColumnDialog
					open
					onClose={() => setAddingColumn(false)}
					onCreate={async (draft) => {
						if (projectId === undefined) return "Lookup table not found.";
						const result = await addLookupColumnAction(projectId, {
							tableId: table.id,
							expectedTableRevision: table.tableRevision,
							column: draft,
						});
						if (!result.success) return result.message;
						await workspace.reload();
						return null;
					}}
				/>
			)}

			{importing && (
				<CsvImportDialog
					open
					table={table}
					onClose={() => setImporting(false)}
					onImported={workspace.reload}
				/>
			)}

			{deleting && (
				<DestructiveChangeDialog
					open
					table={table}
					title={`Delete “${table.name}”?`}
					consequence={`Its ${table.columns.length === 1 ? "column" : `${table.columns.length} columns`} and every one of its rows are deleted. This cannot be undone.`}
					confirmLabel="Delete table"
					onCancel={() => setDeleting(false)}
					onConfirm={async (): Promise<LookupGovernanceFailure | null> => {
						if (projectId === undefined) {
							return {
								success: false,
								code: "not_found",
								message: "Lookup table not found.",
							};
						}
						const result = await deleteLookupTableAction(projectId, {
							tableId: table.id,
							expectedTableRevision: table.tableRevision,
						});
						if (!result.success) return result;
						setDeleting(false);
						navigate.openProjectData();
						return null;
					}}
				/>
			)}
		</div>
	);
}
