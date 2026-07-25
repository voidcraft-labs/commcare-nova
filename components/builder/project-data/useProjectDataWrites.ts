"use client";

// The column- and table-level writes, with their status and refusal text.
//
// Split from the components so the copy for a refusal lives beside the call
// that can produce it, and so the two inspectors report a result the same way
// rather than each inventing its own phrasing.

import { useCallback, useState } from "react";
import {
	removeLookupColumnAction,
	retypeLookupColumnAction,
	updateLookupColumnLabelAction,
	updateLookupColumnWireNameAction,
} from "@/lib/lookup/actions";
import type {
	LookupColumn,
	LookupDataType,
	LookupGovernanceFailure,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useProjectId } from "@/lib/session/hooks";
import { formatLookupCount } from "./projectDataModel";

/** The refusal a write reports when the session has no Project yet — a state
 *  the UI already prevents, spelled as a real failure so no caller has to
 *  invent one. */
function unavailable(): LookupGovernanceFailure {
	return {
		success: false,
		code: "not_found",
		message: "Lookup table not found.",
	};
}

export interface ColumnWrites {
	readonly status: string | null;
	readonly failure: string | null;
	readonly renameLabel: (column: LookupColumn, label: string) => Promise<void>;
	readonly renameWireName: (
		column: LookupColumn,
		wireName: string,
	) => Promise<void>;
	/** Resolves `null` when the change landed, or the refusal that stopped it
	 *  — the dialog renders its blocking apps. */
	readonly removeColumn: (
		column: LookupColumn,
	) => Promise<LookupGovernanceFailure | null>;
	readonly retypeColumn: (
		column: LookupColumn,
		dataType: LookupDataType,
	) => Promise<LookupGovernanceFailure | null>;
}

export function useColumnWrites(
	table: LookupTableSnapshot,
	reload: () => Promise<void>,
): ColumnWrites {
	const projectId = useProjectId();
	const [status, setStatus] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const renameLabel = useCallback(
		async (column: LookupColumn, label: string) => {
			if (projectId === undefined) return;
			setFailure(null);
			const result = await updateLookupColumnLabelAction(projectId, {
				tableId: table.id,
				expectedTableRevision: table.tableRevision,
				columnId: column.id,
				label,
			});
			if (result.success) {
				setStatus("Name saved.");
				await reload();
			} else {
				setStatus(null);
				setFailure(result.message);
			}
		},
		[projectId, table.id, table.tableRevision, reload],
	);

	const renameWireName = useCallback(
		async (column: LookupColumn, wireName: string) => {
			if (projectId === undefined) return;
			setFailure(null);
			const result = await updateLookupColumnWireNameAction(projectId, {
				tableId: table.id,
				expectedTableRevision: table.tableRevision,
				columnId: column.id,
				wireName,
			});
			if (result.success) {
				setStatus(
					"Export name saved. A CSV you import from now on needs the new heading.",
				);
				await reload();
			} else {
				setStatus(null);
				setFailure(result.message);
			}
		},
		[projectId, table.id, table.tableRevision, reload],
	);

	const removeColumn = useCallback(
		async (column: LookupColumn): Promise<LookupGovernanceFailure | null> => {
			if (projectId === undefined) return unavailable();
			setFailure(null);
			const result = await removeLookupColumnAction(projectId, {
				tableId: table.id,
				expectedTableRevision: table.tableRevision,
				columnId: column.id,
			});
			if (!result.success) {
				setFailure(result.message);
				return result;
			}
			const removed = result.value;
			setStatus(
				removed.kind === "remove-column"
					? `Removed “${column.label}”, clearing ${formatLookupCount(removed.affectedCells, "value")}.`
					: "Column removed.",
			);
			await reload();
			return null;
		},
		[projectId, table.id, table.tableRevision, reload],
	);

	const retypeColumn = useCallback(
		async (
			column: LookupColumn,
			dataType: LookupDataType,
		): Promise<LookupGovernanceFailure | null> => {
			if (projectId === undefined) return unavailable();
			setFailure(null);
			const result = await retypeLookupColumnAction(projectId, {
				tableId: table.id,
				expectedTableRevision: table.tableRevision,
				columnId: column.id,
				dataType,
			});
			if (!result.success) {
				setFailure(
					result.code === "incompatible_values"
						? `${result.message} Nothing changed.`
						: result.message,
				);
				return result;
			}
			setStatus(`“${column.label}” now holds ${dataType} values.`);
			await reload();
			return null;
		},
		[projectId, table.id, table.tableRevision, reload],
	);

	return {
		status,
		failure,
		renameLabel,
		renameWireName,
		removeColumn,
		retypeColumn,
	};
}
