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
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
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
	rowWriteConflictVerdict,
} from "./projectDataModel";
import { type ProjectDataRead, useProjectDataTable } from "./useProjectData";

/** What the workspace has selected for inspection, if anything. */
export type ProjectDataSelection =
	| { readonly kind: "row"; readonly rowId: string }
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
	readonly rowId: string;
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
}

export type ProjectDataWriteOutcome =
	| { readonly kind: "saved" }
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
		rowId: string,
		values: LookupRowValues,
	) => Promise<ProjectDataWriteOutcome>;
	readonly addRow: (
		values: LookupRowValues,
	) => Promise<ProjectDataWriteOutcome>;
	readonly deleteRow: (rowId: string) => Promise<ProjectDataWriteOutcome>;
}

const ProjectDataWorkspaceContext = createContext<ProjectDataWorkspace | null>(
	null,
);

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

	/**
	 * Re-read the table and decide what a refused write means.
	 *
	 * The fresh read is what makes the verdict trustworthy: the refusal only
	 * says "the revision moved", and the whole point of the trichotomy is to
	 * find out whether it moved under THIS row.
	 */
	const resolveRowConflict = useCallback(
		async (
			rowId: string,
			draft: LookupRowValues,
			baseline: LookupRowValues,
			baselineColumns: LookupTableSnapshot["columns"],
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined) {
				return {
					kind: "failed",
					failure: {
						success: false,
						code: "not_found",
						message: "Lookup table not found.",
					},
				};
			}
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const current = fresh.value.rows.find((row) => row.id === rowId);
			const verdict = rowWriteConflictVerdict({
				baseline,
				current,
				columnsChanged: !columnsEqual(baselineColumns, fresh.value.columns),
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
					return { kind: "saved" };
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
				const afterRow = after.success
					? after.value.rows.find((row) => row.id === rowId)
					: undefined;
				return {
					kind: "conflict",
					conflict: {
						attempted: "save",
						rowId,
						draft,
						verdict: { kind: "ask", reason: "row-changed" },
						current: afterRow?.values,
					},
				};
			}
			/* Deliberately NO reload before returning a conflict. Refreshing here
			 * drops a deleted row from the snapshot, which unmounts the inspector
			 * holding the author's draft — losing exactly the work the conflict
			 * exists to protect, in the one case that matters most. The reload
			 * happens once the author has decided. */
			return {
				kind: "conflict",
				conflict: {
					attempted: "save",
					rowId,
					draft,
					verdict,
					current: current?.values,
				},
			};
		},
		[projectId, tableId, reload],
	);

	const saveRow = useCallback(
		async (
			rowId: string,
			values: LookupRowValues,
		): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined || !snapshot) {
				return {
					kind: "failed",
					failure: {
						success: false,
						code: "not_found",
						message: "Lookup table not found.",
					},
				};
			}
			const baselineRow = snapshot.rows.find((row) => row.id === rowId);
			const result = await updateLookupRowAction(projectId, {
				tableId,
				expectedTableRevision: snapshot.tableRevision,
				rowId,
				values,
			});
			if (result.success) {
				await reload();
				return { kind: "saved" };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			return resolveRowConflict(
				rowId,
				values,
				baselineRow?.values ?? ({} as LookupRowValues),
				snapshot.columns,
			);
		},
		[projectId, tableId, snapshot, reload, resolveRowConflict],
	);

	const addRow = useCallback(
		async (values: LookupRowValues): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined || !snapshot) {
				return {
					kind: "failed",
					failure: {
						success: false,
						code: "not_found",
						message: "Lookup table not found.",
					},
				};
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
				return { kind: "saved" };
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
			await reload();
			return retried.success
				? { kind: "saved" }
				: { kind: "failed", failure: retried };
		},
		[projectId, tableId, snapshot, reload],
	);

	const deleteRow = useCallback(
		async (rowId: string): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined || !snapshot) {
				return {
					kind: "failed",
					failure: {
						success: false,
						code: "not_found",
						message: "Lookup table not found.",
					},
				};
			}
			const baselineRow = snapshot.rows.find((row) => row.id === rowId);
			const result = await deleteLookupRowAction(projectId, {
				tableId,
				expectedTableRevision: snapshot.tableRevision,
				rowId,
			});
			if (result.success) {
				setSelection(null);
				await reload();
				return { kind: "saved" };
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
				baseline: baselineRow?.values ?? ({} as LookupRowValues),
				current,
				columnsChanged: !columnsEqual(snapshot.columns, fresh.value.columns),
			});
			if (verdict.kind === "gone") {
				/* Already deleted by someone else. The author's intent is satisfied,
				 * so this is a success, not a conflict to resolve. */
				setSelection(null);
				await reload();
				return { kind: "saved" };
			}
			if (verdict.kind === "retry") {
				const retried = await deleteLookupRowAction(projectId, {
					tableId,
					expectedTableRevision: fresh.value.tableRevision,
					rowId,
				});
				if (retried.success) setSelection(null);
				await reload();
				return retried.success
					? { kind: "saved" }
					: { kind: "failed", failure: retried };
			}
			await reload();
			return {
				kind: "conflict",
				conflict: {
					attempted: "delete",
					rowId,
					/* What the author asked to remove, as they last saw it — NOT any
					 * unsaved edits they had typed. A delete conflict asks whether the
					 * row should still go, and answering it with the author's draft
					 * would present values nobody has saved as the thing at stake. */
					draft: baselineRow?.values ?? ({} as LookupRowValues),
					verdict,
					current: current?.values,
				},
			};
		},
		[projectId, tableId, snapshot, reload],
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
		],
	);

	return (
		<ProjectDataWorkspaceContext.Provider value={value}>
			{children}
		</ProjectDataWorkspaceContext.Provider>
	);
}
