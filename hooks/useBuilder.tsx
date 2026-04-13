/**
 * useBuilder — Zustand-backed context for the BuilderEngine and store.
 *
 * BuilderProvider scopes one BuilderEngine (and its Zustand store) to each
 * /build/{id} page. When buildId changes, a fresh engine is created. When
 * the page unmounts, the engine is garbage collected.
 *
 * Components access state in two ways:
 * - `useBuilderStore(selector)` — reactive subscription to a precise slice
 *   of store state. Only re-renders when the selected value changes.
 * - `useBuilderEngine()` — imperative access to the engine for non-reactive
 *   state and composing methods (navigateTo, energy, guards, scroll).
 *
 * Convenience hooks (useBuilderPhase, useModule, useForm, etc.) wrap
 * `useBuilderStore` with common selectors for ergonomic call sites.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { startSyncOldFromDoc } from "@/lib/doc/adapters/syncOldFromDoc";
import { useAssembledForm as useAssembledFormDoc } from "@/lib/doc/hooks/useAssembledForm";
import { useQuestion as useQuestionDoc } from "@/lib/doc/hooks/useEntity";
import {
	useOrderedForms as useOrderedFormsDoc,
	useOrderedModules as useOrderedModulesDoc,
} from "@/lib/doc/hooks/useModuleIds";
import { BlueprintDocContext, BlueprintDocProvider } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import type { AppBlueprint, BlueprintForm } from "@/lib/schemas/blueprint";
import type { TreeData } from "@/lib/services/builder";
import { BuilderPhase } from "@/lib/services/builder";
import { BuilderEngine } from "@/lib/services/builderEngine";
import {
	deriveTreeData,
	selectHasData,
	selectInReplayMode,
	selectIsReady,
} from "@/lib/services/builderSelectors";
import type {
	BuilderState,
	BuilderStoreApi,
	CursorMode,
} from "@/lib/services/builderStore";
import type { ReplayStage } from "@/lib/services/logReplay";
import type { NForm, NModule, NQuestion } from "@/lib/services/normalizedState";

// ── Contexts ────────────────────────────────────────────────────────────

/** Zustand store context — provides reactive subscriptions via selectors. */
const StoreContext = createContext<BuilderStoreApi | null>(null);

/** Engine context — provides imperative access to non-reactive state and DOM glue. */
const EngineContext = createContext<BuilderEngine | null>(null);

// ── Core hooks ──────────────────────────────────────────────────────────

/**
 * Subscribe to a slice of builder store state. Components re-render ONLY
 * when the selected value changes (Object.is comparison by default).
 *
 * Use for any reactive state: phase, selected, entity maps, etc.
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

/**
 * Access the BuilderEngine for non-reactive state and composing methods.
 * Does NOT subscribe to any state — calling this hook never triggers re-renders.
 *
 * Use for: engine.navigateTo(), energy methods, guards, scroll callbacks,
 * focus hints, drag state, connect stash.
 */
