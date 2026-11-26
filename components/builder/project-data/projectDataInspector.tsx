/**
 * The Project data workspace's contribution to the right rail.
 *
 * A third selection source beside a selected form field and the case-list
 * workspace's own selection, resolved the same way and mutually exclusive with
 * both: a Project data URL names no module and no field, so nothing else can
 * be selected while this one is.
 */
"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { managedLookupTableRefusal } from "@/lib/publish/managedData";
import type { ActiveInspectorDescriptor } from "./inspectorTypes";
import { useProjectDataWorkspace } from "./ProjectDataWorkspaceLazyProvider";
import { useManifestEntry, useTableIsEditable } from "./useProjectData";

function InspectorBodyLoading() {
	return (
		<div className="py-4 text-sm text-nova-text-muted" role="status">
			Opening properties
		</div>
	);
}
const ColumnInspectorBody = dynamic(
	() =>
		import("./ColumnInspectorBody").then(
			(module) => module.ColumnInspectorBody,
		),
	{ loading: InspectorBodyLoading },
);
const RowConflictBody = dynamic(
	() => import("./RowConflictBody").then((module) => module.RowConflictBody),
	{ loading: InspectorBodyLoading },
);
const RowInspectorBody = dynamic(
	() => import("./RowInspectorBody").then((module) => module.RowInspectorBody),
	{ loading: InspectorBodyLoading },
);

/**
 * The rail descriptor for whatever the workspace has selected, or `null`.
 *
 * Every body carries a `key` on its selection's identity. The rail renders
 * `{inspector.body}` bare, so without one React preserves a body's local state
 * across a change of selection, and these bodies hold DRAFTS. That is not a
 * cosmetic leak: a dirty row A followed by selecting row B would save A's typed
 * values to B's id, and a half-edited column name would rename the next column
 * you clicked.
 *
 * An unresolved conflict outranks the selection and needs no live table body.
 * That is what lets the last authorized snapshot render even when a co-member
 * deleted the whole table.
 *
 * What each body may change is read once here, from the table's manifest
 * entry and the viewer's two capabilities (`useTableIsEditable`), and handed
 * down: a table CommCare HQ manages offers no edit to anyone, and its bodies
 * say why in the sentence every refused write to it carries.
 */
export function useProjectDataInspector(): {
	readonly inspector: ActiveInspectorDescriptor | null;
	readonly onClose: () => void;
} | null {
	const workspace = useProjectDataWorkspace();
	const selection = workspace?.selection ?? null;
	const table =
		workspace?.table.kind === "data" ? workspace.table.value : undefined;

	const conflict = workspace?.rowConflict ?? null;
	const editedTableId = conflict?.tableId ?? workspace?.tableId;
	const editability = useTableIsEditable(editedTableId);
	const canEdit = editability.edit;
	const managedHq = useManifestEntry(editedTableId)?.hq;
	const readOnlyNotice =
		managedHq?.managedBy === "commcare-hq"
			? managedLookupTableRefusal(
					conflict?.tableName ?? table?.name ?? "",
					managedHq.domain,
				)
			: undefined;

	return useMemo(() => {
		if (workspace === null) return null;
		const onClose = workspace.closeInspector;
		/* Close only hides this surface; the controller retains the conflict.
		 * Discarding is a separate, explicitly labelled choice in the body. */
		if (conflict !== null) {
			return {
				inspector: {
					kicker: conflict.attempted === "delete" ? "Delete row" : "Row",
					title: conflict.tableUnavailable
						? "Local row copy recovered"
						: "Not saved",
					body: (
						<RowConflictBody
							key={`conflict:${conflict.rowId}:${conflict.resolution?.tableRevision ?? "unavailable"}`}
							conflict={conflict}
							workspace={workspace}
							canEdit={canEdit}
						/>
					),
				},
				onClose,
			};
		}
		if (selection === null || table === undefined) {
			return { inspector: null, onClose };
		}
		if (selection.kind === "row") {
			const row = table.rows.find(
				(candidate) => candidate.id === selection.rowId,
			);
			/* A row that has left the table with no conflict pending was removed
			 * deliberately, here or by a co-member, and nothing is waiting on a
			 * decision. An empty panel would be the only thing claiming it exists. */
			if (row === undefined) return { inspector: null, onClose };
			const position = (row.sourceIndex ?? table.rows.indexOf(row)) + 1;
			return {
				inspector: {
					kicker: "Row",
					title: `Row ${position.toLocaleString("en-US")}`,
					body: (
						<RowInspectorBody
							key={row.id}
							row={row}
							table={table}
							workspace={workspace}
							canEdit={canEdit}
							readOnlyNotice={readOnlyNotice}
						/>
					),
				},
				onClose,
			};
		}
		const column = table.columns.find(
			(candidate) => candidate.id === selection.columnId,
		);
		if (column === undefined) return { inspector: null, onClose };
		return {
			inspector: {
				kicker: "Column",
				title: column.label,
				body: (
					<ColumnInspectorBody
						key={column.id}
						column={column}
						table={table}
						workspace={workspace}
						editability={editability}
						readOnlyNotice={readOnlyNotice}
					/>
				),
			},
			onClose,
		};
	}, [
		workspace,
		conflict,
		selection,
		table,
		canEdit,
		editability,
		readOnlyNotice,
	]);
}
