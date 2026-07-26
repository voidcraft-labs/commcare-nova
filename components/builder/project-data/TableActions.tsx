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
	updateLookupTableTagAction,
} from "@/lib/lookup/actions";
import type {
	LookupGovernanceFailure,
	LookupRevision,
	LookupRowValues,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanDelete, useCanEdit, useProjectId } from "@/lib/session/hooks";
import { AddColumnDialog } from "./AddColumnDialog";
import { CsvImportDialog } from "./CsvImportDialog";
import { DestructiveChangeDialog } from "./DestructiveChangeDialog";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import {
	createRevisionedTextDraft,
	discardRevisionedTextDraft,
	editRevisionedTextDraft,
	keepRevisionedTextDraft,
	type RevisionedTextDraft,
	reconcileRevisionedTextDraft,
	rowAdditionRefusal,
	tableCapacity,
} from "./projectDataModel";

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
	const [name, setName] = useState(() =>
		createRevisionedTextDraft(table.name, table.tableRevision),
	);
	const [tag, setTag] = useState(() =>
		createRevisionedTextDraft(table.tag, table.tableRevision),
	);
	const reconciledName = reconcileRevisionedTextDraft(
		name,
		table.name,
		table.tableRevision,
	);
	if (reconciledName !== name) setName(reconciledName);
	const reconciledTag = reconcileRevisionedTextDraft(
		tag,
		table.tag,
		table.tableRevision,
	);
	if (reconciledTag !== tag) setTag(reconciledTag);
	const [renaming, setRenaming] = useState(false);
	const [editingTag, setEditingTag] = useState(false);
	const [importing, setImporting] = useState(false);
	const [addingColumn, setAddingColumn] = useState<{
		readonly projectId: string;
		readonly tableId: LookupTableSnapshot["id"];
		readonly revision: LookupRevision;
	} | null>(null);
	const [deleting, setDeleting] = useState<LookupRevision | null>(null);
	const [addingRow, setAddingRow] = useState(false);
	const [settingWrite, setSettingWrite] = useState<"name" | "tag" | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);

	const capacity = tableCapacity(table);
	const full = rowAdditionRefusal(capacity);
	const tableBusy = addingRow || settingWrite !== null;

	const addRow = async () => {
		if (addingRow) return;
		setAddingRow(true);
		setFailure(null);
		/* An empty row, appended. Adding a row and filling it in are two
		 * gestures, and a dialog demanding every value before the row existed
		 * would make adding fifty rows fifty dialogs. The row lands at the end,
		 * so the status below says where to find it rather than leaving the
		 * author to hunt an unchanged-looking table. */
		try {
			const outcome = await workspace.addRow({} as LookupRowValues);
			if (outcome.kind === "failed") {
				setFailure(outcome.failure.message);
				return;
			}
			if (outcome.kind === "conflict") {
				setFailure(
					"The table changed before the row could be added. Try again.",
				);
				return;
			}
			setStatus("Added and opened a new empty row.");
		} catch {
			setFailure(
				"Nova could not reach this data table. Check your connection and try again.",
			);
		} finally {
			setAddingRow(false);
		}
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
							disabled={full !== undefined || tableBusy}
							onClick={() => void addRow()}
						>
							<Icon
								icon={tablerPlus}
								width="16"
								height="16"
								aria-hidden="true"
							/>
							{addingRow ? "Adding…" : "Add row"}
						</Button>
						<Button
							type="button"
							variant="outline"
							className="min-h-11 gap-2"
							disabled={tableBusy || projectId === undefined}
							onClick={() => {
								if (projectId === undefined) return;
								setAddingColumn({
									projectId,
									tableId: table.id,
									revision: table.tableRevision,
								});
							}}
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
							disabled={tableBusy}
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
							disabled={settingWrite !== null}
							onClick={() => setRenaming(true)}
						>
							Rename
						</Button>
					</>
				)}
				{canDelete && (
					<>
						<Button
							type="button"
							variant="ghost"
							className="min-h-11"
							disabled={settingWrite !== null}
							onClick={() => setEditingTag(true)}
						>
							Edit export tag
						</Button>
						<Button
							type="button"
							variant="ghost"
							className="min-h-11 gap-2 text-nova-text-muted hover:text-nova-text"
							disabled={tableBusy}
							onClick={() => setDeleting(table.tableRevision)}
						>
							<Icon
								icon={tablerTrash}
								width="16"
								height="16"
								aria-hidden="true"
							/>
							Delete table
						</Button>
					</>
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

			{canEdit && renaming && (
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<Input
							value={name.text}
							disabled={settingWrite !== null}
							autoComplete="off"
							data-1p-ignore
							aria-label="Table name"
							onChange={(event) =>
								setName((current) =>
									editRevisionedTextDraft(current, event.target.value),
								)
							}
							className="h-11 max-w-xs"
						/>
						<Button
							type="button"
							variant="default"
							className="min-h-11"
							disabled={!name.dirty || name.conflicted || settingWrite !== null}
							onClick={async () => {
								if (
									projectId === undefined ||
									name.conflicted ||
									settingWrite !== null
								) {
									return;
								}
								setSettingWrite("name");
								setFailure(null);
								try {
									const result = await updateLookupTableNameAction(projectId, {
										tableId: table.id,
										expectedTableRevision: name.baseRevision,
										name: name.text,
									});
									if (result.success) {
										setRenaming(false);
										setStatus("Table name saved.");
										await workspace.reload();
									} else {
										setFailure(result.message);
										if (result.code === "conflict") await workspace.reload();
									}
								} catch {
									setFailure(
										"Nova could not save the table name. Check your connection and try again.",
									);
								} finally {
									setSettingWrite(null);
								}
							}}
						>
							{settingWrite === "name" ? "Saving…" : "Save name"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							className="min-h-11"
							disabled={settingWrite !== null}
							onClick={() => {
								setName((current) => discardRevisionedTextDraft(current));
								setRenaming(false);
							}}
						>
							Cancel
						</Button>
					</div>
					{name.conflicted && (
						<DraftDriftNotice
							subject="table name"
							draft={name}
							onChange={setName}
							disabled={settingWrite !== null}
						/>
					)}
				</div>
			)}

			{canDelete && editingTag && (
				<div className="space-y-2">
					<p className="text-[12px] leading-snug text-nova-text-muted">
						The export tag is the stable table name CommCare and integrations
						use. Changing it needs admin access.
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Input
							value={tag.text}
							disabled={settingWrite !== null}
							autoComplete="off"
							data-1p-ignore
							aria-label="Export tag"
							onChange={(event) =>
								setTag((current) =>
									editRevisionedTextDraft(current, event.target.value),
								)
							}
							className="h-11 max-w-xs font-mono"
						/>
						<Button
							type="button"
							variant="default"
							className="min-h-11"
							disabled={!tag.dirty || tag.conflicted || settingWrite !== null}
							onClick={async () => {
								if (
									projectId === undefined ||
									tag.conflicted ||
									settingWrite !== null
								) {
									return;
								}
								setSettingWrite("tag");
								setFailure(null);
								try {
									const result = await updateLookupTableTagAction(projectId, {
										tableId: table.id,
										expectedTableRevision: tag.baseRevision,
										tag: tag.text,
									});
									if (result.success) {
										setEditingTag(false);
										setStatus("Export tag saved.");
										await workspace.reload();
									} else {
										setFailure(result.message);
										if (result.code === "conflict") await workspace.reload();
									}
								} catch {
									setFailure(
										"Nova could not save the export tag. Check your connection and try again.",
									);
								} finally {
									setSettingWrite(null);
								}
							}}
						>
							{settingWrite === "tag" ? "Saving…" : "Save export tag"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							className="min-h-11"
							disabled={settingWrite !== null}
							onClick={() => {
								setTag((current) => discardRevisionedTextDraft(current));
								setEditingTag(false);
							}}
						>
							Cancel
						</Button>
					</div>
					{tag.conflicted && (
						<DraftDriftNotice
							subject="export tag"
							draft={tag}
							onChange={setTag}
							disabled={settingWrite !== null}
						/>
					)}
				</div>
			)}

			{canEdit && addingColumn !== null && (
				<AddColumnDialog
					open
					onClose={() => setAddingColumn(null)}
					onCreate={async (draft) => {
						if (
							projectId !== addingColumn.projectId ||
							table.id !== addingColumn.tableId
						) {
							return "This project or table changed while the dialog was open. Close it and add the column from the table you are viewing.";
						}
						const result = await addLookupColumnAction(addingColumn.projectId, {
							tableId: addingColumn.tableId,
							expectedTableRevision: addingColumn.revision,
							column: draft,
						});
						if (!result.success) {
							if (
								result.code === "conflict" &&
								result.currentRevisions !== undefined
							) {
								setAddingColumn({
									...addingColumn,
									revision: result.currentRevisions.tableRevision,
								});
								await workspace.reload();
							}
							return result.message;
						}
						await workspace.reload();
						return null;
					}}
				/>
			)}

			{canEdit && importing && (
				<CsvImportDialog
					open
					table={table}
					onClose={() => setImporting(false)}
					onImported={workspace.reload}
				/>
			)}

			{canDelete && deleting !== null && (
				<DestructiveChangeDialog
					open
					table={table}
					title={`Delete “${table.name}”?`}
					consequence={`Its ${table.columns.length === 1 ? "column" : `${table.columns.length} columns`} and every one of its rows are deleted. This cannot be undone.`}
					confirmLabel="Delete table"
					onCancel={() => setDeleting(null)}
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
							expectedTableRevision: deleting,
						});
						if (!result.success) {
							if (
								result.code === "conflict" &&
								result.currentRevisions !== undefined
							) {
								setDeleting(result.currentRevisions.tableRevision);
								await workspace.reload();
							}
							return result;
						}
						setDeleting(null);
						navigate.openProjectData();
						return null;
					}}
				/>
			)}
		</div>
	);
}

function DraftDriftNotice({
	subject,
	draft,
	onChange,
	disabled,
}: {
	subject: string;
	draft: RevisionedTextDraft;
	onChange: (next: RevisionedTextDraft) => void;
	disabled: boolean;
}) {
	return (
		<div
			role="alert"
			className="rounded-lg border border-nova-amber/30 bg-nova-amber/[0.08] p-3"
		>
			<p className="text-[13px] leading-relaxed text-nova-text-secondary">
				This table changed while you were editing its {subject}. Review the
				current value before saving your draft.
			</p>
			<p className="mt-1 font-mono text-[12px] text-nova-text-muted [overflow-wrap:anywhere]">
				Current: {draft.latestText}
			</p>
			<div className="mt-2 flex flex-wrap gap-2">
				<Button
					type="button"
					variant="ghost"
					className="min-h-11"
					disabled={disabled}
					onClick={() => onChange(discardRevisionedTextDraft(draft))}
				>
					Use current
				</Button>
				<Button
					type="button"
					variant="outline"
					className="min-h-11"
					disabled={disabled}
					onClick={() => onChange(keepRevisionedTextDraft(draft))}
				>
					Keep my draft
				</Button>
			</div>
		</div>
	);
}
