/**
 * Lightweight case-list workspace boundary.
 *
 * The case-list authoring controller is intentionally large: it owns three
 * canvases, their inspector bodies, and the mutation plans behind them. Most
 * Builder visits never open those screens, so importing that controller from
 * BuilderProvider made every form/home load download and evaluate it anyway.
 *
 * These external-store contexts keep the provider ancestry stable while the
 * controller itself loads only after the first case-list visit. Keeping
 * `children` under the same providers matters: replacing their wrapper when
 * the chunk arrives would remount chat and could sever an in-flight run.
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
import type { Uuid } from "@/lib/domain";
import { useLocationKind, useSelectedModuleUuid } from "@/lib/routing/hooks";
import type { CaseListWorkspace } from "./CaseListConfigWorkspace";

export type CaseListWorkspaceTab = "search" | "list" | "detail";

export interface CaseListWorkspaceTarget {
	readonly moduleUuid: Uuid;
	readonly tab: CaseListWorkspaceTab;
}

export interface PublishedValue<T> {
	readonly getSnapshot: () => T;
	readonly subscribe: (listener: () => void) => () => void;
	publish(value: T): void;
}

function createPublishedValue<T>(initial: T): PublishedValue<T> {
	let value = initial;
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

export type CaseListWorkspaceStore = PublishedValue<CaseListWorkspace | null>;

export interface CaseListInspectorSlice {
	readonly inspector: CaseListWorkspace["inspector"];
	readonly onClose: CaseListWorkspace["onClose"];
}

export type CaseListInspectorStore =
	PublishedValue<CaseListInspectorSlice | null>;

const EMPTY_WORKSPACE_STORE = createPublishedValue<CaseListWorkspace | null>(
	null,
);
const EMPTY_INSPECTOR_STORE =
	createPublishedValue<CaseListInspectorSlice | null>(null);

const CaseListWorkspaceStoreContext =
	createContext<CaseListWorkspaceStore | null>(null);
const CaseListInspectorStoreContext =
	createContext<CaseListInspectorStore | null>(null);

const ControllerBridge = dynamic(
	() =>
		import("./CaseListConfigWorkspace").then(
			(module) => module.CaseListWorkspaceControllerBridge,
		),
	{ loading: () => null },
);

export interface CaseListWorkspaceControllerBridgeProps {
	readonly target: CaseListWorkspaceTarget | null;
	readonly workspaceStore: CaseListWorkspaceStore;
	readonly inspectorStore: CaseListInspectorStore;
}

export function useCaseListWorkspace(): CaseListWorkspace | null {
	const store =
		useContext(CaseListWorkspaceStoreContext) ?? EMPTY_WORKSPACE_STORE;
	return useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
}

export function useCaseListInspector(): CaseListInspectorSlice | null {
	const store =
		useContext(CaseListInspectorStoreContext) ?? EMPTY_INSPECTOR_STORE;
	return useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
}

/**
 * Mounts the controller at most once, on demand. Once activated it remains
 * mounted with an inert `null` target away from case-list URLs, preserving its
 * per-module selection and scroll session without charging ordinary Builder
 * loads for its JavaScript.
 */
export function CaseListWorkspaceProvider({
	children,
	controllerComponent,
}: {
	children: ReactNode;
	/** Test seam: production leaves this unset so the controller stays lazy. */
	controllerComponent?: ComponentType<CaseListWorkspaceControllerBridgeProps>;
}) {
	const routeKind = useLocationKind();
	const moduleUuid = useSelectedModuleUuid();
	const target = useMemo<CaseListWorkspaceTarget | null>(() => {
		if (!moduleUuid) return null;
		switch (routeKind) {
			case "cases":
				return { moduleUuid, tab: "list" };
			case "search-config":
				return { moduleUuid, tab: "search" };
			case "detail-config":
				return { moduleUuid, tab: "detail" };
			default:
				return null;
		}
	}, [moduleUuid, routeKind]);
	const [workspaceStore] = useState(() =>
		createPublishedValue<CaseListWorkspace | null>(null),
	);
	const [inspectorStore] = useState(() =>
		createPublishedValue<CaseListInspectorSlice | null>(null),
	);
	const [activated, setActivated] = useState(target !== null);
	const ActiveControllerBridge = controllerComponent ?? ControllerBridge;

	useEffect(() => {
		if (target !== null) setActivated(true);
	}, [target]);
	const controllerMounted = activated || target !== null;

	return (
		<CaseListWorkspaceStoreContext.Provider value={workspaceStore}>
			<CaseListInspectorStoreContext.Provider value={inspectorStore}>
				{controllerMounted ? (
					<ActiveControllerBridge
						target={target}
						workspaceStore={workspaceStore}
						inspectorStore={inspectorStore}
					/>
				) : null}
				{children}
			</CaseListInspectorStoreContext.Provider>
		</CaseListWorkspaceStoreContext.Provider>
	);
}
