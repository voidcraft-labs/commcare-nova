/**
 * The one Project data workspace controller, mounted above the builder row so
 * the centre canvas and the right-rail inspector share one instance and one
 * fetch — the same shape `CaseListWorkspaceProvider` uses, and for the same
 * reasons.
 *
 * It renders its host UNCONDITIONALLY. The child element type must stay
 * stable: swapping it would remount the whole builder subtree and sever chat's
 * live run. The controller is simply inert until a Project data URL opens.
 *
 * ## Why the writes live here
 *
 * A row is edited in the rail and displayed in the grid, so the write has to
 * be owned by something both can see. Putting it here also puts the conflict
 * policy in one place: every write carries the snapshot's `tableRevision`, and
 * a refusal is resolved by `rowWriteConflictVerdict` against a FRESH read
 * rather than by whichever component happened to dispatch it.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	LookupColumnId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import {
	createLookupRowAction,
	deleteLookupRowAction,
	getLookupTableAction,
	updateLookupRowAction,
} from "@/lib/lookup/actions";
import type {
	LookupFailure,
	LookupRowValues,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { useLocation } from "@/lib/routing/hooks";
import { useProjectId } from "@/lib/session/hooks";
import {
	type ConflictVerdict,
	columnsEqual,
	conflictDeleteInput,
	conflictOverwriteInput,
	conflictSaveAsNewInput,
	type RowEditBaseline,
	rowWriteConflictVerdict,
} from "./projectDataModel";
import { type ProjectDataRead, useProjectDataTable } from "./useProjectData";

/** What the workspace has selected for inspection, if anything. */
export type ProjectDataSelection =
	| {
			readonly kind: "row";
			readonly rowId: LookupRowId;
			/** The controller minted this row and the grid must clear any search
			 * and reveal its appended page. Ordinary row selection is already
			 * visible and must not disturb the author's query. */
			readonly reveal?: boolean;
	  }
	| { readonly kind: "column"; readonly columnId: LookupColumnId }
	| null;

/**
 * A write that came back refused, held so the author's draft survives and the
 * refusal can be explained beside the thing it is about.
 *
 * `draft` is always retained — in every branch, including the ones where the
 * workspace offers to discard it. A conflict that loses typed work is the
 * failure this whole model exists to prevent.
 */
export interface ProjectDataRowConflict {
	/**
	 * What the author was trying to do, and the resolution surface MUST branch
	 * on it. A save conflict asks "which set of values wins"; a delete conflict
	 * asks "do you still want this row gone". Offering the save question's
	 * "keep mine" on a refused delete would quietly turn a deletion into a save
	 * of values the author never typed.
	 */
	readonly attempted: "save" | "delete";
	readonly rowId: LookupRowId;
	/** For a save, the values the author typed. For a delete, the row as they
	 *  last saw it — what they were asking to remove. */
	readonly draft: LookupRowValues;
	readonly verdict: Extract<
		ConflictVerdict,
		{ kind: "ask" } | { kind: "gone" }
	>;
	/** The row as the server now holds it, for the side-by-side. Absent when
	 *  the row is gone. */
	readonly current: LookupRowValues | undefined;
	/** Columns needed to show every draft/current value, including a column a
	 * peer removed while this edit was open. */
	readonly displayColumns: LookupTableSnapshot["columns"];
	/** The exact fresh generation the resolution buttons describe. A later
	 * peer write must conflict again rather than being silently folded into the
	 * author's earlier decision. */
	readonly resolution: {
		readonly tableRevision: LookupTableSnapshot["tableRevision"];
		readonly rowCount: number;
		readonly columns: LookupTableSnapshot["columns"];
	};
}

export type ProjectDataWriteOutcome =
	| { readonly kind: "saved"; readonly rowId?: LookupRowId }
	| { readonly kind: "conflict"; readonly conflict: ProjectDataRowConflict }
	| { readonly kind: "failed"; readonly failure: LookupFailure };

