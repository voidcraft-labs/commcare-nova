/**
 * The Project data workspace's contribution to the right rail.
 *
 * A third selection source beside a selected form field and the case-list
 * workspace's own selection, resolved the same way and mutually exclusive with
 * both — a Project data URL names no module and no field, so nothing else can
 * be selected while this one is.
 */
"use client";

import { useMemo } from "react";
import { useCanEdit } from "@/lib/session/hooks";
import { ColumnInspectorBody } from "./ColumnInspectorBody";
import type { ActiveInspectorDescriptor } from "./inspectorTypes";
import { useProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";
import { RowConflictBody } from "./RowConflictBody";
import { RowInspectorBody } from "./RowInspectorBody";

/**
 * The rail descriptor for whatever the workspace has selected, or `null`.
 *
 * Every body carries a `key` on its selection's identity. The rail renders
 * `{inspector.body}` bare, so without one React preserves a body's local state
 * across a change of selection — and these bodies hold DRAFTS. That is not a
 * cosmetic leak: a dirty row A followed by selecting row B would save A's typed
 * values to B's id, and a half-edited column name would rename the next column
 * you clicked.
 *
 * An unresolved conflict outranks the selection, and it is read from the
 * CONTROLLER rather than the body, so it still renders when the row it is about
 * has left the table — which is exactly what a co-member's delete does.
 */
export function useProjectDataInspector(): {
	readonly inspector: ActiveInspectorDescriptor | null;
	readonly onClose: () => void;
} | null {
	const workspace = useProjectDataWorkspace();
	const canEdit = useCanEdit();
	const selection = workspace?.selection ?? null;
	const table =
		workspace?.table.kind === "data" ? workspace.table.value : undefined;

	const conflict = workspace?.rowConflict ?? null;

	return useMemo(() => {
		if (workspace === null) return null;
		const onClose = () => workspace.select(null);
		/* An unresolved conflict outranks everything, INCLUDING the row having
		 * left the table. It is the only surface holding the author's draft. */
		if (conflict !== null && table !== undefined) {
			return {
				inspector: {
					kicker: conflict.attempted === "delete" ? "Delete row" : "Row",
					title: "Not saved",
					body: (
						<RowConflictBody
							key={`conflict:${conflict.rowId}`}
							conflict={conflict}
							columns={conflict.displayColumns}
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
			const position = table.rows.indexOf(row) + 1;
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
					/>
				),
			},
			onClose,
		};
	}, [workspace, conflict, selection, table, canEdit]);
}
