/**
 * One column of a Project data table.
 *
 * Three of the four things you can do here are governed rather than ordinary,
 * and the panel says which is which rather than presenting them as one menu of
 * equals:
 *
 *   - the LABEL is a display name; changing it affects nothing else;
 *   - the WIRE NAME is an external contract every export and every CSV header
 *     uses, so it needs the `delete` capability;
 *   - the TYPE and REMOVAL are destructive or contract-breaking, need `delete`,
 *     AND need zero apps referencing the column, which is what the
 *     confirmation names before it happens.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { LOOKUP_DATA_TYPES } from "@/lib/lookup/constants";
import type {
	LookupColumn,
	LookupDataType,
	LookupRevision,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useCanDelete, useCanEdit } from "@/lib/session/hooks";
import { DestructiveChangeDialog } from "./DestructiveChangeDialog";
import { LookupOrderingSection } from "./LookupOrderingSection";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import {
	COLUMN_TYPE_LABELS,
	createRevisionedTextDraft,
	discardRevisionedTextDraft,
	editRevisionedTextDraft,
	keepRevisionedTextDraft,
	type RevisionedTextDraft,
	reconcileRevisionedTextDraft,
} from "./projectDataModel";
import { useColumnWrites } from "./useProjectDataWrites";

export function ColumnInspectorBody({
	column,
	table,
	workspace,
}: {
	column: LookupColumn;
	table: LookupTableSnapshot;
	workspace: ProjectDataWorkspace;
}) {
	const canEdit = useCanEdit();
	const canDelete = useCanDelete();
	const labelId = useId();
	const wireNameId = useId();
	const typeId = useId();
	const writes = useColumnWrites(table, workspace.reload);

	const [label, setLabel] = useState(() =>
		createRevisionedTextDraft(column.label, table.tableRevision),
	);
	const [wireName, setWireName] = useState(() =>
		createRevisionedTextDraft(column.wireName, table.tableRevision),
	);
	const [settingWrite, setSettingWrite] = useState<
		"label" | "wire-name" | null
	>(null);
	const reconciledLabel = reconcileRevisionedTextDraft(
		label,
		column.label,
		table.tableRevision,
	);
	if (reconciledLabel !== label) setLabel(reconciledLabel);
	const reconciledWireName = reconcileRevisionedTextDraft(
		wireName,
		column.wireName,
		table.tableRevision,
	);
	if (reconciledWireName !== wireName) setWireName(reconciledWireName);
	const [pending, setPending] = useState<
		| { readonly kind: "remove"; readonly revision: LookupRevision }
		| {
				readonly kind: "retype";
				readonly dataType: LookupDataType;
				readonly revision: LookupRevision;
		  }
		| null
	>(null);

	const lastColumn = table.columns.length <= 1;

	return (
		<div className="space-y-5">
			{!canEdit && (
				<p className="rounded-lg bg-nova-elevated px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary">
					You can read this column. Changing it needs edit access to this
					project.
				</p>
			)}

			<div className="min-w-0 space-y-2">
				<Label htmlFor={labelId} className="text-[13px]">
					Name people see
				</Label>
				{canEdit ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Input
								id={labelId}
								value={label.text}
								disabled={settingWrite !== null}
								autoComplete="off"
								data-1p-ignore
								onChange={(event) =>
									setLabel((current) =>
										editRevisionedTextDraft(current, event.target.value),
									)
								}
								className="h-11 min-w-0 grow"
							/>
							<Button
								type="button"
								variant="outline"
								className=""
								disabled={
									!label.dirty || label.conflicted || settingWrite !== null
								}
								onClick={async () => {
									if (settingWrite !== null) return;
									setSettingWrite("label");
									try {
										await writes.renameLabel(
											column,
											label.text,
											label.baseRevision,
										);
									} finally {
										setSettingWrite(null);
									}
								}}
							>
								{settingWrite === "label" ? "Saving" : "Save name"}
							</Button>
						</div>
						{label.conflicted && (
							<ColumnDraftDriftNotice
								subject="name"
								draft={label}
								onChange={setLabel}
								disabled={settingWrite !== null}
							/>
						)}
					</>
				) : (
					<p className="mt-1 text-[13px] text-nova-text-secondary [overflow-wrap:anywhere]">
						{column.label}
					</p>
				)}
				<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
					Shown in this table and wherever a question offers its values.
					Changing it is safe.
				</p>
			</div>

			<div className="min-w-0 space-y-2">
				<Label htmlFor={wireNameId} className="text-[13px]">
					Column name in exports and CSV
				</Label>
				{canDelete ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Input
								id={wireNameId}
								value={wireName.text}
								disabled={settingWrite !== null}
								autoComplete="off"
								data-1p-ignore
								onChange={(event) =>
									setWireName((current) =>
										editRevisionedTextDraft(current, event.target.value),
									)
								}
								className="h-11 min-w-0 grow font-mono"
							/>
							<Button
								type="button"
								variant="outline"
								className=""
								disabled={
									!wireName.dirty ||
									wireName.conflicted ||
									settingWrite !== null
								}
								onClick={async () => {
									if (settingWrite !== null) return;
									setSettingWrite("wire-name");
									try {
										await writes.renameWireName(
											column,
											wireName.text,
											wireName.baseRevision,
										);
									} finally {
										setSettingWrite(null);
									}
								}}
							>
								{settingWrite === "wire-name" ? "Saving" : "Save export name"}
							</Button>
						</div>
						{wireName.conflicted && (
							<ColumnDraftDriftNotice
								subject="export name"
								draft={wireName}
								onChange={setWireName}
								disabled={settingWrite !== null}
							/>
						)}
					</>
				) : (
					<p className="mt-1 font-mono text-[13px] text-nova-text-secondary [overflow-wrap:anywhere]">
						{column.wireName}
					</p>
				)}
				<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
					{canDelete
						? "This is the heading a CSV import must use, and the name CommCare sees. Changing it means every CSV you import from now on needs the new heading."
						: "This is the heading a CSV import must use, and the name CommCare sees. Changing it needs admin access."}
				</p>
			</div>

			<div className="min-w-0">
				<Label htmlFor={typeId} className="text-[13px]">
					Type of value
				</Label>
				{canDelete ? (
					<Select
						value={column.dataType}
						disabled={settingWrite !== null}
						onValueChange={(next) => {
							if (next !== column.dataType) {
								setPending({
									kind: "retype",
									dataType: next as LookupDataType,
									revision: table.tableRevision,
								});
							}
						}}
					>
						{/* `min-h-11`, not `h-11`: the trigger's height is a `data-[size=…]`
						 * variant, which outranks a bare `h-*` from a call site. */}
						<SelectTrigger id={typeId} className="mt-1 min-h-11 w-full">
							<SelectValue>
								{(selected) => COLUMN_TYPE_LABELS[selected as LookupDataType]}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{LOOKUP_DATA_TYPES.map((dataType) => (
								<SelectItem key={dataType} value={dataType}>
									{COLUMN_TYPE_LABELS[dataType]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : (
					<p className="mt-1 text-[13px] text-nova-text-secondary">
						{COLUMN_TYPE_LABELS[column.dataType]}
					</p>
				)}
				<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
					{canDelete
						? "Every value already in this column has to fit the new type. Nova checks before it changes anything."
						: "Changing the type needs admin access."}
				</p>
			</div>

			<LookupOrderingSection
				kind="column"
				itemId={column.id}
				table={table}
				workspace={workspace}
				canEdit={canEdit}
				disabled={
					settingWrite !== null ||
					pending !== null ||
					label.dirty ||
					wireName.dirty
				}
				disabledReason={
					label.dirty || wireName.dirty
						? "Save or restore the current text before moving this column."
						: undefined
				}
			/>

			{writes.failure !== null && (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-rose">
					{writes.failure}
				</p>
			)}
			{writes.status !== null && (
				<p
					role="status"
					className="text-[13px] leading-relaxed text-nova-text-secondary"
				>
					{writes.status}
				</p>
			)}

			{canDelete && (
				<div className="border-t border-nova-border pt-4">
					<Button
						type="button"
						variant="ghost"
						disabled={lastColumn || settingWrite !== null}
						onClick={() =>
							setPending({
								kind: "remove",
								revision: table.tableRevision,
							})
						}
					>
						<Icon
							icon={tablerTrash}
							width="16"
							height="16"
							aria-hidden="true"
						/>
						Remove column
					</Button>
					{lastColumn && (
						<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
							A table needs at least one column. Delete the whole table instead.
						</p>
					)}
				</div>
			)}

			{canDelete && pending !== null && (
				<DestructiveChangeDialog
					open
					table={table}
					columnId={column.id}
					title={
						pending.kind === "remove"
							? `Remove “${column.label}”?`
							: `Change “${column.label}” to ${COLUMN_TYPE_LABELS[pending.dataType].toLowerCase()}?`
					}
					consequence={
						pending.kind === "remove"
							? "Every value in this column is deleted from every row. The rest of the table is untouched."
							: "Every value already in this column has to fit the new type. If any value does not, nothing changes and Nova tells you which rows to look at."
					}
					confirmLabel={
						pending.kind === "remove" ? "Remove column" : "Change type"
					}
					onCancel={() => setPending(null)}
					onConfirm={async () => {
						const refusal =
							pending.kind === "remove"
								? await writes.removeColumn(column, pending.revision)
								: await writes.retypeColumn(
										column,
										pending.dataType,
										pending.revision,
									);
						if (refusal === null) {
							setPending(null);
							/* A removed column has no inspector to return to; a retyped
							 * one does, so only removal clears the selection. */
							if (pending.kind === "remove") workspace.select(null);
						} else if (
							refusal.code === "conflict" &&
							refusal.currentRevisions !== undefined
						) {
							setPending({
								...pending,
								revision: refusal.currentRevisions.tableRevision,
							});
						}
						return refusal;
					}}
				/>
			)}
		</div>
	);
}

function ColumnDraftDriftNotice({
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
				This table changed while you were editing the column's {subject}. Review
				the current value before saving your draft.
			</p>
			<p className="mt-1 font-mono text-[12px] text-nova-text-muted [overflow-wrap:anywhere]">
				Current: {draft.latestText}
			</p>
			<div className="mt-2 flex flex-wrap gap-2">
				<Button
					type="button"
					variant="ghost"
					className=""
					disabled={disabled}
					onClick={() => onChange(discardRevisionedTextDraft(draft))}
				>
					Use current
				</Button>
				<Button
					type="button"
					variant="outline"
					className=""
					disabled={disabled}
					onClick={() => onChange(keepRevisionedTextDraft(draft))}
				>
					Keep my draft
				</Button>
			</div>
		</div>
	);
}