export interface ProjectDataWorkspace {
	/** False until a Project data URL is open. */
	readonly active: boolean;
	readonly tableId: LookupTableId | undefined;
	readonly table: ProjectDataRead<LookupTableSnapshot>;
	readonly reload: () => Promise<void>;
	readonly selection: ProjectDataSelection;
	readonly select: (selection: ProjectDataSelection) => void;
	/**
	 * An unresolved conflict, held HERE rather than inside the inspector body.
	 *
	 * The body unmounts the moment its row leaves the snapshot, and the most
	 * important conflict — someone deleted the row you were editing — is
	 * precisely the one that makes the row leave. Holding it on the controller
	 * is what lets that case render at all, and what keeps the author's draft on
	 * screen while it does.
	 */
	readonly rowConflict: ProjectDataRowConflict | null;
	readonly setRowConflict: (conflict: ProjectDataRowConflict | null) => void;
	readonly saveRow: (
		rowId: LookupRowId,
		values: LookupRowValues,
		baseline: RowEditBaseline,
	) => Promise<ProjectDataWriteOutcome>;
	readonly addRow: (
		values: LookupRowValues,
	) => Promise<ProjectDataWriteOutcome>;
	readonly deleteRow: (
		rowId: LookupRowId,
		baseline: RowEditBaseline,
	) => Promise<ProjectDataWriteOutcome>;
	readonly overwriteConflictRow: (
		conflict: ProjectDataRowConflict,
	) => Promise<ProjectDataWriteOutcome>;
	readonly saveConflictAsNewRow: (
		conflict: ProjectDataRowConflict,
	) => Promise<ProjectDataWriteOutcome>;
	readonly deleteConflictRow: (
		conflict: ProjectDataRowConflict,
	) => Promise<ProjectDataWriteOutcome>;
}

const ProjectDataWorkspaceContext = createContext<ProjectDataWorkspace | null>(
	null,
);

function unavailableOutcome(): ProjectDataWriteOutcome {
	return {
		kind: "failed",
		failure: {
			success: false,
			code: "not_found",
			message: "Lookup table not found.",
		},
	};
}

export function useProjectDataWorkspace(): ProjectDataWorkspace | null {
	return useContext(ProjectDataWorkspaceContext);
}

export function ProjectDataWorkspaceProvider({
	children,
}: {
	children: ReactNode;
}) {
	const loc = useLocation();
	const tableId = loc.kind === "project-data" ? loc.tableId : undefined;
	return <ActiveHost tableId={tableId}>{children}</ActiveHost>;
}

