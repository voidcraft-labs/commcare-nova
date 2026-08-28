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
	useCallback,
	useEffect,
	useLayoutEffect,
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
import { useNavigate } from "@/lib/routing/hooks";
import { usePreviewing, useProjectId } from "@/lib/session/hooks";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";
import type { ProjectDataWorkspaceControllerBridgeProps } from "./ProjectDataWorkspaceLazyProvider";
import {
	type ConflictVerdict,
	columnsEqual,
	conflictDeleteInput,
	conflictOverwriteInput,
	conflictSaveAsNewInput,
	hasRetainedRowWorkForProject,
	manifestProvesTableUnavailable,
	mergeUnavailableRowDraft,
	type RemovedConflictCell,
	type RetainedRowRecovery,
	type RowDraft,
	type RowDraftCell,
	type RowEditBaseline,
	reconcileConflictDraft,
	reconcileRowDraft,
	retainedRowRecoveries,
	rowWriteConflictVerdict,
} from "./projectDataModel";
import {
	type ProjectDataManifest,
	type ProjectDataRead,
	useProjectDataManifest,
	useProjectDataTable,
} from "./useProjectData";

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
	readonly manifest: ProjectDataRead<ProjectDataManifest>;
	readonly reloadManifest: () => Promise<void>;
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
	readonly retainedRows: readonly RetainedRowRecovery[];
	readonly openRetainedRow: (retained: RetainedRowRecovery) => void;
	/** Record a successful local table deletion before realtime catches up. */
	readonly noteTableUnavailable: (tableId: LookupTableId) => void;
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

const INSPECTOR_RETURN_FOCUS_ATTRIBUTE = "data-inspector-return-focus";

function clearInspectorReturnFocusMarkers(): void {
	for (const previous of document.querySelectorAll<HTMLElement>(
		`[${INSPECTOR_RETURN_FOCUS_ATTRIBUTE}]`,
	)) {
		previous.removeAttribute(INSPECTOR_RETURN_FOCUS_ATTRIBUTE);
	}
}

function inspectorOriginForSelection(
	selection: Exclude<ProjectDataSelection, null>,
): HTMLElement | null {
	const root = document.querySelector<HTMLElement>(
		"[data-project-data-table-screen]",
	);
	if (root === null) return null;
	const attribute =
		selection.kind === "row"
			? "data-project-data-row-open"
			: "data-project-data-column-open";
	const identity =
		selection.kind === "row" ? selection.rowId : selection.columnId;
	for (const candidate of root.querySelectorAll<HTMLElement>(
		`[${attribute}]`,
	)) {
		if (candidate.getAttribute(attribute) === identity) return candidate;
	}
	return root.querySelector<HTMLElement>("[data-project-data-focus-fallback]");
}

function unavailableConflictFor(
	edit: ProjectDataRowEditSession | undefined,
	existing: ProjectDataRowConflict | undefined,
): ProjectDataRowConflict | undefined {
	if (edit === undefined && existing === undefined) return undefined;
	const merged = mergeUnavailableRowDraft({
		...(edit === undefined
			? {}
			: {
					edit: {
						draft: edit.draft,
						columns: edit.baseline.columns,
					},
				}),
		...(existing === undefined
			? {}
			: {
					conflict: {
						draft: existing.editableDraft,
						columns: existing.resolution?.columns ?? existing.displayColumns,
						removed: existing.removed,
					},
				}),
	});
	const source = existing ?? edit;
	if (source === undefined) return undefined;
	return {
		projectId: source.projectId,
		tableId: source.tableId,
		tableName: source.tableName,
		attempted: existing?.attempted ?? "save",
		rowId: source.rowId,
		draft: existing?.draft ?? edit?.baseline.row.values ?? {},
		editableDraft: merged.draft,
		removed: [],
		verdict: { kind: "gone" },
		current: undefined,
		displayColumns: merged.columns.map((column) => ({ ...column })),
		tableUnavailable: true,
		resolution: null,
	};
}

/** Dynamic bridge used by the lightweight provider. It publishes the heavy
 * controller through an external store instead of wrapping the Builder's
 * children, so loading this chunk never remounts chat or the canvas. */
export function ProjectDataWorkspaceControllerBridge({
	tableId,
	projectDataRoute,
	workspaceStore,
}: ProjectDataWorkspaceControllerBridgeProps) {
	return (
		<ActiveHost
			tableId={tableId}
			projectDataRoute={projectDataRoute}
			onPublish={workspaceStore.publish}
		/>
	);
}

