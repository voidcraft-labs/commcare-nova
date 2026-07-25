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
import { RowInspectorBody } from "./RowInspectorBody";

/**
 * The rail descriptor for whatever the workspace has selected, or `null`.
 *
 * Returns `null` — a stable identity — whenever the workspace is inactive or
 * nothing is selected, so the rail and layout consumers do not re-render as
 * the table's rows change underneath them.
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

	return useMemo(() => {
		if (workspace === null) return null;
		const onClose = () => workspace.select(null);
		if (selection === null || table === undefined) {
			return { inspector: null, onClose };
		}
		if (selection.kind === "row") {
			const row = table.rows.find(
				(candidate) => candidate.id === selection.rowId,
			);
			/* A row that has left the table (deleted here or by a co-member)
			 * carries no inspector. The grid is already showing the table without
			 * it, so an empty panel would be the only thing claiming it exists. */
			if (row === undefined) return { inspector: null, onClose };
			const position = table.rows.indexOf(row) + 1;
			return {
				inspector: {
					kicker: "Row",
					title: `Row ${position.toLocaleString("en-US")}`,
					body: (
						<RowInspectorBody
							row={row}
							columns={table.columns}
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
						column={column}
						table={table}
						workspace={workspace}
					/>
				),
			},
			onClose,
		};
	}, [workspace, selection, table, canEdit]);
}