export function useBuilderEngine(): BuilderEngine {
	const engine = useContext(EngineContext);
	if (!engine) {
		throw new Error("useBuilderEngine must be used within a BuilderProvider");
	}
	return engine;
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

/** True when entity data is populated (replaces `!!s.blueprint`). */
export function useBuilderHasData(): boolean {
	return useBuilderStore(selectHasData);
}

/**
 * Merged tree data for AppTree rendering — derived from store state.
 *
 * Subscribes to entity maps and generation state via `useBuilderStoreShallow`,
 * then memoizes the derivation. Immer structural sharing ensures unchanged
 * maps keep the same reference, so the shallow-equality selector returns a
 * stable object when nothing changed — and `useMemo` skips recomputation.
 *
 * During Ready/Completed phases, derives TreeData from normalized entities.
 * During generation, constructs a merged view from scaffold + partials.
 *
 * This CANNOT use `useBuilderStore(deriveTreeData)` directly — `deriveTreeData`
 * builds new objects via `.map()` on every call, which fails `Object.is`
 * comparison and triggers an infinite re-render loop in useSyncExternalStore.
 */
export function useBuilderTreeData(): TreeData | undefined {
	/* Subscribe to the exact fields deriveTreeData reads. Shallow equality
	 * compares each field by reference — only produces a new `data` object
	 * when at least one entity map, ordering array, or scalar changes. */
	const data = useBuilderStoreShallow((s) => ({
		phase: s.phase,
		appName: s.appName,
		connectType: s.connectType,
		modules: s.modules,
		forms: s.forms,
		questions: s.questions,
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
		questionOrder: s.questionOrder,
		generationData: s.generationData,
	}));

	/* `data` is referentially stable when nothing changed (shallow equality
	 * returned the previous result), so useMemo skips recomputation. When
	 * any field changes, `data` gets a new reference → memo recomputes. */
	return useMemo(() => deriveTreeData(data), [data]);
}

/** Whether the SA agent is currently active. */
export function useBuilderAgentActive(): boolean {
	return useBuilderStore((s) => s.agentActive);
}

/** Current cursor mode (inspect, text, pointer). */
export function useBuilderCursorMode(): CursorMode {
	return useBuilderStore((s) => s.cursorMode);
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
 * BuilderProvider — owns the BuilderEngine lifecycle for a specific buildId.
 *
 * Creates a fresh engine (with its own Zustand store) when buildId changes
 * using the "adjusting state during rendering" pattern. Provides both
 * the Zustand store and the engine via separate contexts.
 *
 * Lifecycle:
 * - `/` → `/build/{id}`: provider mounts, fresh engine, loads app
 * - `/build/A` → `/build/B`: buildId changes, fresh engine, loads B
 * - `/build/*` → `/`: provider unmounts, engine is garbage collected
 * - `/build/new` generation: buildId stays 'new' (replaceState), no reset
 * - `/build/replay/{id}`: replay prop provided, hydrates store with stages
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
	/** Server-fetched blueprint — hydrates the store synchronously in the
	 *  factory so the first render sees Ready state. Provided by the RSC
	 *  page for existing apps. */
	initialBlueprint?: AppBlueprint;
}) {
	const [state, setState] = useState(() => ({
		engine: createEngine(buildId, replay, initialBlueprint),
		buildId,
	}));

	/* Adjusting state during rendering — React discards the current render
	 * and re-renders immediately with the new engine. */
	if (buildId !== state.buildId) {
		setState({
			engine: createEngine(buildId, replay, initialBlueprint),
			buildId,
		});
	}

	const { engine } = state;

	return (
		<EngineContext value={engine}>
			<StoreContext value={engine.store}>
				<BlueprintDocProvider
					appId={buildId === "new" ? "" : buildId}
					initialBlueprint={initialBlueprint}
					startTracking={Boolean(initialBlueprint || replay)}
				>
					{/* SyncBridge must render inside the BlueprintDocProvider tree so
					 * it can read the doc store via context. It starts a one-way
					 * subscription that mirrors doc entity maps into the legacy
					 * store, keeping un-migrated consumers live during Phase 1b. */}
					<SyncBridge oldStore={engine.store} />
					<LocationRecoveryEffect />
					{children}
				</BlueprintDocProvider>
			</StoreContext>
		</EngineContext>
	);
}

/**
 * Internal component that wires the doc→legacy projection and installs the
 * doc store reference on the engine. Rendered as a sibling of `{children}`
 * inside `BlueprintDocProvider` so it can read the doc store via context.
 * Returns `null` — it exists purely for its subscription side effect.
 *
 * `engine.store` is stable across the provider's lifetime (the engine is
 * recreated only when `buildId` changes, which unmounts this component
 * and remounts a fresh one), so the effect's dependency list is
 * effectively constant.
 */
function SyncBridge({ oldStore }: { oldStore: BuilderStoreApi }) {
	const docStore = useContext(BlueprintDocContext);
	const engine = useContext(EngineContext);
	useEffect(() => {
		if (!docStore) return;
		/* Install the doc store on the engine so entity mutations and
		 * undo/redo route through the doc instead of the legacy store. */
		if (engine) engine.setDocStore(docStore);
		/* Install it on the legacy store too — generation-stream setters
		 * (setScaffold, setSchema, setModuleContent, setFormContent) dispatch
		 * entity changes as doc mutations through this reference. */
		oldStore.getState().setDocStore(docStore);
		const stop = startSyncOldFromDoc(docStore, oldStore);
		return () => {
			if (engine) engine.setDocStore(null);
			oldStore.getState().setDocStore(null);
			stop();
		};
	}, [docStore, oldStore, engine]);
	return null;
}

// ── Engine factory ──────────────────────────────────────────────────────

/**
 * Create a BuilderEngine, optionally hydrating it with server-fetched data
 * or replay stages. Both paths use synchronous hydration in the factory —
 * the store transitions from empty to populated atomically, invisible to
 * undo history (tracking is paused in the constructor, resumed here).
 *
 * Existing apps and replays start in Loading (safe fallback if a frame
 * paints before loadApp/loadReplay transitions to Ready). New builds
 * start in Idle for chat-driven generation.
 */
function createEngine(
	buildId: string,
	replay?: ReplayInit,
	initialBlueprint?: AppBlueprint,
): BuilderEngine {
	const initialPhase =
		replay || initialBlueprint ? BuilderPhase.Loading : BuilderPhase.Idle;
	const engine = new BuilderEngine(initialPhase);

	if (replay) {
		engine.store
			.getState()
			.loadReplay(replay.stages, replay.doneIndex, replay.exitPath);
		for (let i = 0; i <= replay.doneIndex; i++) {
			replay.stages[i]?.applyToBuilder(engine);
		}
	} else if (initialBlueprint) {
		/* Hydrate the store with the server-fetched blueprint. `loadApp`
		 * transitions to Ready and populates all entity maps. Resume undo
		 * tracking so the hydrated state is the undo baseline. */
		engine.store.getState().loadApp(buildId, initialBlueprint);
		engine.store.temporal.getState().resume();
	}

	return engine;
}
