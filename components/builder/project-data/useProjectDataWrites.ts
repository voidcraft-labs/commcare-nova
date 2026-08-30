"use client";

// The column- and table-level writes, with their status and refusal text.
//
// Split from the components so the copy for a refusal lives beside the call
// that can produce it, and so the two inspectors report a result the same way
// rather than each inventing its own phrasing.

import { useCallback, useRef, useState } from "react";
import type { LookupColumnId, LookupRowId } from "@/lib/domain/lookupIds";
import {
	moveLookupColumnAction,
	moveLookupRowAction,
	removeLookupColumnAction,
	retypeLookupColumnAction,
	updateLookupColumnLabelAction,
	updateLookupColumnWireNameAction,
} from "@/lib/lookup/actions";
import type {
	LookupColumn,
	LookupDataType,
	LookupGovernanceFailure,
	LookupRevision,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useProjectId } from "@/lib/session/hooks";
import { formatLookupCount } from "./projectDataModel";

/** The refusal a write reports when the session has no Project yet, a state
 *  the UI already prevents, spelled as a real failure so no caller has to
 *  invent one. */
function unavailable(): LookupGovernanceFailure {
	return {
		success: false,
		code: "not_found",
		message: "Lookup table not found.",
	};
}

function transportFailure(): LookupGovernanceFailure {
	return {
		success: false,
		code: "internal_error",
		message:
			"Nova could not reach this data table. Check your connection and try again.",
	};
}

export interface ColumnWrites {
	readonly status: string | null;
	readonly failure: string | null;
	readonly renameLabel: (
		column: LookupColumn,
		label: string,
		expectedTableRevision: LookupRevision,
	) => Promise<boolean>;
	readonly renameWireName: (
		column: LookupColumn,
		wireName: string,
		expectedTableRevision: LookupRevision,
	) => Promise<boolean>;
	/** Resolves `null` when the change landed, or the refusal that stopped it:
	 * the dialog renders its blocking apps. */
	readonly removeColumn: (
		column: LookupColumn,
		expectedTableRevision: LookupRevision,
	) => Promise<LookupGovernanceFailure | null>;
	readonly retypeColumn: (
		column: LookupColumn,
		dataType: LookupDataType,
		expectedTableRevision: LookupRevision,
	) => Promise<LookupGovernanceFailure | null>;
}

export type LookupMoveDirection = "earlier" | "later";

export interface LookupOrderingWrites {
	readonly moving: boolean;
	readonly status: string | null;
	readonly failure: string | null;
	readonly moveColumn: (
		columnId: LookupColumnId,
		toIndex: number,
		direction: LookupMoveDirection,
		expectedTableRevision: LookupRevision,
	) => Promise<boolean>;
	readonly moveRow: (
		rowId: LookupRowId,
		toIndex: number,
		direction: LookupMoveDirection,
		expectedTableRevision: LookupRevision,
	) => Promise<boolean>;
}

/**
 * Revision-fenced row and column ordering writes for the inspector rail.
 *
 * A conflict is never retried: a peer may have changed the sequence, so the
 * position the person asked for no longer means the same thing. Reload the
 * fresh order, keep the selected UUID open, and ask them to review it.
 */
export function useLookupOrderingWrites(
	table: LookupTableSnapshot,
	reload: () => Promise<void>,
): LookupOrderingWrites {
	const projectId = useProjectId();
	const [moving, setMoving] = useState(false);
	const movingRef = useRef(false);
	const [status, setStatus] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const move = useCallback(
		async (
			kind: "column" | "row",
			id: LookupColumnId | LookupRowId,
			toIndex: number,
			direction: LookupMoveDirection,
			expectedTableRevision: LookupRevision,
		): Promise<boolean> => {
			if (projectId === undefined || movingRef.current) return false;
			movingRef.current = true;
			setMoving(true);
			setStatus(null);
			setFailure(null);
			try {
				const result =
					kind === "column"
						? await moveLookupColumnAction(projectId, {
								tableId: table.id,
								expectedTableRevision,
								columnId: id,
								toIndex,
							})
						: await moveLookupRowAction(projectId, {
								tableId: table.id,
								expectedTableRevision,
								rowId: id,
								toIndex,
							});
				if (!result.success) {
					if (result.code === "conflict") {
						await reload();
						setFailure(
							`This table changed while you were moving the ${kind}. Nova refreshed its order. Review the new position and try again.`,
						);
					} else {
						setFailure(result.message);
					}
					return false;
				}
				setStatus(
					`${kind === "column" ? "Column" : "Row"} moved ${direction}.`,
				);
				await reload();
				return true;
			} catch {
				setFailure(
					`Nova could not move this ${kind}. Check your connection and try again.`,
				);
				return false;
			} finally {
				movingRef.current = false;
				setMoving(false);
			}
		},
		[projectId, reload, table.id],
	);

	const moveColumn = useCallback<LookupOrderingWrites["moveColumn"]>(
		(columnId, toIndex, direction, expectedTableRevision) =>
			move("column", columnId, toIndex, direction, expectedTableRevision),
		[move],
	);
	const moveRow = useCallback<LookupOrderingWrites["moveRow"]>(
		(rowId, toIndex, direction, expectedTableRevision) =>
			move("row", rowId, toIndex, direction, expectedTableRevision),
		[move],
	);

	return { moving, status, failure, moveColumn, moveRow };
}

