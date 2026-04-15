/**
 * useBuilder — context + hooks for the legacy builder store + provider stack.
 *
 * Phase 4 (T10) rewired the provider lifecycle to route through the session
 * store instead of the legacy store. The session store now owns:
 * - Phase derivation (`derivePhase` in `lib/session/hooks.tsx`)
 * - Agent lifecycle (`beginAgentWrite` / `endAgentWrite`)
 * - App identity (`appId`, `loading`)
 * - Replay state (`loadReplay`, stage emissions via `applyStreamEvent`)
 *
 * What remains in this module:
 *
 * 1. `StoreContext` — the legacy Zustand store, still accessed by
 *    `useBuilderStore` / `useBuilderStoreShallow` consumers until
 *    Phase 6 deletes the store entirely.
 * 2. `BuilderProvider` — mounts the provider stack. Lifecycle hydration
 *    now flows through `LoadAppHydrator` (existing apps) and
 *    `ReplayHydrator` (replay mode), both of which write to the
 *    session store rather than the legacy store.
 * 3. Entity hooks (`useModule`, `useForm`, `useQuestion`, `useOrderedModules`,
 *    `useOrderedForms`, `useAssembledForm`) — delegated to doc store,
 *    kept for backward compatibility until Phase 6.
 * 4. `useBuilderTreeData` — derived tree data with partial scaffold fallback.
 * 5. `useBuilderHasData` — re-exported from doc store hooks.
 *
 * Lifecycle hooks that moved to `lib/session/hooks.tsx`:
 * - `useBuilderPhase` → session-derived via `derivePhase`
 * - `useBuilderIsReady` → session-derived
 * - `useBuilderAgentActive` → `useAgentActive`
 * - `useBuilderInReplayMode` → `useInReplayMode`
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
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
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import type { AppBlueprint, BlueprintForm } from "@/lib/schemas/blueprint";
import type { TreeData } from "@/lib/services/builder";
import {
	type BuilderState,
	type BuilderStoreApi,
	createBuilderStore,
} from "@/lib/services/builderStore";
import type { NForm, NModule, NQuestion } from "@/lib/services/normalizedState";
import { usePartialScaffold } from "@/lib/session/hooks";
import {
	BuilderSessionContext,
	BuilderSessionProvider,
} from "@/lib/session/provider";
import type { ReplayStage } from "@/lib/session/types";

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

/** True when entity data is populated (replaces `!!s.blueprint`).
 *  Delegates directly to the doc store — no legacy store dependency. */
export { useDocHasData as useBuilderHasData } from "@/lib/doc/hooks/useDocHasData";

/**
 * Merged tree data for AppTree rendering — derived from doc store entities.
 *
 * Thin wrapper around `useDocTreeData`: passes `partialScaffold` from
 * the session store as the only fallback for the brief pre-scaffold
 * window. During generation AND Ready/Completed phases, the doc hook
 * derives TreeData directly from doc entities (scaffold modules are
 * created as doc mutations by the mutation mapper).
 */
export function useBuilderTreeData(): TreeData | undefined {
	const partialScaffold = usePartialScaffold();
	return useDocTreeData(partialScaffold);
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
 *   StoreContext            — legacy Zustand store (shrinking, Phase 6 deletes)
 *   BlueprintDocProvider    — doc store (entities, undo/redo)
 *   BuilderSessionProvider  — lifecycle + ephemeral UI state
 *   ScrollRegistryProvider  — imperative scroll plumbing
 *   EditGuardProvider       — select-guard predicate stack
 *   BuilderFormEngineProvider — form preview runtime controller
 *     SyncBridge            — wires doc store ref into session store
 *     LocationRecoveryEffect — repairs stale URL selection mid-session
 *     LoadAppHydrator        — clears loading flag for existing apps
 *     ReplayHydrator         — replays emissions for replay mode
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
	/* `key={buildId}` forces a full unmount/remount of the entire provider
	 * tree when the build identity changes (`/build/A` → `/build/B`). Every
	 * nested provider gets a fresh instance, so stale cross-store references
	 * can't leak across build sessions. */
	return (
		<BuilderProviderInner
			key={buildId}
			buildId={buildId}
			replay={replay}
			initialBlueprint={initialBlueprint}
		>
			{children}
		</BuilderProviderInner>
	);
}

/**
 * Inner provider — owns the legacy store and the provider stack. Wrapped
 * by `BuilderProvider` so the `key={buildId}` swap happens at the boundary;
 * everything below this component is guaranteed to be a fresh tree per
 * build session.
 */