function ActiveHost({
	tableId,
	projectDataRoute,
	onPublish,
}: {
	tableId: LookupTableId | undefined;
	projectDataRoute: boolean;
	onPublish: (value: ProjectDataWorkspace | null) => void;
}) {
	const projectId = useProjectId();
	const previewing = usePreviewing();
	const navigate = useNavigate();
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
	/* Table ids stay under their Project instead of flattening into a composite
	 * string key: a flat key has to be split and re-narrowed to recover the
	 * identity, and narrowing helpers validate rather than cast. */
	const [locallyUnavailableTables, setLocallyUnavailableTables] = useState<
		ReadonlyMap<string, ReadonlySet<LookupTableId>>
	>(() => new Map());
	/* Most builder routes need no lookup manifest at all. Keep the Project-wide
	 * read alive while its own workspace is visible or this tab carries row work
	 * that must notice an off-route peer deletion; otherwise a fresh/dormant
	 * builder should not launch an unrelated Server Action. */
	const hasCurrentProjectRowWork = useMemo(
		() =>
			hasRetainedRowWorkForProject({
				projectId,
				edits: rowEdits.values(),
				conflicts: rowConflicts.values(),
			}),
		[projectId, rowEdits, rowConflicts],
	);
	const manifestNeeded = projectDataRoute || hasCurrentProjectRowWork;
	const { state: manifest, reload: reloadManifest } =
		useProjectDataManifest(manifestNeeded);
	const pendingInspectorFocusRef = useRef<Exclude<
		ProjectDataSelection,
		null
	> | null>(null);

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
		if (selection === null) return;
		/* Store identity, not a render-owned marker. Clearing selection removes the
		 * selected row/header props in the same commit; the layout effect below
		 * resolves the still-mounted stable control only after that commit. */
		pendingInspectorFocusRef.current = selection;
		setScopedSelection(null);
	}, [selection]);

	useLayoutEffect(() => {
		const originSelection = pendingInspectorFocusRef.current;
		if (originSelection === null || selection !== null) return;
		pendingInspectorFocusRef.current = null;
		const target = inspectorOriginForSelection(originSelection);
		if (target === null) {
			clearInspectorReturnFocusMarkers();
			return;
		}
		clearInspectorReturnFocusMarkers();
		target.setAttribute(INSPECTOR_RETURN_FOCUS_ATTRIBUTE, "");
		target.focus({ preventScroll: true });
		/* A modal narrow/handset drawer keeps the marker until Base UI requests
		 * final focus after its close transition. Desktop has no inert canvas and
		 * can retire it immediately after focusing. */
		if (
			target.closest(
				'[data-builder-layout="narrow"], [data-builder-layout="handset"]',
			) === null
		) {
			target.removeAttribute(INSPECTOR_RETURN_FOCUS_ATTRIBUTE);
		}
	}, [selection]);

	useEffect(() => {
		if (selection !== null && pendingInspectorFocusRef.current === null) {
			clearInspectorReturnFocusMarkers();
		}
	}, [selection]);

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

	const noteTableUnavailable = useCallback(
		(unavailableTableId: LookupTableId) => {
			if (projectId === undefined) return;
			setLocallyUnavailableTables((current) => {
				const scoped = current.get(projectId);
				if (scoped?.has(unavailableTableId)) return current;
				const next = new Map(current);
				next.set(projectId, new Set(scoped ?? []).add(unavailableTableId));
				return next;
			});
		},
		[projectId],
	);

	const unavailableTableIds = useMemo(() => {
		const unavailable = new Set<LookupTableId>();
		if (projectId === undefined) return unavailable;
		for (const tableId of locallyUnavailableTables.get(projectId) ?? []) {
			unavailable.add(tableId);
		}
		if (manifest.kind === "data" && manifest.value.projectId === projectId) {
			const available = new Set(manifest.value.tables.map((entry) => entry.id));
			for (const edit of rowEdits.values()) {
				if (
					edit.projectId === projectId &&
					manifestProvesTableUnavailable({
						manifestRevision: manifest.value.projectRevision,
						knownTableRevision: edit.baseline.tableRevision,
						manifestHasTable: available.has(edit.tableId),
					})
				) {
					unavailable.add(edit.tableId);
				}
			}
			for (const conflict of rowConflicts.values()) {
				if (
					conflict.projectId === projectId &&
					(conflict.tableUnavailable ||
						(conflict.resolution !== null &&
							manifestProvesTableUnavailable({
								manifestRevision: manifest.value.projectRevision,
								knownTableRevision: conflict.resolution.tableRevision,
								manifestHasTable: available.has(conflict.tableId),
							})))
				) {
					unavailable.add(conflict.tableId);
				}
			}
		}
		if (
			tableId !== undefined &&
			state.kind === "failed" &&
			state.failure.code === "not_found"
		) {
			unavailable.add(tableId);
		}
		return unavailable;
	}, [
		projectId,
		locallyUnavailableTables,
		manifest,
		rowEdits,
		rowConflicts,
		tableId,
		state,
	]);

	const rowConflict = useMemo(() => {
		if (
			selection?.kind !== "row" ||
			projectId === undefined ||
			tableId === undefined
		) {
			return null;
		}
		const key = rowStateKey(projectId, tableId, selection.rowId);
		const existing = rowConflicts.get(key);
		if (!unavailableTableIds.has(tableId)) return existing ?? null;
		return unavailableConflictFor(rowEdits.get(key), existing) ?? null;
	}, [
		selection,
		projectId,
		tableId,
		rowConflicts,
		rowEdits,
		unavailableTableIds,
	]);

	/* Once the manifest, a direct table read, or a successful local delete says
	 * a table is unavailable, turn EVERY retained edit or conflict into one
	 * snapshot-backed recovery. This union deliberately includes pristine
	 * save/delete conflicts that never created a row-edit session. */
	useEffect(() => {
		if (projectId === undefined || unavailableTableIds.size === 0) return;
		const editsByKey = new Map<string, ProjectDataRowEditSession>();
		const keys = new Set<string>();
		for (const edit of rowEdits.values()) {
			if (
				edit.projectId !== projectId ||
				!unavailableTableIds.has(edit.tableId)
			) {
				continue;
			}
			const key = rowStateKey(projectId, edit.tableId, edit.rowId);
			editsByKey.set(key, edit);
			keys.add(key);
		}
		for (const conflict of rowConflicts.values()) {
			if (
				conflict.projectId === projectId &&
				unavailableTableIds.has(conflict.tableId)
			) {
				keys.add(rowStateKey(projectId, conflict.tableId, conflict.rowId));
			}
		}
		if (keys.size === 0) return;
		setRowConflicts((current) => {
			let changed = false;
			const next = new Map(current);
			for (const key of keys) {
				const existing = next.get(key);
				if (existing?.tableUnavailable === true) continue;
				const unavailable = unavailableConflictFor(
					editsByKey.get(key),
					existing,
				);
				if (unavailable === undefined) continue;
				next.set(key, unavailable);
				changed = true;
			}
			return changed ? next : current;
		});
	}, [projectId, unavailableTableIds, rowEdits, rowConflicts]);

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

	const retainedRows = useMemo(() => {
		const currentNames =
			manifest.kind === "data"
				? new Map(manifest.value.tables.map((entry) => [entry.id, entry.name]))
				: new Map<LookupTableId, string>();
		return retainedRowRecoveries({
			projectId,
			edits: rowEdits.values(),
			conflicts: rowConflicts.values(),
			unavailableTableIds,
		}).map((retained) => ({
			...retained,
			tableName: currentNames.get(retained.tableId) ?? retained.tableName,
		}));
	}, [manifest, projectId, rowEdits, rowConflicts, unavailableTableIds]);

	const currentRetainedRows = useMemo(
		() =>
			tableId === undefined
				? []
				: retainedRows.filter((retained) => retained.tableId === tableId),
		[retainedRows, tableId],
	);

	const openRetainedRow = useCallback(
		(retained: RetainedRowRecovery) => {
			if (projectId === undefined || retained.projectId !== projectId) return;
			setScopedSelection({
				projectId,
				tableId: retained.tableId,
				value: { kind: "row", rowId: retained.rowId },
			});
			if (tableId !== retained.tableId) {
				navigate.openProjectData(retained.tableId);
			}
		},
		[projectId, tableId, navigate],
	);

	const openPendingDraft = useCallback(() => {
		const retained = currentRetainedRows[0];
		if (retained !== undefined) openRetainedRow(retained);
	}, [currentRetainedRows, openRetainedRow]);

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
			manifest,
			reloadManifest,
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
			pendingDraftCount: currentRetainedRows.length,
			openPendingDraft,
			retainedRows,
			openRetainedRow,
			noteTableUnavailable,
			saveRow,
			addRow,
			deleteRow,
			overwriteConflictRow,
			saveConflictAsNewRow,
			deleteConflictRow,
		}),
		[
			tableId,
			manifest,
			reloadManifest,
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
			currentRetainedRows.length,
			openPendingDraft,
			retainedRows,
			openRetainedRow,
			noteTableUnavailable,
			saveRow,
			addRow,
			deleteRow,
			overwriteConflictRow,
			saveConflictAsNewRow,
			deleteConflictRow,
		],
	);
	useLayoutEffect(() => {
		onPublish(value);
		return () => onPublish(null);
	}, [onPublish, value]);

	return null;
}
