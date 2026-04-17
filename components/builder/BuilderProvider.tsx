/**
 * BuilderProvider — the top-level provider stack for the builder route.
 *
 * Mounts the complete provider tree for a specific buildId and hydrates
 * the session + doc stores depending on whether the session is a new build,
 * an existing-app load, or a replay.
 *
 * The provider tree (outer -> inner) is:
 *   BlueprintDocProvider        — doc store (entities, undo/redo)
 *   BuilderSessionProvider      — lifecycle + ephemeral UI state
 *   ScrollRegistryProvider      — imperative scroll plumbing
 *   EditGuardProvider           — select-guard predicate stack
 *   BuilderFormEngineProvider   — form preview runtime controller
 *     SyncBridge                — wires doc store ref into session store
 *     LocationRecoveryEffect    — repairs stale URL selection mid-session
 *     LoadAppHydrator           — clears loading flag for existing apps
 *     ReplayHydrator            — replays emissions for replay mode
 *     {children}
 *
 * Lifecycle:
 * - `/` -> `/build/{id}`: provider mounts, fresh stores, loads app
 * - `/build/A` -> `/build/B`: buildId changes, fresh stores, loads B
 * - `/build/*` -> `/`: provider unmounts, stores are garbage collected
 * - `/build/new` generation: buildId stays 'new' (replaceState), no reset
 * - `/build/replay/{id}`: replay prop provided, hydrates store with stages
 */
"use client";

import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { BlueprintDocContext, BlueprintDocProvider } from "@/lib/doc/provider";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import {
	BuilderSessionContext,
	BuilderSessionProvider,
} from "@/lib/session/provider";
import type { ReplayInit } from "@/lib/session/types";

// ── Provider ────────────────────────────────────────────────────────────

/**
 * BuilderProvider — mounts the entire builder provider stack for a
 * specific buildId and hydrates the session store.
 *
 * `key={buildId}` on the inner component forces a full unmount/remount
 * when the build identity changes, so every nested provider gets a fresh
 * instance and stale cross-store references can't leak across sessions.
 */
export function BuilderProvider({
	buildId,
	children,
	replay,
	initialDoc,
}: {
	buildId: string;
	children: ReactNode;
	replay?: ReplayInit;
	/** Server-fetched normalized doc — hydrates the doc store synchronously
	 *  in the provider so the first render sees populated entities. Firestore
	 *  now persists the normalized `BlueprintDoc` shape directly. */
	initialDoc?: PersistableDoc;
}) {
	return (
		<BuilderProviderInner
			key={buildId}
			buildId={buildId}
			replay={replay}
			initialDoc={initialDoc}
		>
			{children}
		</BuilderProviderInner>
	);
}

// ── Inner provider ──────────────────────────────────────────────────────

/**
 * Inner provider — owns the provider stack. Wrapped by `BuilderProvider`
 * so the `key={buildId}` swap happens at the boundary; everything below
 * this component is guaranteed to be a fresh tree per build session.
 */
function BuilderProviderInner({
	buildId,
	children,
	replay,
	initialDoc,
}: {
	buildId: string;
	children: ReactNode;
	replay?: ReplayInit;
	initialDoc?: PersistableDoc;
}) {
	/* Pre-compute session store init so `derivePhase` returns the correct
	 * phase on the very first render — `Loading` for existing apps and
	 * replays, `Idle` for new builds. The session store captures these
	 * values in its lazy `useState` initializer and never re-reads them. */
	const hasExistingData = Boolean(initialDoc || replay);
	const sessionInit = useState(() => ({
		loading: hasExistingData,
		appId: buildId === "new" ? undefined : buildId,
	}))[0];

	return (
		<BlueprintDocProvider
			appId={buildId === "new" ? undefined : buildId}
			initialDoc={initialDoc}
			startTracking={Boolean(initialDoc || replay)}
		>
			<BuilderSessionProvider init={sessionInit}>
				<ScrollRegistryProvider>
					<EditGuardProvider>
						<BuilderFormEngineProvider>
							<SyncBridge />
							<LocationRecoveryEffect />
							{replay ? <ReplayHydrator replay={replay} /> : null}
							{!replay && initialDoc ? <LoadAppHydrator /> : null}
							{children}
						</BuilderFormEngineProvider>
					</EditGuardProvider>
				</ScrollRegistryProvider>
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}

// ── Hydrators & bridge ──────────────────────────────────────────────────

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
function LoadAppHydrator() {
	const sessionStore = useContext(BuilderSessionContext);
	const hydratedRef = useRef(false);

	useEffect(() => {
		if (hydratedRef.current || !sessionStore) return;
		hydratedRef.current = true;

		/* appId was pre-seeded via `SessionStoreInit`; only the loading
		 * flag needs clearing to transition from Loading → Ready. */
		sessionStore.getState().setLoading(false);
	}, [sessionStore]);

	return null;
}
