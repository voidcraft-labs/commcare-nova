/**
 * The one Project data workspace controller, mounted above the builder row so
 * the centre canvas and right-rail inspector share one read and one write
 * policy.
 *
 * Drafts and conflicts live here, not in inspector bodies. A rail body is
 * intentionally transient: Close, Escape, another selection, a route change,
 * and realtime deletion can all unmount it. None of those gestures is consent
 * to discard typed data, so the controller keys drafts by Project/table/row
 * and keeps them until Save or an explicitly labelled discard decision.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
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
import { usePreviewing, useProjectId } from "@/lib/session/hooks";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";
import {
	type ConflictVerdict,
	columnsEqual,
	conflictDeleteInput,
	conflictOverwriteInput,
	conflictSaveAsNewInput,
	type RemovedConflictCell,
	type RowDraft,
	type RowDraftCell,
	type RowEditBaseline,
	reconcileConflictDraft,
	reconcileRowDraft,
	rowWriteConflictVerdict,
} from "./projectDataModel";
import { type ProjectDataRead, useProjectDataTable } from "./useProjectData";

export type ProjectDataSelection =
	| {
			readonly kind: "row";
			readonly rowId: LookupRowId;
			readonly reveal?: boolean;
	  }
	| { readonly kind: "column"; readonly columnId: LookupColumnId }
	| null;

export interface ProjectDataRowEditSession {
	readonly projectId: string;
	readonly tableId: LookupTableId;
	readonly tableName: string;
	readonly rowId: LookupRowId;
	readonly draft: RowDraft;
	readonly baseline: RowEditBaseline;
}

/**
 * A refused row gesture plus the exact draft that must survive it.
 *
 * Save conflicts carry an editable projection against `resolution.columns`,
 * never the stale schema. Removed-column values stay separately visible and
 * require acknowledgement before the remaining values can be written.
 * `tableUnavailable` has no resolution target at all; it is the recovery
 * surface rendered from the last authorized snapshot after the table vanishes.
 */
export interface ProjectDataRowConflict {
	readonly projectId: string;
	readonly tableId: LookupTableId;
	readonly tableName: string;
	readonly attempted: "save" | "delete";
	readonly rowId: LookupRowId;
	readonly draft: LookupRowValues;
	readonly editableDraft: RowDraft;
	readonly removed: readonly RemovedConflictCell[];
	readonly verdict: Extract<
		ConflictVerdict,
		{ kind: "ask" } | { kind: "gone" }
	>;
	readonly current: LookupRowValues | undefined;
	readonly displayColumns: LookupTableSnapshot["columns"];
	readonly tableUnavailable: boolean;
	readonly resolution: {
		readonly tableRevision: LookupTableSnapshot["tableRevision"];
		readonly rowCount: number;
		readonly columns: LookupTableSnapshot["columns"];
	} | null;
}

export type ProjectDataWriteOutcome =
	| { readonly kind: "saved"; readonly rowId?: LookupRowId }
	| { readonly kind: "conflict"; readonly conflict: ProjectDataRowConflict }
	| { readonly kind: "failed"; readonly failure: LookupFailure };