function ActiveHost({
	tableId,
	children,
}: {
	tableId: LookupTableId | undefined;
	children: ReactNode;
}) {
	const projectId = useProjectId();
	const { state, reload } = useProjectDataTable(tableId);
	const [selection, setSelection] = useState<ProjectDataSelection>(null);
	const [rowConflict, setRowConflict] = useState<ProjectDataRowConflict | null>(
		null,
	);

	/* Selection and any unresolved conflict belong to ONE table. Resetting
	 * during render (rather than in an effect) means the rail never paints one
	 * frame of the previous table's row in the new table's context. */
	const lastTableId = useRef(tableId);
	if (lastTableId.current !== tableId) {
		lastTableId.current = tableId;
		if (selection !== null) setSelection(null);
		if (rowConflict !== null) setRowConflict(null);
	}

	const snapshot = state.kind === "data" ? state.value : undefined;

	const conflictFromSnapshot = useCallback(
		(args: {
			readonly attempted: "save" | "delete";
			readonly rowId: LookupRowId;
			readonly draft: LookupRowValues;
			readonly verdict: ProjectDataRowConflict["verdict"];
			readonly fresh: LookupTableSnapshot;
			readonly draftColumns?: readonly LookupTableSnapshot["columns"][number][];
		}): ProjectDataRowConflict => {
			const current = args.fresh.rows.find((row) => row.id === args.rowId);
			const displayColumns = (args.draftColumns ?? args.fresh.columns).map(
				(column) => ({ ...column }),
			);
			for (const column of args.fresh.columns) {
				if (!displayColumns.some((candidate) => candidate.id === column.id)) {
					displayColumns.push({ ...column });
				}
			}
			return {
				attempted: args.attempted,
				rowId: args.rowId,
				draft: args.draft,
				verdict: args.verdict,
				current: current?.values,
				displayColumns,
				resolution: {
					tableRevision: args.fresh.tableRevision,
					rowCount: args.fresh.rowCount,
					columns: args.fresh.columns.map((column) => ({ ...column })),
				},
			};
		},
		[],
	);

	/**
	 * Re-read the table and decide what a refused write means.
	 *
	 * The fresh read is what makes the verdict trustworthy: the refusal only
	 * says "the revision moved", and the whole point of the trichotomy is to
	 * find out whether it moved under THIS row.
	 */
	const resolveRowConflict = useCallback(
		async (
			rowId: LookupRowId,
			draft: LookupRowValues,
			baseline: RowEditBaseline,
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined) {
				return unavailableOutcome();
			}
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const current = fresh.value.rows.find((row) => row.id === rowId);
			const verdict = rowWriteConflictVerdict({
				baseline: baseline.row.values,
				current,
				columnsChanged: !columnsEqual(baseline.columns, fresh.value.columns),
			});
			if (verdict.kind === "retry") {
				const retried = await updateLookupRowAction(projectId, {
					tableId,
					expectedTableRevision: fresh.value.tableRevision,
					rowId,
					values: draft,
				});
				if (retried.success) {
					await reload();
					return { kind: "saved", rowId };
				}
				/* Only a second REVISION drift is a conflict. A retry refused for any
				 * other reason — a value the column will not take, a byte cap — carries
				 * its own message, and reporting it as "someone else saved this row"
				 * would replace the one sentence that says what to fix. */
				if (retried.code !== "conflict") {
					return { kind: "failed", failure: retried };
				}
				/* One retry only. A second drift means the table is under active
				 * concurrent editing, and silently looping would be indistinguishable
				 * from a hang — the author gets the choice instead. */
				const after = await getLookupTableAction(projectId, tableId);
				if (!after.success) return { kind: "failed", failure: after };
				const afterRow = after.value.rows.find((row) => row.id === rowId);
				return {
					kind: "conflict",
					conflict: conflictFromSnapshot({
						attempted: "save",
						rowId,
						draft,
						verdict:
							afterRow === undefined
								? { kind: "gone" }
								: { kind: "ask", reason: "row-changed" },
						fresh: after.value,
						draftColumns: baseline.columns,
					}),
				};
			}
			/* Deliberately NO reload before returning a conflict. Refreshing here
			 * drops a deleted row from the snapshot, which unmounts the inspector
			 * holding the author's draft — losing exactly the work the conflict
			 * exists to protect, in the one case that matters most. The reload
			 * happens once the author has decided. */
			return {
				kind: "conflict",
				conflict: conflictFromSnapshot({
					attempted: "save",
					rowId,
					draft,
					verdict,
					fresh: fresh.value,
					draftColumns: baseline.columns,
				}),
			};
		},
		[projectId, tableId, reload, conflictFromSnapshot],
	);

	const saveRow = useCallback(
		async (
			rowId: LookupRowId,
			values: LookupRowValues,
			baseline: RowEditBaseline,
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined) {
				return unavailableOutcome();
			}
			const result = await updateLookupRowAction(projectId, {
				tableId,
				expectedTableRevision: baseline.tableRevision,
				rowId,
				values,
			});
			if (result.success) {
				await reload();
				return { kind: "saved", rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			return resolveRowConflict(rowId, values, baseline);
		},
		[projectId, tableId, reload, resolveRowConflict],
	);

	const addRow = useCallback(
		async (values: LookupRowValues): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined || !snapshot) {
				return unavailableOutcome();
			}
			/* Appended, always. An insert at a computed index would have to mean
			 * something after a concurrent change, and "add a row" never means
			 * "add it in a particular place" — ordering is a separate gesture. */
			const result = await createLookupRowAction(projectId, {
				tableId,
				expectedTableRevision: snapshot.tableRevision,
				toIndex: snapshot.rowCount,
				values,
			});
			if (result.success) {
				await reload();
				setSelection({
					kind: "row",
					rowId: result.value.rowId,
					reveal: true,
				});
				return { kind: "saved", rowId: result.value.rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			/* An append stays an append whatever else moved, so a drift retries
			 * once against fresh state rather than asking. */
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const retried = await createLookupRowAction(projectId, {
				tableId,
				expectedTableRevision: fresh.value.tableRevision,
				toIndex: fresh.value.rowCount,
				values,
			});
			if (!retried.success) return { kind: "failed", failure: retried };
			await reload();
			setSelection({
				kind: "row",
				rowId: retried.value.rowId,
				reveal: true,
			});
			return { kind: "saved", rowId: retried.value.rowId };
		},
		[projectId, tableId, snapshot, reload],
	);

	const deleteRow = useCallback(
		async (
			rowId: LookupRowId,
			baseline: RowEditBaseline,
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined) {
				return unavailableOutcome();
			}
			const result = await deleteLookupRowAction(projectId, {
				tableId,
				expectedTableRevision: baseline.tableRevision,
				rowId,
			});
			if (result.success) {
				setSelection(null);
				await reload();
				return { kind: "saved", rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			/* Deleting is only still the same intent while the row holds what the
			 * author saw. If a co-member edited it in between, removing it would
			 * destroy work nobody agreed to lose. */
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const current = fresh.value.rows.find((row) => row.id === rowId);
			const verdict = rowWriteConflictVerdict({
				baseline: baseline.row.values,
				current,
				columnsChanged: !columnsEqual(baseline.columns, fresh.value.columns),
			});
			if (verdict.kind === "gone") {
				/* Already deleted by someone else. The author's intent is satisfied,
				 * so this is a success, not a conflict to resolve. */
				setSelection(null);
				await reload();
				return { kind: "saved", rowId };
			}
			if (verdict.kind === "retry") {
				const retried = await deleteLookupRowAction(projectId, {
					tableId,
					expectedTableRevision: fresh.value.tableRevision,
					rowId,
				});
				if (retried.success) {
					setSelection(null);
					await reload();
					return { kind: "saved", rowId };
				}
				if (retried.code !== "conflict") {
					return { kind: "failed", failure: retried };
				}
				/* One retry only, as on Save. A second drift must become an
				 * explicit decision rather than a moving retry target. */
				const after = await getLookupTableAction(projectId, tableId);
				if (!after.success) return { kind: "failed", failure: after };
				const afterRow = after.value.rows.find((row) => row.id === rowId);
				if (afterRow === undefined) {
					setSelection(null);
					await reload();
					return { kind: "saved", rowId };
				}
				return {
					kind: "conflict",
					conflict: conflictFromSnapshot({
						attempted: "delete",
						rowId,
						draft: baseline.row.values,
						verdict: { kind: "ask", reason: "row-changed" },
						fresh: after.value,
						draftColumns: baseline.columns,
					}),
				};
			}
			return {
				kind: "conflict",
				conflict: conflictFromSnapshot({
					attempted: "delete",
					rowId,
					/* What the author asked to remove, as they last saw it — NOT any
					 * unsaved edits they had typed. A delete conflict asks whether the
					 * row should still go, and answering it with the author's draft
					 * would present values nobody has saved as the thing at stake. */
					draft: baseline.row.values,
					verdict,
					fresh: fresh.value,
					draftColumns: baseline.columns,
				}),
			};
		},
		[projectId, tableId, reload, conflictFromSnapshot],
	);

	/**
	 * Apply the author's explicit conflict decision against exactly the fresh
	 * generation they reviewed. These are intentionally separate from normal
	 * Save/Delete: re-entering those paths would reuse the stale edit-session
	 * baseline and loop back to the same conflict forever.
	 */
	const overwriteConflictRow = useCallback(
		async (
			conflict: ProjectDataRowConflict,
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined) {
				return unavailableOutcome();
			}
			const result = await updateLookupRowAction(
				projectId,
				conflictOverwriteInput({
					tableId,
					rowId: conflict.rowId,
					draft: conflict.draft,
					resolution: conflict.resolution,
				}),
			);
			if (result.success) {
				setRowConflict(null);
				setSelection({ kind: "row", rowId: conflict.rowId });
				await reload();
				return { kind: "saved", rowId: conflict.rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const next = conflictFromSnapshot({
				attempted: "save",
				rowId: conflict.rowId,
				draft: conflict.draft,
				verdict: fresh.value.rows.some((row) => row.id === conflict.rowId)
					? { kind: "ask", reason: "row-changed" }
					: { kind: "gone" },
				fresh: fresh.value,
				draftColumns: conflict.displayColumns,
			});
			setRowConflict(next);
			return { kind: "conflict", conflict: next };
		},
		[projectId, tableId, reload, conflictFromSnapshot],
	);

	const saveConflictAsNewRow = useCallback(
		async (
			conflict: ProjectDataRowConflict,
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined) {
				return unavailableOutcome();
			}
			const result = await createLookupRowAction(
				projectId,
				conflictSaveAsNewInput({
					tableId,
					draft: conflict.draft,
					resolution: conflict.resolution,
				}),
			);
			if (result.success) {
				setRowConflict(null);
				await reload();
				setSelection({
					kind: "row",
					rowId: result.value.rowId,
					reveal: true,
				});
				return { kind: "saved", rowId: result.value.rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const next = conflictFromSnapshot({
				attempted: "save",
				rowId: conflict.rowId,
				draft: conflict.draft,
				verdict: { kind: "gone" },
				fresh: fresh.value,
				draftColumns: conflict.displayColumns,
			});
			setRowConflict(next);
			return { kind: "conflict", conflict: next };
		},
		[projectId, tableId, reload, conflictFromSnapshot],
	);

	const deleteConflictRow = useCallback(
		async (
			conflict: ProjectDataRowConflict,
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined) {
				return unavailableOutcome();
			}
			const result = await deleteLookupRowAction(
				projectId,
				conflictDeleteInput({
					tableId,
					rowId: conflict.rowId,
					resolution: conflict.resolution,
				}),
			);
			if (result.success || result.code === "not_found") {
				setRowConflict(null);
				setSelection(null);
				await reload();
				return { kind: "saved", rowId: conflict.rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const current = fresh.value.rows.find((row) => row.id === conflict.rowId);
			if (current === undefined) {
				setRowConflict(null);
				setSelection(null);
				await reload();
				return { kind: "saved", rowId: conflict.rowId };
			}
			const next = conflictFromSnapshot({
				attempted: "delete",
				rowId: conflict.rowId,
				draft: conflict.draft,
				verdict: { kind: "ask", reason: "row-changed" },
				fresh: fresh.value,
				draftColumns: conflict.displayColumns,
			});
			setRowConflict(next);
			return { kind: "conflict", conflict: next };
		},
		[projectId, tableId, reload, conflictFromSnapshot],
	);

	const value = useMemo<ProjectDataWorkspace>(
		() => ({
			active: tableId !== undefined,
			tableId,
			table: state,
			reload,
			selection,
			select: setSelection,
			rowConflict,
			setRowConflict,
			saveRow,
			addRow,
			deleteRow,
			overwriteConflictRow,
			saveConflictAsNewRow,
			deleteConflictRow,
		}),
		[
			tableId,
			state,
			reload,
			selection,
			rowConflict,
			saveRow,
			addRow,
			deleteRow,
			overwriteConflictRow,
			saveConflictAsNewRow,
			deleteConflictRow,
		],
	);

	return (
		<ProjectDataWorkspaceContext.Provider value={value}>
			{children}
		</ProjectDataWorkspaceContext.Provider>
	);
}