function BuilderProviderInner({
	buildId,
	children,
	replay,
	initialBlueprint,
}: {
	buildId: string;
	children: ReactNode;
	replay?: ReplayInit;
	initialBlueprint?: AppBlueprint;
}) {
	/* Single creation per mount. Because `BuilderProvider` keys this
	 * component on `buildId`, build-id changes remount and re-run this
	 * initializer — no need for an in-render `setState` rebuild. */
	/* The legacy store is a near-empty shell — its only purpose is providing
	 * a stable per-build identity reference. Phase 6 deletes it entirely. */
	const [store] = useState(() => createBuilderStore());

	/* Pre-compute session store init so `derivePhase` returns the correct
	 * phase on the very first render — `Loading` for existing apps and
	 * replays, `Idle` for new builds. The session store captures these
	 * values in its lazy `useState` initializer and never re-reads them. */
	const hasExistingData = Boolean(initialBlueprint || replay);
	const sessionInit = useState(() => ({
		loading: hasExistingData,
		appId: buildId === "new" ? undefined : buildId,
	}))[0];

	return (
		<StoreContext value={store}>
			<BlueprintDocProvider
				appId={buildId === "new" ? undefined : buildId}
				initialBlueprint={initialBlueprint}
				startTracking={Boolean(initialBlueprint || replay)}
			>
				<BuilderSessionProvider init={sessionInit}>
					<ScrollRegistryProvider>
						<EditGuardProvider>
							<BuilderFormEngineProvider>
								<SyncBridge />
								<LocationRecoveryEffect />
								{replay ? <ReplayHydrator replay={replay} /> : null}
								{!replay && initialBlueprint ? (
									<LoadAppHydrator buildId={buildId} />
								) : null}
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
 * ReplayHydrator — re-dispatches replay stage emissions into the doc
 * and session stores using the same `applyStreamEvent` dispatcher that
 * handles real-time streaming.
 *
 * Why a child component rather than inline in `BuilderProviderInner`?
 * Replay emissions include `data-blueprint-updated` events that call
 * `docStore.getState().load(...)`. If the hydration loop ran in
 * `BuilderProviderInner`, it would sit OUTSIDE `BlueprintDocProvider`
 * and have no way to read the doc store from context. By placing the
 * loop here, inside both `BlueprintDocContext` and
 * `BuilderSessionContext`, we can read both stores and replay
 * emissions faithfully. Edit session replays now apply correctly.
 *
 * The hydration runs once per mount (gated by `hydratedRef`) — replay
 * is immutable for the lifetime of a build session, so any later
 * re-runs would be redundant at best and corrupting at worst.
 */
function ReplayHydrator({ replay }: { replay: ReplayInit }) {
	const docStore = useContext(BlueprintDocContext);
	const sessionStore = useContext(BuilderSessionContext);
	const hydratedRef = useRef(false);

	useEffect(() => {
		if (hydratedRef.current || !docStore || !sessionStore) return;
		hydratedRef.current = true;

		/* Load the replay script into the session store so the replay
		 * controller can navigate between stages. */
		sessionStore
			.getState()
			.loadReplay(replay.stages, replay.doneIndex, replay.exitPath);

		/* Re-dispatch all emissions up to doneIndex through the standard
		 * stream dispatcher — the same code path used during real-time
		 * generation. This populates the doc store and updates session
		 * lifecycle state identically to a live build. */
		for (let i = 0; i <= replay.doneIndex; i++) {
			const stage = replay.stages[i];
			if (!stage) continue;
			for (const em of stage.emissions) {
				applyStreamEvent(em.type, em.data, docStore, sessionStore);
			}
		}

		/* Finalize the session lifecycle — the session store was seeded with
		 * `loading: true` so `derivePhase` returned `Loading` on the first
		 * render. Replay hydration is now complete (doc store populated,
		 * replay script loaded), so clear the flag to transition the phase
		 * to `Ready`. Mirrors `LoadAppHydrator` for existing-app loads —
		 * without this, `BuilderLayout` stays stuck on its Loading skeleton
		 * forever. */
		sessionStore.getState().setLoading(false);
	}, [replay, docStore, sessionStore]);

	return null;
}

/**
 * SyncBridge — installs the doc store reference on the session store
 * after the provider tree mounts. Non-React callers (e.g. `switchConnectMode`,
 * `beginAgentWrite`, `endAgentWrite`) reach the doc through this reference
 * instead of importing it directly.
 *
 * The `BuilderFormEngineProvider` installs its own doc-store reference
 * via a sibling effect; SyncBridge doesn't touch the form controller.
 */
function SyncBridge() {
	const docStore = useContext(BlueprintDocContext);
	const sessionStore = useContext(BuilderSessionContext);

	useEffect(() => {
		if (!docStore || !sessionStore) return;
		sessionStore.getState()._setDocStore(docStore);
		return () => {
			sessionStore.getState()._setDocStore(null);
		};
	}, [docStore, sessionStore]);

	return null;
}

/**
 * LoadAppHydrator — finalizes session store lifecycle for existing-app
 * loads. The session store was created with `loading=true` and `appId`
 * pre-seeded, so `derivePhase` returned `Loading` on the first render.
 * This effect clears the loading flag to transition to `Ready` (the doc
 * store was already hydrated synchronously by `BlueprintDocProvider`
 * from `initialBlueprint`, so entity data is available).
 *
 * Runs once per mount (gated by `hydratedRef`). Replay hydration uses
 * `ReplayHydrator` instead — the two paths are mutually exclusive.
 */
function LoadAppHydrator({ buildId }: { buildId: string }) {
	const sessionStore = useContext(BuilderSessionContext);
	const hydratedRef = useRef(false);

	useEffect(() => {
		if (hydratedRef.current || !sessionStore) return;
		hydratedRef.current = true;

		/* appId and loading were pre-seeded via `SessionStoreInit`, so we
		 * only need to clear loading. The appId is already correct. */
		sessionStore.getState().setAppId(buildId);
		sessionStore.getState().setLoading(false);
	}, [buildId, sessionStore]);

	return null;
}
