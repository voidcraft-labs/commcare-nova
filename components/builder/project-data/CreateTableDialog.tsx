/**
 * Create a data table.
 *
 * A table is born with at least one column, because that is what the boundary
 * requires and because a columnless table is not a thing anyone wants — the
 * dialog therefore starts with one row of column fields rather than creating
 * an empty shell you then have to fill.
 *
 * The tag is the table's external name, the one CommCare and every export use.
 * It is derived from the table's name and stays editable for the same reason a
 * column's export name is: it is a contract, and deriving it silently would
 * hide that a rename later is a governed change.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { createLookupTableAction } from "@/lib/lookup/actions";
import { LOOKUP_DATA_TYPES } from "@/lib/lookup/constants";
import type { LookupDataType } from "@/lib/lookup/types";
import { useNavigate } from "@/lib/routing/hooks";
import { useProjectId } from "@/lib/session/hooks";
import { COLUMN_TYPE_LABELS, suggestWireName } from "./projectDataModel";

interface ColumnDraft {
	readonly key: number;
	label: string;
	wireName: string;
	wireNameTouched: boolean;
	dataType: LookupDataType;
}

let nextDraftKey = 0;

function newColumnDraft(): ColumnDraft {
	return {
		key: nextDraftKey++,
		label: "",
		wireName: "",
		wireNameTouched: false,
		dataType: "text",
	};
}

export function CreateTableDialog({
	open,
	onClose,
	onCreated,
}: {
	open: boolean;
	onClose: () => void;
	onCreated: () => Promise<void>;
}) {
	const nameId = useId();
	const tagId = useId();
	const projectId = useProjectId();
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [tag, setTag] = useState("");
	const [tagTouched, setTagTouched] = useState(false);
	const [columns, setColumns] = useState<ColumnDraft[]>(() => [
		newColumnDraft(),
	]);
	const [failure, setFailure] = useState<string | null>(null);
	const [working, setWorking] = useState(false);

	const effectiveTag = tagTouched ? tag : suggestWireName(name);
	const ready =
		name.trim() !== "" &&
		effectiveTag.trim() !== "" &&
		columns.length > 0 &&
		columns.every(
			(column) =>
				column.label.trim() !== "" &&
				(column.wireNameTouched
					? column.wireName.trim() !== ""
					: suggestWireName(column.label) !== ""),
		);

	const patch = (key: number, next: Partial<ColumnDraft>) =>
		setColumns((current) =>
			current.map((column) =>
				column.key === key ? { ...column, ...next } : column,
			),
		);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Create a data table</DialogTitle>
					<DialogDescription>
						Every app in this project will be able to use this table’s values.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div>
						<Label htmlFor={nameId} className="text-[13px]">
							Table name
						</Label>
						<Input
							id={nameId}
							value={name}
							placeholder="Facilities"
							autoComplete="off"
							data-1p-ignore
							onChange={(event) => setName(event.target.value)}
							className="mt-1 h-11"
						/>
					</div>
					<div>
						<Label htmlFor={tagId} className="text-[13px]">
							Name in exports
						</Label>
						<Input
							id={tagId}
							value={effectiveTag}
							autoComplete="off"
							data-1p-ignore
							onChange={(event) => {
								setTagTouched(true);
								setTag(event.target.value);
							}}
							className="mt-1 h-11"
						/>
						<p className="mt-1 text-[12px] leading-snug text-nova-text-muted">
							Letters, digits, and underscores. Changing it later needs admin
							access.
						</p>
					</div>

					<fieldset className="space-y-3">
						<legend className="text-[13px] font-medium text-nova-text">
							Columns
						</legend>
						{columns.map((column, index) => (
							<div
								key={column.key}
								className="space-y-2 rounded-lg border border-nova-border p-3"
							>
								<div className="flex items-center justify-between gap-2">
									<span className="text-[12px] text-nova-text-muted">
										Column {index + 1}
									</span>
									{columns.length > 1 && (
										<Button
											type="button"
											variant="ghost"
											size="icon-lg"
											aria-label={`Remove column ${index + 1}`}
											className="size-11 text-nova-text-muted hover:text-nova-text"
											onClick={() =>
												setColumns((current) =>
													current.filter(
														(candidate) => candidate.key !== column.key,
													),
												)
											}
										>
											<Icon icon={tablerTrash} width="16" height="16" />
										</Button>
									)}
								</div>
								<Input
									value={column.label}
									placeholder="Name people see"
									aria-label={`Column ${index + 1} name`}
									autoComplete="off"
									data-1p-ignore
									onChange={(event) =>
										patch(column.key, { label: event.target.value })
									}
									className="h-11"
								/>
								<Input
									value={
										column.wireNameTouched
											? column.wireName
											: suggestWireName(column.label)
									}
									placeholder="Name in exports"
									aria-label={`Column ${index + 1} export name`}
									autoComplete="off"
									data-1p-ignore
									onChange={(event) =>
										patch(column.key, {
											wireNameTouched: true,
											wireName: event.target.value,
										})
									}
									className="h-11"
								/>
								<Select
									value={column.dataType}
									onValueChange={(next) =>
										patch(column.key, { dataType: next as LookupDataType })
									}
								>
									<SelectTrigger
										aria-label={`Column ${index + 1} type`}
										className="h-11 w-full"
									>
										<SelectValue>
											{(selected) =>
												COLUMN_TYPE_LABELS[selected as LookupDataType]
											}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{LOOKUP_DATA_TYPES.map((candidate) => (
											<SelectItem key={candidate} value={candidate}>
												{COLUMN_TYPE_LABELS[candidate]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						))}
						<Button
							type="button"
							variant="outline"
							className="min-h-11 gap-2"
							onClick={() =>
								setColumns((current) => [...current, newColumnDraft()])
							}
						>
							<Icon
								icon={tablerPlus}
								width="16"
								height="16"
								aria-hidden="true"
							/>
							Add another column
						</Button>
					</fieldset>

					{failure !== null && (
						<p
							role="alert"
							className="text-[13px] leading-relaxed text-nova-rose"
						>
							{failure}
						</p>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						className="min-h-11"
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="default"
						className="min-h-11"
						disabled={!ready || working || projectId === undefined}
						onClick={async () => {
							if (projectId === undefined) return;
							setWorking(true);
							setFailure(null);
							const result = await createLookupTableAction(projectId, {
								name: name.trim(),
								tag: effectiveTag.trim(),
								columns: columns.map((column) => ({
									label: column.label.trim(),
									wireName: (column.wireNameTouched
										? column.wireName
										: suggestWireName(column.label)
									).trim(),
									dataType: column.dataType,
								})),
							});
							setWorking(false);
							if (!result.success) {
								setFailure(result.message);
								return;
							}
							await onCreated();
							onClose();
							/* Straight into the new table: creating one is always the first
							 * half of filling it in. */
							navigate.openProjectData(result.value.id);
						}}
					>
						{working ? "Creating…" : "Create table"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
