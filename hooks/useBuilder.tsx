/**
 * useBuilder — context + hooks for the legacy builder store.
 *
 * Phase 3 rewrote `BuilderProvider` as a stack of small capability
 * providers, one per concern (scroll, edit guard, session, form engine).
 * The old `BuilderEngine` class is gone — its fields moved into scoped
 * contexts, its DOM helpers moved to `lib/routing/domQueries.ts`, and
 * its reset routine moved to `lib/services/resetBuilder.ts`.
 *
 * What remains in this module:
 *
 * 1. `StoreContext` — the legacy Zustand store (phase, generationData,
 *    replay, agent status, appId). Accessed via `useBuilderStore` /
 *    `useBuilderStoreShallow`. Phase 4 deletes the store entirely.
 * 2. `BuilderProvider` — mounts the provider stack and hydrates the
 *    legacy store from replay stages or an initial blueprint.
 * 3. Convenience selector hooks used across the builder (`useBuilderPhase`,
 *    `useBuilderIsReady`, `useBuilderTreeData`, entity hooks, etc).
 *
 * There is no longer a `useBuilderEngine` hook. Consumers that previously
 * reached for the engine now use scoped hooks directly:
 * - scroll → `useScrollIntoView` (ScrollRegistryContext)
 * - edit guard → `useRegisterEditGuard` / `useConsultEditGuard` (EditGuardContext)
 * - drag state → `useIsDragActive` (DragStateContext)
 * - cursor mode / sidebars / focus hint / connect stash → session hooks
 * - signal grid → module-level `signalGrid` + selectors
 * - form preview → `useBuilderFormEngine` (BuilderFormEngineProvider)
 * - undo flash helpers → `lib/routing/domQueries.ts`
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { useAssembledForm as useAssembledFormDoc } from "@/lib/doc/hooks/useAssembledForm";
import { useDocTreeData } from "@/lib/doc/hooks/useDocTreeData";
import { useQuestion as useQuestionDoc } from "@/lib/doc/hooks/useEntity";
import {
	useOrderedForms as useOrderedFormsDoc,
	useOrderedModules as useOrderedModulesDoc,
} from "@/lib/doc/hooks/useModuleIds";
import { BlueprintDocContext, BlueprintDocProvider } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import type { AppBlueprint, BlueprintForm } from "@/lib/schemas/blueprint";
import type { TreeData } from "@/lib/services/builder";
import { BuilderPhase } from "@/lib/services/builder";
import {
	selectInReplayMode,
	selectIsReady,
} from "@/lib/services/builderSelectors";
import {
	type BuilderState,
	type BuilderStoreApi,
	createBuilderStore,
} from "@/lib/services/builderStore";
import type { ReplayStage } from "@/lib/services/logReplay";
import type { NForm, NModule, NQuestion } from "@/lib/services/normalizedState";
import {
	BuilderSessionContext,
	BuilderSessionProvider,
} from "@/lib/session/provider";

// ── Contexts ────────────────────────────────────────────────────────────

/** Zustand store context — provides reactive subscriptions via selectors. */
const StoreContext = createContext<BuilderStoreApi | null>(null);

// ── Core hooks ──────────────────────────────────────────────────────────

/**
 * Subscribe to a slice of builder store state. Components re-render ONLY
 * when the selected value changes (Object.is comparison by default).
 *
 * Use for any reactive state: phase, appId, agentActive, etc.
 * For selecting multiple primitives as an object, use `useBuilderStoreShallow`.
 */
export function useBuilderStore<T>(selector: (state: BuilderState) => T): T {
	const store = useContext(StoreContext);
	if (!store) {
		throw new Error("useBuilderStore must be used within a BuilderProvider");
	}
	return useStore(store, selector);
}

/**
 * Subscribe to a slice with shallow equality comparison.
 * Use when the selector returns a new object of primitives each call
 * (e.g. `{ canUndo, canRedo }`) — shallow equality prevents re-renders
 * when the individual values haven't changed.
 */
export function useBuilderStoreShallow<T>(
	selector: (state: BuilderState) => T,
): T {
	const store = useContext(StoreContext);
	if (!store) {
		throw new Error(
			"useBuilderStoreShallow must be used within a BuilderProvider",
		);
	}
	return useStoreWithEqualityFn(store, selector, shallow);
}

/** Imperative handle on the legacy store — used by non-reactive helpers
 *  that need to call actions without subscribing to any state slice.
 *  Callers should prefer `useBuilderStore(selector)` when they also need
 *  a reactive read. */
export function useBuilderStoreApi(): BuilderStoreApi {
	const store = useContext(StoreContext);
	if (!store) {
		throw new Error("useBuilderStoreApi must be used within a BuilderProvider");
	}
	return store;
}

