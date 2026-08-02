/**
 * Create a data table.
 *
 * A table is born with at least one column, because that is what the boundary
 * requires and because a columnless table is not a thing anyone wants, the
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
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/shadcn/dialog";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
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
import { useAppendedRowReveal } from "@/lib/ui/hooks/useAppendedRowReveal";
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
	/* One base per dialog; each column's three controls derive their id from it
	 * plus the draft key, so a label stays bound to its own input across adds
	 * and removals (the key is stable, the index is not). */
	const columnIds = useId();
	const projectId = useProjectId();
	const projectAtOpen = useRef(projectId);
	const latestProject = useRef(projectId);
	latestProject.current = projectId;
	/* The list normally opens only after Project identity resolves. If the
	 * first render catches the tiny undefined handoff, adopt that identity once;
	 * after that this dialog is permanently scoped to the Project it opened in. */
	if (projectAtOpen.current === undefined && projectId !== undefined) {
		projectAtOpen.current = projectId;
	}
	const operation = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		/* Claim the flag on every mount, not just the first. A cleanup-only
		 * version leaves it false forever the moment React mounts, unmounts and
		 * remounts the same instance: StrictMode's development double-invoke does
		 * exactly that, and then every `mounted.current` guard below returns
		 * early, stranding the dialog on "Creating…" after a successful write. */
		mounted.current = true;
		return () => {
			mounted.current = false;
			operation.current += 1;
		};
	}, []);
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [tag, setTag] = useState("");
	const [tagTouched, setTagTouched] = useState(false);
	const [columns, setColumns] = useState<ColumnDraft[]>(() => [
		newColumnDraft(),
	]);
	const [failure, setFailure] = useState<string | null>(null);
	const [working, setWorking] = useState(false);
	const reveal = useAppendedRowReveal(columns.length);

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
				if (!next && !working) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create a data table</DialogTitle>
					<DialogDescription>
						Every app in this Project will be able to use this table’s values.
					</DialogDescription>
				</DialogHeader>

				<DialogBody>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor={nameId}>Table name</FieldLabel>
							<Input
								id={nameId}
								value={name}
								placeholder="Facilities"
								autoComplete="off"
								data-1p-ignore
								disabled={working}
								onChange={(event) => setName(event.target.value)}
								className="h-11"
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={tagId}>Name in exports</FieldLabel>
							<Input
								id={tagId}
								value={effectiveTag}
								autoComplete="off"
								data-1p-ignore
								disabled={working}
								onChange={(event) => {
									setTagTouched(true);
									setTag(event.target.value);
								}}
								className="h-11"
							/>
							<FieldDescription>
								Letters, digits, and underscores. Changing it later needs admin
								access.
							</FieldDescription>
						</Field>

						<FieldSet>
							<FieldLegend variant="label">Columns</FieldLegend>
							{columns.map((column, index) => {
								const labelId = `${columnIds}-${column.key}-label`;
								const wireNameId = `${columnIds}-${column.key}-wire`;
								const typeId = `${columnIds}-${column.key}-type`;
								return (
									/* A real fieldset per column: its legend captions the group, so
									 * "Name people see" is announced inside "Column 2" rather than
									 * arriving as the third identically-labelled input on screen.
									 * The legend carries text only: the browser renders it into
									 * the border line, which a 44px control would straddle, so
									 * removal sits at the foot of the card, under its own name. */
									<FieldSet
										key={column.key}
										ref={reveal.register(index)}
										className="gap-4 rounded-lg border border-nova-border p-3"
									>
										<FieldLegend
											variant="label"
											className="mb-0 text-nova-text-muted"
										>
											Column {index + 1}
										</FieldLegend>
										<Field>
											<FieldLabel htmlFor={labelId}>Name people see</FieldLabel>
											<Input
												id={labelId}
												value={column.label}
												autoComplete="off"
												data-1p-ignore
												disabled={working}
												onChange={(event) =>
													patch(column.key, { label: event.target.value })
												}
												className="h-11"
											/>
										</Field>
										<Field>
											<FieldLabel htmlFor={wireNameId}>
												Name in exports and CSV
											</FieldLabel>
											<Input
												id={wireNameId}
												value={
													column.wireNameTouched
														? column.wireName
														: suggestWireName(column.label)
												}
												autoComplete="off"
												data-1p-ignore
												disabled={working}
												onChange={(event) =>
													patch(column.key, {
														wireNameTouched: true,
														wireName: event.target.value,
													})
												}
												className="h-11"
											/>
											<FieldDescription>
												This is the heading a CSV import must use.
											</FieldDescription>
										</Field>
										<Field>
											<FieldLabel htmlFor={typeId}>Type of value</FieldLabel>
											<Select
												value={column.dataType}
												disabled={working}
												onValueChange={(next) =>
													patch(column.key, {
														dataType: next as LookupDataType,
													})
												}
											>
												{/* `min-h-11`, not `h-11`: the trigger's own height is a
												 * `data-[size=…]` variant, which outranks a bare `h-*`
												 * from a call site and would leave it 32px beside these
												 * 44px inputs. */}
												<SelectTrigger id={typeId} className="min-h-11 w-full">
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
										</Field>
										{columns.length > 1 && (
											<Button
												type="button"
												variant="destructive"
												className="gap-2 self-end"
												disabled={working}
												onClick={() =>
													setColumns((current) =>
														current.filter(
															(candidate) => candidate.key !== column.key,
														),
													)
												}
											>
												<Icon
													icon={tablerTrash}
													width="16"
													height="16"
													aria-hidden="true"
												/>
												Remove column {index + 1}
											</Button>
										)}
									</FieldSet>
								);
							})}
							<Button
								type="button"
								variant="ghost"
								className="nova-add-slot gap-2 self-start"
								disabled={working}
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
						</FieldSet>

						<FieldError>{failure}</FieldError>
					</FieldGroup>
				</DialogBody>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={working}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="default"
						disabled={
							!ready ||
							working ||
							projectAtOpen.current === undefined ||
							projectId !== projectAtOpen.current
						}
						onClick={async () => {
							const scopedProject = projectAtOpen.current;
							if (
								scopedProject === undefined ||
								projectId !== scopedProject ||
								working
							) {
								setFailure(
									"This Project changed while the dialog was open. Close it and create the table in the Project you are viewing.",
								);
								return;
							}
							const request = operation.current + 1;
							operation.current = request;
							setWorking(true);
							setFailure(null);
							let result: Awaited<ReturnType<typeof createLookupTableAction>>;
							try {
								result = await createLookupTableAction(scopedProject, {
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
							} catch {
								if (mounted.current && operation.current === request) {
									setWorking(false);
									setFailure(
										"Nova could not create this table. Check your connection and try again.",
									);
								}
								return;
							}
							if (!mounted.current || operation.current !== request) return;
							if (!result.success) {
								setWorking(false);
								setFailure(result.message);
								return;
							}
							/* A Project switch or authority-driven unmount invalidates the
							 * completion. The scoped server result remains truthful, but it
							 * must not steer the new Project's builder to the old resource. */
							if (latestProject.current !== scopedProject) {
								setWorking(false);
								setFailure(
									"The table was created in the Project where you opened this dialog. Close this dialog to continue in the Project you are now viewing.",
								);
								return;
							}
							try {
								await onCreated();
							} catch {
								if (mounted.current && operation.current === request) {
									setWorking(false);
									setFailure(
										"The table was created, but this list could not refresh. Close the dialog and reload Project data.",
									);
								}
								return;
							}
							if (!mounted.current || operation.current !== request) return;
							if (latestProject.current !== scopedProject) {
								setWorking(false);
								setFailure(
									"The table was created in the Project where you opened this dialog. Close this dialog to continue in the Project you are now viewing.",
								);
								return;
							}
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