export function useColumnWrites(
	table: LookupTableSnapshot,
	reload: () => Promise<void>,
): ColumnWrites {
	const projectId = useProjectId();
	const [status, setStatus] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const renameLabel = useCallback(
		async (
			column: LookupColumn,
			label: string,
			expectedTableRevision: LookupRevision,
		): Promise<boolean> => {
			if (projectId === undefined) return false;
			setFailure(null);
			setStatus(null);
			try {
				const result = await updateLookupColumnLabelAction(projectId, {
					tableId: table.id,
					expectedTableRevision,
					columnId: column.id,
					label,
				});
				if (result.success) {
					setStatus("Name saved.");
					await reload();
					return true;
				}
				setStatus(null);
				setFailure(result.message);
				if (result.code === "conflict") await reload();
				return false;
			} catch {
				setFailure(transportFailure().message);
				return false;
			}
		},
		[projectId, table.id, reload],
	);

	const renameWireName = useCallback(
		async (
			column: LookupColumn,
			wireName: string,
			expectedTableRevision: LookupRevision,
		): Promise<boolean> => {
			if (projectId === undefined) return false;
			setFailure(null);
			setStatus(null);
			try {
				const result = await updateLookupColumnWireNameAction(projectId, {
					tableId: table.id,
					expectedTableRevision,
					columnId: column.id,
					wireName,
				});
				if (result.success) {
					setStatus(
						"Export name saved. A CSV you import from now on needs the new heading.",
					);
					await reload();
					return true;
				}
				setStatus(null);
				setFailure(result.message);
				if (result.code === "conflict") await reload();
				return false;
			} catch {
				setFailure(transportFailure().message);
				return false;
			}
		},
		[projectId, table.id, reload],
	);

	const removeColumn = useCallback(
		async (
			column: LookupColumn,
			expectedTableRevision: LookupRevision,
		): Promise<LookupGovernanceFailure | null> => {
			if (projectId === undefined) return unavailable();
			setFailure(null);
			setStatus(null);
			try {
				const result = await removeLookupColumnAction(projectId, {
					tableId: table.id,
					expectedTableRevision,
					columnId: column.id,
				});
				if (!result.success) {
					setFailure(result.message);
					if (result.code === "conflict") await reload();
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
			} catch {
				const failure = transportFailure();
				setFailure(failure.message);
				return failure;
			}
		},
		[projectId, table.id, reload],
	);

	const retypeColumn = useCallback(
		async (
			column: LookupColumn,
			dataType: LookupDataType,
			expectedTableRevision: LookupRevision,
		): Promise<LookupGovernanceFailure | null> => {
			if (projectId === undefined) return unavailable();
			setFailure(null);
			setStatus(null);
			try {
				const result = await retypeLookupColumnAction(projectId, {
					tableId: table.id,
					expectedTableRevision,
					columnId: column.id,
					dataType,
				});
				if (!result.success) {
					setFailure(
						result.code === "incompatible_values"
							? `${result.message} Nothing changed.`
							: result.message,
					);
					if (result.code === "conflict") await reload();
					return result;
				}
				setStatus(`“${column.label}” now holds ${dataType} values.`);
				await reload();
				return null;
			} catch {
				const failure = transportFailure();
				setFailure(failure.message);
				return failure;
			}
		},
		[projectId, table.id, reload],
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