// ── Convenience selector hooks ──────────────────────────────────────────

/** Current builder lifecycle phase. */
export function useBuilderPhase(): BuilderPhase {
	return useBuilderStore((s) => s.phase);
}

/** True when the builder has entity data and is interactive (Ready or Completed). */
export function useBuilderIsReady(): boolean {
	return useBuilderStore(selectIsReady);
}

/** True when entity data is populated (replaces `!!s.blueprint`).
 *  Delegates directly to the doc store — no legacy store dependency. */
export { useDocHasData as useBuilderHasData } from "@/lib/doc/hooks/useDocHasData";

/**
 * Merged tree data for AppTree rendering — derived from doc store entities.
 *
 * Thin wrapper around `useDocTreeData`: reads `phase` + `generationData`
 * from the legacy builder store (these are lifecycle / generation-only
 * fields that haven't migrated yet), then delegates to the doc hook
 * which subscribes to entity maps directly on the BlueprintDoc store.
 *
 * During Ready/Completed phases, derives TreeData from doc entities.
 * During generation, constructs a merged view from scaffold + partials.
 */
export function useBuilderTreeData(): TreeData | undefined {
	const inputs = useBuilderStoreShallow((s) => ({
		phase: s.phase,
		generationData: s.generationData,
	}));
	return useDocTreeData(inputs);
}

/** Whether the SA agent is currently active. */
export function useBuilderAgentActive(): boolean {
	return useBuilderStore((s) => s.agentActive);
}

/** True when the builder is in replay mode (stages loaded in store). */
export function useBuilderInReplayMode(): boolean {
	return useBuilderStore(selectInReplayMode);
}

// ── Entity hooks — select specific entities by index ───────────────────

/** Select a module entity by its position in moduleOrder. Delegates to doc store. */
export function useModule(mIdx: number): NModule | undefined {
	const modules = useOrderedModulesDoc();
	return modules[mIdx] as unknown as NModule | undefined;
}

/** Select a form entity by module and form indices. Delegates to doc store. */
export function useForm(mIdx: number, fIdx: number): NForm | undefined {
	const modules = useOrderedModulesDoc();
	const modUuid = modules[mIdx]?.uuid;
	const forms = useOrderedFormsDoc((modUuid ?? "") as Uuid);
	return forms[fIdx] as unknown as NForm | undefined;
}

/** Select a question entity by UUID. Delegates to doc store. */
export function useQuestion(uuid: string): NQuestion | undefined {
	return useQuestionDoc(uuid as Uuid) as unknown as NQuestion | undefined;
}

/**
 * Returns an ordered array of NModule entities. Delegates to doc store.
 * Reference-stable via the doc hook's internal memoization.
 */
export function useOrderedModules(): NModule[] {
	return useOrderedModulesDoc() as unknown as NModule[];
}

/**
 * Returns an ordered array of NForm entities for a module. Delegates to doc store.
 * Reference-stable via the doc hook's internal memoization.
 */
export function useOrderedForms(mIdx: number): NForm[] {
	const modules = useOrderedModulesDoc();
	const modUuid = modules[mIdx]?.uuid;
	const forms = useOrderedFormsDoc((modUuid ?? "") as Uuid);
	return forms as unknown as NForm[];
}

/**
 * Assemble a BlueprintForm from normalized entities for FormEngine.
 * Delegates to the doc store's useAssembledFormDoc hook, which internally
 * memoizes the reconstruction. The `prevFormRef` comparison in useFormEngine
 * handles recreation.
 */
export function useAssembledForm(
	mIdx: number,
	fIdx: number,
): BlueprintForm | undefined {
	const modules = useOrderedModulesDoc();
	const modUuid = modules[mIdx]?.uuid;
	const forms = useOrderedFormsDoc((modUuid ?? "") as Uuid);
	const formUuid = forms[fIdx]?.uuid ?? ("" as unknown as Uuid);
	return useAssembledFormDoc(formUuid);
}

// ── Provider ────────────────────────────────────────────────────────────

/** Replay data extracted from server-fetched events, passed to BuilderProvider. */
export interface ReplayInit {
	stages: ReplayStage[];
	doneIndex: number;
	exitPath: string;
}

