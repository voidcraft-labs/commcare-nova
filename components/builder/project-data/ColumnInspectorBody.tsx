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
 *     AND need zero apps referencing the column — which is what the
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
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useCanDelete, useCanEdit } from "@/lib/session/hooks";
import { DestructiveChangeDialog } from "./DestructiveChangeDialog";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import { COLUMN_TYPE_LABELS } from "./projectDataModel";
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

	const [label, setLabel] = useState(column.label);
	const [wireName, setWireName] = useState(column.wireName);
	const [pending, setPending] = useState<
		| { readonly kind: "remove" }
		| { readonly kind: "retype"; readonly dataType: LookupDataType }
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

			<div className="min-w-0">
				<Label htmlFor={labelId} className="text-[13px]">
					Name people see
				</Label>
				<Input
					id={labelId}
					value={label}
					disabled={!canEdit}
					autoComplete="off"
					data-1p-ignore
					onChange={(event) => setLabel(event.target.value)}
					onBlur={() => {
						if (label !== column.label) void writes.renameLabel(column, label);
					}}
					className="mt-1 h-11"
				/>
				<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
					Shown in this table and wherever a question offers its values.
					Changing it is safe.
				</p>
			</div>

			<div className="min-w-0">
				<Label htmlFor={wireNameId} className="text-[13px]">
					Column name in exports and CSV
				</Label>
				<Input
					id={wireNameId}
					value={wireName}
					disabled={!canDelete}
					autoComplete="off"
					data-1p-ignore
					onChange={(event) => setWireName(event.target.value)}
					onBlur={() => {
						if (wireName !== column.wireName) {
							void writes.renameWireName(column, wireName);
						}
					}}
					className="mt-1 h-11"
				/>
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
				<Select
					value={column.dataType}
					disabled={!canDelete}
					onValueChange={(next) => {
						if (next !== column.dataType) {
							setPending({ kind: "retype", dataType: next as LookupDataType });
						}
					}}
				>
					<SelectTrigger id={typeId} className="mt-1 h-11 w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{LOOKUP_DATA_TYPES.map((dataType) => (
							<SelectItem key={dataType} value={dataType}>
								{COLUMN_TYPE_LABELS[dataType]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
					{canDelete
						? "Every value already in this column has to fit the new type. Nova checks before it changes anything."
						: "Changing the type needs admin access."}
				</p>
			</div>

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
						disabled={lastColumn}
						className="min-h-11 gap-2 text-nova-text-muted hover:text-nova-text"
						onClick={() => setPending({ kind: "remove" })}
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

			{pending !== null && (
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
								? await writes.removeColumn(column)
								: await writes.retypeColumn(column, pending.dataType);
						if (refusal === null) {
							setPending(null);
							/* A removed column has no inspector to return to; a retyped
							 * one does, so only removal clears the selection. */
							if (pending.kind === "remove") workspace.select(null);
						}
						return refusal;
					}}
				/>
			)}
		</div>
	);
}