export interface ProjectDataWorkspace {
	readonly active: boolean;
	readonly tableId: LookupTableId | undefined;
	readonly table: ProjectDataRead<LookupTableSnapshot>;
	readonly reload: () => Promise<void>;
	readonly selection: ProjectDataSelection;
	readonly select: (selection: ProjectDataSelection) => void;
	/** Close only the rail. Draft/conflict state remains recoverable. */
	readonly closeInspector: () => void;
	readonly rowEditFor: (
		rowId: LookupRowId,
	) => ProjectDataRowEditSession | undefined;
	readonly retainRowEdit: (session: ProjectDataRowEditSession) => void;
	readonly discardRowEdit: (rowId: LookupRowId) => void;
	readonly rowConflict: ProjectDataRowConflict | null;
	readonly setRowConflict: (conflict: ProjectDataRowConflict) => void;
	readonly updateRowConflictDraft: (
		conflict: ProjectDataRowConflict,
		columnId: LookupColumnId,
		cell: RowDraftCell,
	) => void;
	/** An explicit “use saved / keep row / discard draft” decision. */
	readonly discardRowConflict: (conflict: ProjectDataRowConflict) => void;
	readonly pendingDraftCount: number;
	readonly openPendingDraft: () => void;
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
		values: LookupRowValues,
	) => Promise<ProjectDataWriteOutcome>;
	readonly saveConflictAsNewRow: (
		conflict: ProjectDataRowConflict,
		values: LookupRowValues,
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

function rowStateKey(
	projectId: string,
	tableId: LookupTableId,
	rowId: LookupRowId,
): string {
	return `${projectId}\u0000${tableId}\u0000${rowId}`;
}

function withoutKey<Value>(
	current: ReadonlyMap<string, Value>,
	key: string,
): ReadonlyMap<string, Value> {
	if (!current.has(key)) return current;
	const next = new Map(current);
	next.delete(key);
	return next;
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
	const previewing = usePreviewing();
	const { state, reload } = useProjectDataTable(tableId);
	const [scopedSelection, setScopedSelection] = useState<{
		readonly projectId: string;
		readonly tableId: LookupTableId;
		readonly value: Exclude<ProjectDataSelection, null>;
	} | null>(null);
	const [rowEdits, setRowEdits] = useState<
		ReadonlyMap<string, ProjectDataRowEditSession>
	>(() => new Map());
	const [rowConflicts, setRowConflicts] = useState<
		ReadonlyMap<string, ProjectDataRowConflict>
	>(() => new Map());

	const selection =
		scopedSelection !== null &&
		scopedSelection.projectId === projectId &&
		scopedSelection.tableId === tableId
			? scopedSelection.value
			: null;
	const snapshot = state.kind === "data" ? state.value : undefined;

	const select = useCallback(
		(next: ProjectDataSelection) => {
			if (next === null) {
				setScopedSelection(null);
				return;
			}
			if (projectId === undefined || tableId === undefined) return;
			setScopedSelection({ projectId, tableId, value: next });
		},
		[projectId, tableId],
	);

	const closeInspector = useCallback(() => {
		const root = document.querySelector<HTMLElement>(
			"[data-project-data-table-screen]",
		);
		const origin =
			root?.querySelector<HTMLElement>("[data-inspector-return-focus]") ??
			root?.querySelector<HTMLElement>("[data-project-data-focus-fallback]") ??
			null;
		if (origin !== null) origin.setAttribute("data-inspector-return-focus", "");
		setScopedSelection(null);
		if (origin === null) return;
		requestAnimationFrame(() => {
			/* Base UI owns final focus while the narrow drawer is modal and the
			 * canvas is inert. Its finalFocus callback consumes this marker. */
			if (
				origin.closest(
					'[data-builder-layout="narrow"], [data-builder-layout="handset"]',
				) !== null
			) {
				return;
			}
			origin.focus({ preventScroll: true });
			origin.removeAttribute("data-inspector-return-focus");
		});
	}, []);

	useKeyboardShortcuts(
		"project-data-workspace",
		useMemo(
			() =>
				tableId !== undefined && selection !== null && !previewing
					? [{ key: "Escape", handler: closeInspector }]
					: [],
			[tableId, selection, previewing, closeInspector],
		),
	);

	const currentRowKey = useCallback(
		(rowId: LookupRowId) =>
			projectId === undefined || tableId === undefined
				? undefined
				: rowStateKey(projectId, tableId, rowId),
		[projectId, tableId],
	);

	const rowEditFor = useCallback(
		(rowId: LookupRowId) => {
			const key = currentRowKey(rowId);
			return key === undefined ? undefined : rowEdits.get(key);
		},
		[currentRowKey, rowEdits],
	);

	const retainRowEdit = useCallback((session: ProjectDataRowEditSession) => {
		const key = rowStateKey(session.projectId, session.tableId, session.rowId);
		setRowEdits((current) => {
			const next = new Map(current);
			next.set(key, session);
			return next;
		});
	}, []);

	const discardRowEdit = useCallback(
		(rowId: LookupRowId) => {
			const key = currentRowKey(rowId);
			if (key === undefined) return;
			setRowEdits((current) => withoutKey(current, key));
			setRowConflicts((current) => withoutKey(current, key));
		},
		[currentRowKey],
	);

	const conflictFromSnapshot = useCallback(
		(args: {
			readonly attempted: "save" | "delete";
			readonly rowId: LookupRowId;
			readonly draft: LookupRowValues;
			readonly verdict: ProjectDataRowConflict["verdict"];
			readonly fresh: LookupTableSnapshot;
			readonly draftColumns?: readonly LookupTableSnapshot["columns"][number][];
		}): ProjectDataRowConflict => {
			const draftColumns = (args.draftColumns ?? args.fresh.columns).map(
				(column) => ({ ...column }),
			);
			const current = args.fresh.rows.find((row) => row.id === args.rowId);
			const displayColumns = draftColumns.map((column) => ({ ...column }));
			for (const column of args.fresh.columns) {
				if (!displayColumns.some((candidate) => candidate.id === column.id)) {
					displayColumns.push({ ...column });
				}
			}
			const reconciled = reconcileConflictDraft(
				args.draft,
				draftColumns,
				args.fresh.columns,
			);
			return {
				projectId: args.fresh.projectId,
				tableId: args.fresh.id,
				tableName: args.fresh.name,
				attempted: args.attempted,
				rowId: args.rowId,
				draft: args.draft,
				editableDraft: reconciled.draft,
				removed: reconciled.removed,
				verdict: args.verdict,
				current: current?.values,
				displayColumns,
				tableUnavailable: false,
				resolution: {
					tableRevision: args.fresh.tableRevision,
					rowCount: args.fresh.rowCount,
					columns: args.fresh.columns.map((column) => ({ ...column })),
				},
			};
		},
		[],
	);

	const setRowConflict = useCallback((conflict: ProjectDataRowConflict) => {
		const key = rowStateKey(
			conflict.projectId,
			conflict.tableId,
			conflict.rowId,
		);
		setRowConflicts((current) => {
			const next = new Map(current);
			next.set(key, conflict);
			return next;
		});
		setScopedSelection({
			projectId: conflict.projectId,
			tableId: conflict.tableId,
			value: { kind: "row", rowId: conflict.rowId },
		});
	}, []);

	const updateRowConflictDraft = useCallback(
		(
			conflict: ProjectDataRowConflict,
			columnId: LookupColumnId,
			cell: RowDraftCell,
		) => {
			const key = rowStateKey(
				conflict.projectId,
				conflict.tableId,
				conflict.rowId,
			);
			setRowConflicts((current) => {
				const latest = current.get(key);
				if (latest === undefined) return current;
				const next = new Map(current);
				next.set(key, {
					...latest,
					editableDraft: { ...latest.editableDraft, [columnId]: cell },
				});
				return next;
			});
		},
		[],
	);

	const discardRowConflict = useCallback((conflict: ProjectDataRowConflict) => {
		const key = rowStateKey(
			conflict.projectId,
			conflict.tableId,
			conflict.rowId,
		);
		setRowConflicts((current) => withoutKey(current, key));
		setRowEdits((current) => withoutKey(current, key));
		if (conflict.tableUnavailable || conflict.verdict.kind === "gone") {
			setScopedSelection(null);
		}
	}, []);

	const rowConflict =
		selection?.kind === "row" &&
		projectId !== undefined &&
		tableId !== undefined
			? (rowConflicts.get(rowStateKey(projectId, tableId, selection.rowId)) ??
				null)
			: null;

	/* Once the authoritative table read says not_found, turn every retained
	 * draft for that table into a snapshot-backed recovery conflict. The raw
	 * draft may not even parse yet, so it comes from the edit session rather
	 * than being reconstructed from stored baseline values. */
	useEffect(() => {
		if (
			projectId === undefined ||
			tableId === undefined ||
			state.kind !== "failed" ||
			state.failure.code !== "not_found"
		) {
			return;
		}
		const sessions = [...rowEdits.values()].filter(
			(session) =>
				session.projectId === projectId && session.tableId === tableId,
		);
		if (sessions.length === 0) return;
		setRowConflicts((current) => {
			let changed = false;
			const next = new Map(current);
			for (const session of sessions) {
				const key = rowStateKey(projectId, tableId, session.rowId);
				const existing = next.get(key);
				if (existing?.tableUnavailable === true) continue;
				const displayColumns = session.baseline.columns.map((column) => ({
					...column,
				}));
				for (const column of existing?.resolution?.columns ?? []) {
					if (!displayColumns.some((candidate) => candidate.id === column.id)) {
						displayColumns.push({ ...column });
					}
				}
				next.set(key, {
					projectId,
					tableId,
					tableName: session.tableName,
					attempted: "save",
					rowId: session.rowId,
					draft: existing?.draft ?? session.baseline.row.values,
					/* Preserve any reconciliation edits already made in a row-level
					 * conflict before the table itself disappeared. */
					editableDraft: {
						...session.draft,
						...existing?.editableDraft,
					},
					removed: [],
					verdict: { kind: "gone" },
					current: undefined,
					displayColumns,
					tableUnavailable: true,
					resolution: null,
				});
				changed = true;
			}
			return changed ? next : current;
		});
	}, [projectId, tableId, state, rowEdits]);

	/* A peer can remove only the row while the table remains. This is the same
	 * recovery decision as Save-after-delete, except the raw draft may not parse
	 * yet because Save was never pressed. Reconcile cells directly onto the
	 * fresh schema and keep Save-as-new available. */
	useEffect(() => {
		if (
			projectId === undefined ||
			tableId === undefined ||
			state.kind !== "data"
		) {
			return;
		}
		const missing = [...rowEdits.values()].filter(
			(session) =>
				session.projectId === projectId &&
				session.tableId === tableId &&
				!state.value.rows.some((row) => row.id === session.rowId),
		);
		if (missing.length === 0) return;
		setRowConflicts((current) => {
			let changed = false;
			const next = new Map(current);
			for (const session of missing) {
				const key = rowStateKey(projectId, tableId, session.rowId);
				if (next.has(key)) continue;
				const reconciled = reconcileRowDraft(
					session.draft,
					session.baseline.columns,
					state.value.columns,
				);
				next.set(key, {
					projectId,
					tableId,
					tableName: state.value.name,
					attempted: "save",
					rowId: session.rowId,
					draft: session.baseline.row.values,
					editableDraft: reconciled.draft,
					removed: reconciled.removed,
					verdict: { kind: "gone" },
					current: undefined,
					displayColumns: session.baseline.columns.map((column) => ({
						...column,
					})),
					tableUnavailable: false,
					resolution: {
						tableRevision: state.value.tableRevision,
						rowCount: state.value.rowCount,
						columns: state.value.columns.map((column) => ({ ...column })),
					},
				});
				changed = true;
			}
			return changed ? next : current;
		});
	}, [projectId, tableId, state, rowEdits]);

	const pendingRowIds = useMemo(() => {
		if (projectId === undefined || tableId === undefined) return [];
		const ids = new Set<LookupRowId>();
		for (const session of rowEdits.values()) {
			if (session.projectId === projectId && session.tableId === tableId) {
				ids.add(session.rowId);
			}
		}
		for (const conflict of rowConflicts.values()) {
			if (conflict.projectId === projectId && conflict.tableId === tableId) {
				ids.add(conflict.rowId);
			}
		}
		return [...ids];
	}, [projectId, tableId, rowEdits, rowConflicts]);

	const openPendingDraft = useCallback(() => {
		const rowId = pendingRowIds[0];
		if (
			rowId === undefined ||
			projectId === undefined ||
			tableId === undefined
		) {
			return;
		}
		setScopedSelection({
			projectId,
			tableId,
			value: { kind: "row", rowId },
		});
	}, [pendingRowIds, projectId, tableId]);

	const clearSavedRowState = useCallback(
		(
			scopeProjectId: string,
			scopeTableId: LookupTableId,
			rowId: LookupRowId,
		) => {
			const key = rowStateKey(scopeProjectId, scopeTableId, rowId);
			setRowEdits((current) => withoutKey(current, key));
			setRowConflicts((current) => withoutKey(current, key));
		},
		[],
	);

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
					clearSavedRowState(projectId, tableId, rowId);
					await reload();
					return { kind: "saved", rowId };
				}
				if (retried.code !== "conflict") {
					return { kind: "failed", failure: retried };
				}
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
		[projectId, tableId, reload, clearSavedRowState, conflictFromSnapshot],
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
				clearSavedRowState(projectId, tableId, rowId);
				await reload();
				return { kind: "saved", rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			return resolveRowConflict(rowId, values, baseline);
		},
		[projectId, tableId, reload, resolveRowConflict, clearSavedRowState],
	);

	const addRow = useCallback(
		async (values: LookupRowValues): Promise<ProjectDataWriteOutcome> => {
			if (projectId === undefined || tableId === undefined || !snapshot) {
				return unavailableOutcome();
			}
			const result = await createLookupRowAction(projectId, {
				tableId,
				expectedTableRevision: snapshot.tableRevision,
				toIndex: snapshot.rowCount,
				values,
			});
			let rowId: LookupRowId;
			if (result.success) {
				rowId = result.value.rowId;
			} else {
				if (result.code !== "conflict") {
					return { kind: "failed", failure: result };
				}
				const fresh = await getLookupTableAction(projectId, tableId);
				if (!fresh.success) return { kind: "failed", failure: fresh };
				const retried = await createLookupRowAction(projectId, {
					tableId,
					expectedTableRevision: fresh.value.tableRevision,
					toIndex: fresh.value.rowCount,
					values,
				});
				if (!retried.success) return { kind: "failed", failure: retried };
				rowId = retried.value.rowId;
			}
			await reload();
			setScopedSelection({
				projectId,
				tableId,
				value: { kind: "row", rowId, reveal: true },
			});
			return { kind: "saved", rowId };
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
				clearSavedRowState(projectId, tableId, rowId);
				setScopedSelection(null);
				await reload();
				return { kind: "saved", rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			const fresh = await getLookupTableAction(projectId, tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const current = fresh.value.rows.find((row) => row.id === rowId);
			const verdict = rowWriteConflictVerdict({
				baseline: baseline.row.values,
				current,
				columnsChanged: !columnsEqual(baseline.columns, fresh.value.columns),
			});
			if (verdict.kind === "gone") {
				clearSavedRowState(projectId, tableId, rowId);
				setScopedSelection(null);
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
					clearSavedRowState(projectId, tableId, rowId);
					setScopedSelection(null);
					await reload();
					return { kind: "saved", rowId };
				}
				if (retried.code !== "conflict") {
					return { kind: "failed", failure: retried };
				}
				const after = await getLookupTableAction(projectId, tableId);
				if (!after.success) return { kind: "failed", failure: after };
				const afterRow = after.value.rows.find((row) => row.id === rowId);
				if (afterRow === undefined) {
					clearSavedRowState(projectId, tableId, rowId);
					setScopedSelection(null);
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
					draft: baseline.row.values,
					verdict,
					fresh: fresh.value,
					draftColumns: baseline.columns,
				}),
			};
		},
		[projectId, tableId, reload, conflictFromSnapshot, clearSavedRowState],
	);

	const overwriteConflictRow = useCallback(
		async (
			conflict: ProjectDataRowConflict,
			values: LookupRowValues,
		): Promise<ProjectDataWriteOutcome> => {
			if (
				projectId === undefined ||
				projectId !== conflict.projectId ||
				conflict.resolution === null
			) {
				return unavailableOutcome();
			}
			const result = await updateLookupRowAction(
				projectId,
				conflictOverwriteInput({
					tableId: conflict.tableId,
					rowId: conflict.rowId,
					draft: values,
					resolution: conflict.resolution,
				}),
			);
			if (result.success) {
				clearSavedRowState(projectId, conflict.tableId, conflict.rowId);
				setScopedSelection({
					projectId,
					tableId: conflict.tableId,
					value: { kind: "row", rowId: conflict.rowId },
				});
				await reload();
				return { kind: "saved", rowId: conflict.rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			const fresh = await getLookupTableAction(projectId, conflict.tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const next = conflictFromSnapshot({
				attempted: "save",
				rowId: conflict.rowId,
				draft: values,
				verdict: fresh.value.rows.some((row) => row.id === conflict.rowId)
					? { kind: "ask", reason: "row-changed" }
					: { kind: "gone" },
				fresh: fresh.value,
				draftColumns: conflict.resolution.columns,
			});
			setRowConflict(next);
			return { kind: "conflict", conflict: next };
		},
		[
			projectId,
			reload,
			clearSavedRowState,
			conflictFromSnapshot,
			setRowConflict,
		],
	);

	const saveConflictAsNewRow = useCallback(
		async (
			conflict: ProjectDataRowConflict,
			values: LookupRowValues,
		): Promise<ProjectDataWriteOutcome> => {
			if (
				projectId === undefined ||
				projectId !== conflict.projectId ||
				conflict.resolution === null
			) {
				return unavailableOutcome();
			}
			const result = await createLookupRowAction(
				projectId,
				conflictSaveAsNewInput({
					tableId: conflict.tableId,
					draft: values,
					resolution: conflict.resolution,
				}),
			);
			if (result.success) {
				clearSavedRowState(projectId, conflict.tableId, conflict.rowId);
				await reload();
				setScopedSelection({
					projectId,
					tableId: conflict.tableId,
					value: { kind: "row", rowId: result.value.rowId, reveal: true },
				});
				return { kind: "saved", rowId: result.value.rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			const fresh = await getLookupTableAction(projectId, conflict.tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const next = conflictFromSnapshot({
				attempted: "save",
				rowId: conflict.rowId,
				draft: values,
				verdict: { kind: "gone" },
				fresh: fresh.value,
				draftColumns: conflict.resolution.columns,
			});
			setRowConflict(next);
			return { kind: "conflict", conflict: next };
		},
		[
			projectId,
			reload,
			clearSavedRowState,
			conflictFromSnapshot,
			setRowConflict,
		],
	);

	const deleteConflictRow = useCallback(
		async (
			conflict: ProjectDataRowConflict,
		): Promise<ProjectDataWriteOutcome> => {
			if (
				projectId === undefined ||
				projectId !== conflict.projectId ||
				conflict.resolution === null
			) {
				return unavailableOutcome();
			}
			const result = await deleteLookupRowAction(
				projectId,
				conflictDeleteInput({
					tableId: conflict.tableId,
					rowId: conflict.rowId,
					resolution: conflict.resolution,
				}),
			);
			if (result.success || result.code === "not_found") {
				clearSavedRowState(projectId, conflict.tableId, conflict.rowId);
				setScopedSelection(null);
				await reload();
				return { kind: "saved", rowId: conflict.rowId };
			}
			if (result.code !== "conflict") {
				return { kind: "failed", failure: result };
			}
			const fresh = await getLookupTableAction(projectId, conflict.tableId);
			if (!fresh.success) return { kind: "failed", failure: fresh };
			const current = fresh.value.rows.find((row) => row.id === conflict.rowId);
			if (current === undefined) {
				clearSavedRowState(projectId, conflict.tableId, conflict.rowId);
				setScopedSelection(null);
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
		[
			projectId,
			reload,
			clearSavedRowState,
			conflictFromSnapshot,
			setRowConflict,
		],
	);

	const value = useMemo<ProjectDataWorkspace>(
		() => ({
			active: tableId !== undefined,
			tableId,
			table: state,
			reload,
			selection,
			select,
			closeInspector,
			rowEditFor,
			retainRowEdit,
			discardRowEdit,
			rowConflict,
			setRowConflict,
			updateRowConflictDraft,
			discardRowConflict,
			pendingDraftCount: pendingRowIds.length,
			openPendingDraft,
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
			select,
			closeInspector,
			rowEditFor,
			retainRowEdit,
			discardRowEdit,
			rowConflict,
			setRowConflict,
			updateRowConflictDraft,
			discardRowConflict,
			pendingRowIds.length,
			openPendingDraft,
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
