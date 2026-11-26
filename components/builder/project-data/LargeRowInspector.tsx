"use client";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Textarea } from "@/components/shadcn/textarea";
import {
	getLookupRowProjectionAction,
	updateLookupRowAction,
} from "@/lib/lookup/actions";
import type { LookupValueSlot } from "@/lib/lookup/largeValues/input";
import type {
	LookupColumn,
	LookupRow,
	LookupRowPatch,
	LookupRowsPage,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { LookupOrderingSection } from "./LookupOrderingSection";
import { displayedParts, type LargeRowEdit } from "./largeRowModel";
import { sendLookupGesture } from "./lookupGesture";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import {
	captureRowEditBaseline,
	rowDraftToValues,
	rowValuesToDraft,
} from "./projectDataModel";
import { RowValueField } from "./RowValueField";
import { ValueSliceEditor } from "./ValueSliceEditor";

export function LargeRowInspector({
	table,
	row,
	workspace,
	canEdit,
}: {
	table: LookupTableSnapshot;
	row: LookupRow;
	workspace: ProjectDataWorkspace;
	canEdit: boolean;
}) {
	const [chosen, setChosen] = useState<string>();
	const retained = workspace.rowEditFor(row.id);
	const [opened, setOpened] =
		useState<Extract<LargeRowEdit, { kind: "slice" }>>();
	const edit = retained?.large ?? opened;
	const fieldId =
		edit?.fieldId ??
		chosen ??
		table.columns[0]?.id ??
		table.attributes?.[0]?.id;
	const column = table.columns.find((column) => column.id === fieldId);
	const attribute = table.attributes?.find((member) => member.id === fieldId);
	const [page, setPage] = useState<LookupRowsPage>();
	const [cursor, setCursor] = useState<string>();
	const [retry, setRetry] = useState(0);
	const [working, setWorking] = useState(false);
	const [failure, setFailure] = useState("");
	const [message, setMessage] = useState("");
	const input = useId();
	const textId = useId();
	const columnId = column?.id,
		attributeId = attribute?.id;
	const { projectId, id: tableId, tableRevision } = table;
	const { id: rowId } = row;
	useEffect(() => {
		let owner = true;
		setPage(undefined);
		setFailure("");
		const read = async () => {
			if (!columnId && !attributeId) return;
			try {
				const answer = await getLookupRowProjectionAction(projectId, {
					tableId,
					rowId,
					columnIds: columnId ? [columnId] : [],
					attributeIds: attributeId ? [attributeId] : [],
					cursor,
				});
				if (!owner) return;
				if (!answer.success) {
					setFailure(answer.message);
					return;
				}
				if (answer.value.table.tableRevision !== tableRevision) {
					setFailure("This row changed. You can reload its values.");
					return;
				}
				setPage(answer.value);
			} catch {
				if (owner)
					setFailure("Nova couldn't read this value. You can try again.");
			}
		};
		void retry;
		void read();
		return () => {
			owner = false;
		};
	}, [
		tableId,
		projectId,
		rowId,
		tableRevision,
		columnId,
		attributeId,
		retry,
		cursor,
	]);
	const retain = (large: LargeRowEdit) =>
		workspace.retainRowEdit({
			projectId,
			tableId,
			tableName: table.name,
			rowId,
			baseline: retained?.baseline ?? captureRowEditBaseline(table, row),
			draft: {},
			large,
		});
	const start = (
		title: string,
		change: LookupRowPatch,
		definition?: LookupColumn,
	) => {
		if (!fieldId) return;
		setFailure("");
		setMessage("");
		const cell =
			definition && change.kind === "cell"
				? rowValuesToDraft(
						change.value === null ? {} : { [definition.id]: change.value },
						[definition],
					)[definition.id]
				: undefined;
		retain({
			kind: "patch",
			title,
			fieldId,
			revision: tableRevision,
			change,
			cell,
		});
	};
	const save = async () => {
		if (
			edit?.kind !== "patch" ||
			!canEdit ||
			working ||
			edit.revision !== tableRevision
		)
			return;
		let change = edit.change;
		if (change.kind === "cell" && column && edit.cell) {
			const typed = rowDraftToValues({ [column.id]: edit.cell }, [column]);
			if (!typed.ok) {
				setFailure(
					typed.errors.get(column.id) ?? "This value needs attention.",
				);
				return;
			}
			change = { ...change, value: typed.values[column.id] ?? null };
		}
		setWorking(true);
		setFailure("");
		try {
			const answer = await sendLookupGesture(updateLookupRowAction, projectId, {
				tableId,
				rowId,
				expectedTableRevision: edit.revision,
				changes: [change],
			});
			if (!answer.success) {
				setFailure(answer.message);
				if (answer.code === "conflict") await workspace.reload();
				return;
			}
			workspace.discardRowEdit(rowId);
			setCursor(undefined);
			await workspace.reload();
			setMessage("Value saved.");
		} catch {
			setFailure(
				"Nova couldn't confirm this edit. You can check the saved value and try again.",
			);
		} finally {
			setWorking(false);
		}
	};
	const persisted = page?.rows.find((item) => item.id === rowId);
	const parts = persisted ? displayedParts(persisted) : [];
	const reload = async () => {
		setCursor(undefined);
		setRetry((x) => x + 1);
		await workspace.reload();
	};
	const titleFor = (slot: LookupValueSlot) => {
		if (slot.kind === "attribute") return attribute?.label ?? "Row detail";
		if (slot.kind === "property")
			return `Value ${slot.index + 1} · ${column?.properties?.find((p) => p.id === slot.propertyId)?.label ?? "Detail"}`;
		return slot.kind === "cell"
			? (column?.label ?? "Value")
			: `Value ${slot.index + 1}`;
	};
	return (
		<div className="space-y-4">
			<p className="text-sm text-nova-text-secondary">
				This row opens one column or row detail at a time.
			</p>
			<label htmlFor={input}>Column or row detail</label>
			<Select
				value={fieldId ?? ""}
				disabled={!!edit}
				onValueChange={(id) => {
					setChosen(id ?? undefined);
					setCursor(undefined);
					setMessage("");
				}}
			>
				<SelectTrigger id={input} className="min-h-11 w-full">
					<SelectValue>{column?.label ?? attribute?.label}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{[...table.columns, ...(table.attributes ?? [])].map((item) => (
						<SelectItem key={item.id} value={item.id}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{edit?.kind === "slice" ? (
				<ValueSliceEditor
					key={JSON.stringify(edit.target)}
					projectId={projectId}
					target={edit.target}
					initialOffset={edit.initialOffset}
					canEdit={canEdit}
					label={edit.title}
					saved={edit}
					retain={retain}
					onSaved={reload}
					onClose={() => {
						workspace.discardRowEdit(rowId);
						setOpened(undefined);
					}}
				/>
			) : (
				<>
					{!page && !failure && <p role="status">Reading value</p>}
					{page && parts.length === 0 && <p>No value supplied.</p>}
					{parts.map((part) => {
						if (part.kind === "count")
							return (
								<p key="count">
									{part.count === 0
										? "Empty list"
										: `${part.count} ${part.count === 1 ? "value" : "values"}`}
								</p>
							);
						const slot = part.slot;
						const title = titleFor(slot);
						const isPartial =
							typeof part.value === "string" &&
							part.totalBytes !== undefined &&
							(part.byteOffset > 0 ||
								new TextEncoder().encode(part.value).length < part.totalBytes);
						return (
							<section
								key={JSON.stringify([slot, part.byteOffset])}
								className="space-y-1 rounded-lg border border-nova-border p-2"
							>
								<h3 className="text-xs font-medium">
									{title}
									{isPartial ? ` · from byte ${part.byteOffset + 1}` : ""}
								</h3>
								<p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
									{part.value === "" ? "Empty text" : part.value}
								</p>
								<div className="flex flex-wrap gap-1">
									{!edit && (
										<>
											{typeof part.value === "string" &&
												(isPartial ||
													slot.kind !== "cell" ||
													column?.dataType === "text") && (
													<Button
														variant="outline"
														onClick={() => {
															if (fieldId)
																setOpened({
																	kind: "slice",
																	title,
																	fieldId,
																	target: {
																		tableId,
																		rowId,
																		slot,
																		expectedTableRevision: tableRevision,
																	},
																	initialOffset: part.byteOffset,
																});
														}}
													>
														{canEdit ? "Open text editor" : "Read text"}
													</Button>
												)}
											{canEdit && slot.kind === "cell" && !isPartial && (
												<Button
													variant="outline"
													onClick={() =>
														start(title, { ...slot, value: part.value }, column)
													}
												>
													Edit value
												</Button>
											)}
											{canEdit && slot.kind === "cell" && (
												<Button
													variant="ghost"
													onClick={() =>
														start("Remove this value", { ...slot, value: null })
													}
												>
													Remove value
												</Button>
											)}
											{canEdit &&
												slot.kind === "occurrence" &&
												part.byteOffset === 0 && (
													<>
														<Button
															variant="outline"
															onClick={() =>
																start(`Insert after value ${slot.index + 1}`, {
																	kind: "insert",
																	columnId: slot.columnId,
																	index: slot.index + 1,
																	value: { text: "", properties: {} },
																})
															}
														>
															Insert after
														</Button>
														<Button
															variant="ghost"
															onClick={() =>
																start(`Remove value ${slot.index + 1}`, {
																	kind: "remove",
																	columnId: slot.columnId,
																	index: slot.index,
																})
															}
														>
															Remove value
														</Button>
														{column?.properties?.map((member) => (
															<Button
																key={member.id}
																variant="ghost"
																onClick={() =>
																	start(
																		`Set ${member.label} for value ${slot.index + 1}`,
																		{
																			kind: "property",
																			columnId: slot.columnId,
																			index: slot.index,
																			propertyId: member.id,
																			text: "",
																		},
																	)
																}
															>
																Set {member.label}
															</Button>
														))}
													</>
												)}
											{canEdit && slot.kind === "property" && (
												<Button
													variant="ghost"
													onClick={() =>
														start(`Remove ${title}`, { ...slot, text: null })
													}
												>
													Remove detail
												</Button>
											)}
										</>
									)}
								</div>
							</section>
						);
					})}
					{page && canEdit && !edit && (
						<div className="flex flex-wrap gap-2">
							{column?.repeated ? (
								<>
									<Button
										variant="outline"
										onClick={() =>
											start("Insert a first value", {
												kind: "insert",
												columnId: column.id,
												index: 0,
												value: { text: "", properties: {} },
											})
										}
									>
										Insert first value
									</Button>
									<Button
										variant="outline"
										onClick={() =>
											start("Replace all values with an empty list", {
												kind: "list",
												columnId: column.id,
												present: true,
											})
										}
									>
										Use an empty list
									</Button>
									<Button
										variant="outline"
										onClick={() =>
											start("Remove the whole list", {
												kind: "list",
												columnId: column.id,
												present: false,
											})
										}
									>
										Leave list unspecified
									</Button>
								</>
							) : !parts.length && column ? (
								<Button
									variant="outline"
									onClick={() =>
										start(
											column.label,
											{ kind: "cell", columnId: column.id, value: "" },
											column,
										)
									}
								>
									Set value
								</Button>
							) : !parts.length && attribute ? (
								<Button
									variant="outline"
									onClick={() =>
										start(attribute.label, {
											kind: "attribute",
											attributeId: attribute.id,
											text: "",
										})
									}
								>
									Set detail
								</Button>
							) : null}
						</div>
					)}
					{!edit && page?.nextCursor && (
						<Button
							variant="outline"
							onClick={() => setCursor(page.nextCursor)}
						>
							Next values
						</Button>
					)}
					{!edit && cursor && (
						<Button variant="outline" onClick={() => setCursor(undefined)}>
							First values
						</Button>
					)}
					{edit?.kind === "patch" && (
						<section className="space-y-2 rounded border border-nova-border p-2">
							<h3 className="font-medium">{edit.title}</h3>
							{edit.change.kind === "cell" && edit.cell && column && (
								<RowValueField
									column={column}
									value={edit.cell}
									disabled={!canEdit || working}
									onChange={(cell) => retain({ ...edit, cell })}
								/>
							)}
							{(edit.change.kind === "insert" ||
								edit.change.kind === "attribute" ||
								edit.change.kind === "occurrence" ||
								(edit.change.kind === "property" &&
									edit.change.text !== null)) && (
								<label htmlFor={textId}>
									New text
									<Textarea
										id={textId}
										disabled={!canEdit || working}
										value={
											edit.change.kind === "insert"
												? edit.change.value.text
												: (edit.change.text ?? "")
										}
										onChange={(e) => {
											const c = edit.change,
												text = e.target.value;
											if (c.kind === "insert")
												retain({
													...edit,
													change: { ...c, value: { ...c.value, text } },
												});
											else if (
												c.kind === "attribute" ||
												c.kind === "occurrence" ||
												c.kind === "property"
											)
												retain({ ...edit, change: { ...c, text } });
										}}
									/>
								</label>
							)}
							{edit.revision !== tableRevision && (
								<p role="alert">
									The table changed while you were editing. Your change is kept
									here. You can copy the text and open the saved value again.
								</p>
							)}
							<div className="flex flex-wrap gap-2">
								{canEdit && (
									<Button
										disabled={working || edit.revision !== tableRevision}
										onClick={() => void save()}
									>
										Save change
									</Button>
								)}
								<Button
									variant="outline"
									disabled={working}
									onClick={() => workspace.discardRowEdit(rowId)}
								>
									Discard edit
								</Button>
							</div>
						</section>
					)}
					{failure && (
						<p role="alert" className="text-nova-rose">
							{failure}{" "}
							<Button variant="ghost-action" onClick={() => void reload()}>
								Read again
							</Button>
						</p>
					)}
					{message && <p role="status">{message}</p>}
					<LookupOrderingSection
						kind="row"
						itemId={row.id}
						table={table}
						workspace={workspace}
						canEdit={canEdit}
						disabled={!!edit}
					/>
				</>
			)}
		</div>
	);
}