/**
 * BuilderProvider — mounts the entire builder provider stack for a
 * specific buildId and hydrates the legacy session store.
 *
 * Lifecycle:
 * - `/` → `/build/{id}`: provider mounts, fresh stores, loads app
 * - `/build/A` → `/build/B`: buildId changes, fresh stores, loads B
 * - `/build/*` → `/`: provider unmounts, stores are garbage collected
 * - `/build/new` generation: buildId stays 'new' (replaceState), no reset
 * - `/build/replay/{id}`: replay prop provided, hydrates store with stages
 *
 * The provider tree (outer → inner) is:
 *   StoreContext            — legacy Zustand store (phase, lifecycle)
 *   BlueprintDocProvider    — doc store (entities, undo/redo)
 *   BuilderSessionProvider  — ephemeral UI state (cursor, sidebars, stash)
 *   ScrollRegistryProvider  — imperative scroll plumbing
 *   EditGuardProvider       — select-guard predicate stack
 *   BuilderFormEngineProvider — form preview runtime controller
 *     SyncBridge            — wires the doc store into the legacy store
 *     LocationRecoveryEffect — repairs stale URL selection mid-session
 *     {children}
 */
export function BuilderProvider({
	buildId,
	children,
	replay,
	initialBlueprint,
}: {
	buildId: string;
	children: ReactNode;
	replay?: ReplayInit;
	/** Server-fetched blueprint — hydrates the doc store synchronously in
	 *  the provider so the first render sees populated entities. */
	initialBlueprint?: AppBlueprint;
}) {
	const [state, setState] = useState(() => ({
		store: createBuilderStore(
			replay || initialBlueprint ? BuilderPhase.Loading : BuilderPhase.Idle,
		),
		buildId,
	}));

	/* Adjusting state during rendering — React discards the current render
	 * and re-renders immediately with fresh stores when buildId changes. */
	if (buildId !== state.buildId) {
		setState({
			store: createBuilderStore(
				replay || initialBlueprint ? BuilderPhase.Loading : BuilderPhase.Idle,
			),
			buildId,
		});
	}

	const { store } = state;

	/* Hydrate the legacy store from replay stages or an initial blueprint.
	 * Runs once on mount (and again when `buildId` changes) to drive the
	 * legacy-store lifecycle fields to Ready. Entity data is hydrated by
	 * `BlueprintDocProvider` from the same `initialBlueprint`, so this
	 * effect only touches session/lifecycle flags.
	 *
	 * Phase 4 will delete this path entirely — generation + replay become
	 * a pure mutation stream on the doc store and there will be no legacy
	 * lifecycle to hydrate. */
	useEffect(() => {
		if (replay) {
			store
				.getState()
				.loadReplay(replay.stages, replay.doneIndex, replay.exitPath);
			for (let i = 0; i <= replay.doneIndex; i++) {
				replay.stages[i]?.applyToBuilder({ store, docStore: null });
			}
		} else if (initialBlueprint) {
			/* Transition the legacy lifecycle to Ready. The doc store was already
			 * hydrated synchronously by `BlueprintDocProvider` from the same
			 * `initialBlueprint` prop, so callers that read entity data from the
			 * doc see a populated state on the first render. */
			store.getState().loadApp(buildId);
		}
	}, [store, buildId, replay, initialBlueprint]);

	return (
		<StoreContext value={store}>
			<BlueprintDocProvider
				appId={buildId === "new" ? undefined : buildId}
				initialBlueprint={initialBlueprint}
				startTracking={Boolean(initialBlueprint || replay)}
			>
				<BuilderSessionProvider>
					<ScrollRegistryProvider>
						<EditGuardProvider>
							<BuilderFormEngineProvider>
								<SyncBridge />
								<LocationRecoveryEffect />
								{children}
							</BuilderFormEngineProvider>
						</EditGuardProvider>
					</ScrollRegistryProvider>
				</BuilderSessionProvider>
			</BlueprintDocProvider>
		</StoreContext>
	);
}

/**
 * SyncBridge — installs the doc store reference on the legacy and session
 * stores after the provider tree mounts. Non-React callers reach the doc
 * through these references instead of importing it directly.
 *
 * Two installation sites:
 * 1. Legacy store — so generation-stream setters (setScaffold, setSchema,
 *    setModuleContent, setFormContent) can dispatch entity mutations as
 *    doc mutations through `_docStore`.
 * 2. Session store — so `switchConnectMode` can dispatch doc mutations
 *    atomically alongside session stash updates.
 *
 * The `BuilderFormEngineProvider` installs its own doc-store reference
 * via a sibling effect; SyncBridge doesn't touch the form controller.
 */
function SyncBridge() {
	const docStore = useContext(BlueprintDocContext);
	const store = useContext(StoreContext);
	const sessionStore = useContext(BuilderSessionContext);

	useEffect(() => {
		if (!docStore || !store) return;
		store.getState().setDocStore(docStore);
		if (sessionStore) sessionStore.getState()._setDocStore(docStore);
		return () => {
			store.getState().setDocStore(null);
			if (sessionStore) sessionStore.getState()._setDocStore(null);
		};
	}, [docStore, store, sessionStore]);

	return null;
}
