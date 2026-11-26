"use client";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	readRowAssignmentsAction,
	updateRowAssignmentsAction,
} from "@/lib/lookup/actions";
import type { NamedAssignee } from "@/lib/lookup/assignmentVocabulary";
import type { LookupRow, LookupTableSnapshot } from "@/lib/lookup/types";
import { sendLookupGesture } from "./lookupGesture";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import { TableReaderReview, useTableReaderReview } from "./TableReaderReview";

const label = (value: NamedAssignee) =>
	[value.name, value.principal.kind, value.appName].filter(Boolean).join(" · ");
const keyOf = (value: NamedAssignee) => JSON.stringify(value.principal);

export function TableWorkerAccess({
	table,
	workspace,
	canWiden,
}: {
	table: LookupTableSnapshot;
	workspace: ProjectDataWorkspace;
	canWiden: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const review = useTableReaderReview(table.projectId, table.id, open);
	const assigned = table.workerAccess === "assigned";
	const save = async () => {
		if (!review.apps || busy) return;
		setBusy(true);
		try {
			const result = await sendLookupGesture(
				updateRowAssignmentsAction,
				table.projectId,
				{
					tableId: table.id,
					expectedTableRevision: table.tableRevision,
					workerAccess: assigned ? "all" : "assigned",
					reviewed: {
						projectRevision: table.projectRevision,
						readerAppIds: review.apps.map((app) => app.appId),
					},
				},
			);
			if (!result.success) {
				setError(result.message);
				if (result.code === "conflict") await workspace.reload();
				return;
			}
			await workspace.reload();
			setOpen(false);
			setError("");
		} catch {
			setError("Nova couldn't save this change. You can try again.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-2">
			<Button
				variant="outline"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
			>
				Who receives this table
			</Button>
			{open && (
				<div className="space-y-2 text-sm">
					<p>
						{assigned
							? "Each row goes only to its assigned workers, groups or places."
							: "Every worker receives every row in this table."}
					</p>
					<TableReaderReview review={review} />
					{!assigned && (
						<p>
							Switching to assignments hides rows until you choose who receives
							them.
						</p>
					)}
					{assigned && canWiden && (
						<p>
							Sharing with everyone makes every row available to every worker.
						</p>
					)}
					{(!assigned || canWiden) && (
						<Button disabled={!review.apps || busy} onClick={save}>
							{assigned ? "Share with every worker" : "Use row assignments"}
						</Button>
					)}
					{error && <p role="alert">{error}</p>}
				</div>
			)}
		</div>
	);
}

export function RowAssignments({
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
	const [open, setOpen] = useState(false);
	if (!canEdit || table.workerAccess !== "assigned") return null;
	return (
		<div className="space-y-2">
			<Button
				variant="outline"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				Who receives this row
			</Button>
			{open && (
				<AssignmentPicker
					key={row.id}
					table={table}
					row={row}
					workspace={workspace}
					close={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

function AssignmentPicker({
	table,
	row,
	workspace,
	close,
}: {
	table: LookupTableSnapshot;
	row: LookupRow;
	workspace: ProjectDataWorkspace;
	close: () => void;
}) {
	const searchId = useId();
	const [query, setQuery] = useState("");
	const [offset, setOffset] = useState(0);
	const [more, setMore] = useState<number | null>(null);
	const [choices, setChoices] = useState<NamedAssignee[]>([]);
	const [selected, setSelected] = useState<NamedAssignee[]>();
	const [baseline, setBaseline] = useState(table.tableRevision);
	const [revision, setRevision] = useState(0);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const stale = baseline !== table.tableRevision;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the refresh trigger; a refresh reads the same row again.
	useEffect(() => {
		let active = true;
		async function load() {
			try {
				const result = await readRowAssignmentsAction(table.projectId, {
					tableId: table.id,
					rowId: row.id,
					search: { query, offset },
				});
				if (!active) return;
				if (!result.success) {
					setMessage(result.message);
					return;
				}
				setChoices(result.value.choices);
				setMore(result.value.nextOffset);
				setSelected((current) => current ?? result.value.selected);
			} catch {
				if (active)
					setMessage(
						"Nova couldn't load the workers for this row. You can refresh the list.",
					);
			}
		}
		void load();
		return () => {
			active = false;
		};
	}, [table.projectId, table.id, row.id, query, offset, revision]);
	const refresh = async () => {
		await workspace.reload();
		setSelected(undefined);
		setBaseline(table.tableRevision);
		setRevision((x) => x + 1);
		setMessage("");
	};
	const save = async () => {
		if (!selected || stale || busy) return;
		setBusy(true);
		try {
			const result = await sendLookupGesture(
				updateRowAssignmentsAction,
				table.projectId,
				{
					tableId: table.id,
					rowId: row.id,
					expectedTableRevision: baseline,
					assignments: selected.map((a) => a.principal),
				},
			);
			if (result.success) {
				await workspace.reload();
				close();
			} else {
				setMessage(result.message);
				if (result.code === "conflict") await workspace.reload();
			}
		} catch {
			setMessage("Nova couldn't save this assignment. You can try again.");
		} finally {
			setBusy(false);
		}
	};
	const keys = new Set(selected?.map(keyOf));
	return (
		<div className="space-y-2 text-sm">
			{selected && (
				<>
					<p>
						{selected.length
							? "This row goes to"
							: "Nobody receives this row yet."}
					</p>
					{selected.map((value) => (
						<div key={keyOf(value)}>
							{label(value)}{" "}
							<Button
								variant="ghost"
								onClick={() =>
									setSelected(selected.filter((x) => keyOf(x) !== keyOf(value)))
								}
							>
								Remove
							</Button>
						</div>
					))}
				</>
			)}
			<Label htmlFor={searchId}>Find a worker, group or place</Label>
			<Input
				id={searchId}
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setOffset(0);
				}}
			/>
			{choices
				.filter((v) => !keys.has(keyOf(v)))
				.map((v) => (
					<Button
						key={keyOf(v)}
						variant="outline"
						disabled={!selected}
						onClick={() => setSelected((s) => [...(s ?? []), v])}
					>
						{label(v)}
					</Button>
				))}
			{offset > 0 && (
				<Button
					variant="ghost"
					onClick={() => setOffset(Math.max(0, offset - 50))}
				>
					Previous choices
				</Button>
			)}
			{more !== null && (
				<Button variant="ghost" onClick={() => setOffset(more)}>
					More choices
				</Button>
			)}
			{stale && (
				<p role="status">
					This table changed. You can load the current assignments before
					editing again.
				</p>
			)}
			{message && <p role="alert">{message}</p>}
			{(stale || message) && (
				<Button variant="outline" onClick={refresh}>
					Refresh assignments
				</Button>
			)}
			<Button disabled={!selected || busy || stale} onClick={save}>
				Save assignments
			</Button>
		</div>
	);
}
