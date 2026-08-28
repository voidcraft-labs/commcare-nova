/** Lightweight, on-demand boundary for the Project data controller.
 *
 * The controller owns table reads, retained row drafts, conflict recovery, and
 * write actions. None of that is needed on an ordinary form/home visit. This
 * provider keeps stable ancestry for the Builder while loading the controller
 * only on the first Project data route; once loaded it remains mounted so its
 * drafts and recovery watches retain their original lifecycle.
 */
"use client";

import dynamic from "next/dynamic";
import {
	type ComponentType,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	useLocationKind,
	useSelectedProjectDataTableId,
} from "@/lib/routing/hooks";
import type { ProjectDataWorkspace } from "./ProjectDataWorkspaceProvider";

export interface ProjectDataWorkspaceStore {
	readonly getSnapshot: () => ProjectDataWorkspace | null;
	readonly subscribe: (listener: () => void) => () => void;
	publish(value: ProjectDataWorkspace | null): void;
}

function createWorkspaceStore(): ProjectDataWorkspaceStore {
	let value: ProjectDataWorkspace | null = null;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => value,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		publish: (next) => {
			if (Object.is(value, next)) return;
			value = next;
			for (const listener of listeners) listener();
		},
	};
}

export interface ProjectDataWorkspaceControllerBridgeProps {
	readonly tableId: LookupTableId | undefined;
	readonly projectDataRoute: boolean;
	readonly workspaceStore: ProjectDataWorkspaceStore;
}

const EMPTY_WORKSPACE_STORE = createWorkspaceStore();
const WorkspaceStoreContext = createContext<ProjectDataWorkspaceStore | null>(
	null,
);

const ControllerBridge = dynamic(
	() =>
		import("./ProjectDataWorkspaceProvider").then(
			(module) => module.ProjectDataWorkspaceControllerBridge,
		),
	{ loading: () => null },
);

export function useProjectDataWorkspace(): ProjectDataWorkspace | null {
	const store = useContext(WorkspaceStoreContext) ?? EMPTY_WORKSPACE_STORE;
	return useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
}

/** The layout-only projection of Project data's inspector state. Keeping this
 * here avoids loading the row/column inspector resolver merely to reserve the
 * rail's width. */
export function useProjectDataInspectorPresence(): {
	readonly docked: boolean;
	readonly onClose: () => void;
} | null {
	const workspace = useProjectDataWorkspace();
	if (workspace === null) return null;
	const selection = workspace.selection;
	const table = workspace.table.kind === "data" ? workspace.table.value : null;
	const docked =
		workspace.rowConflict !== null ||
		(selection?.kind === "row"
			? (table?.rows.some((row) => row.id === selection.rowId) ?? false)
			: selection?.kind === "column"
				? (table?.columns.some((column) => column.id === selection.columnId) ??
					false)
				: false);
	return { docked, onClose: workspace.closeInspector };
}

export function ProjectDataWorkspaceProvider({
	children,
	controllerComponent,
}: {
	children: ReactNode;
	/** Test seam: production leaves the heavy controller lazy. */
	controllerComponent?: ComponentType<ProjectDataWorkspaceControllerBridgeProps>;
}) {
	const routeKind = useLocationKind();
	const tableId = useSelectedProjectDataTableId();
	const projectDataRoute = routeKind === "project-data";
	const [workspaceStore] = useState(createWorkspaceStore);
	const [activated, setActivated] = useState(projectDataRoute);
	const ActiveControllerBridge = controllerComponent ?? ControllerBridge;

	useEffect(() => {
		if (projectDataRoute) setActivated(true);
	}, [projectDataRoute]);
	const controllerMounted = activated || projectDataRoute;
	const controller = useMemo(
		() =>
			controllerMounted ? (
				<ActiveControllerBridge
					tableId={tableId}
					projectDataRoute={projectDataRoute}
					workspaceStore={workspaceStore}
				/>
			) : null,
		[
			ActiveControllerBridge,
			controllerMounted,
			projectDataRoute,
			tableId,
			workspaceStore,
		],
	);

	return (
		<WorkspaceStoreContext.Provider value={workspaceStore}>
			{controller}
			{children}
		</WorkspaceStoreContext.Provider>
	);
}
