/**
 * BuilderProvider — the top-level provider stack for the builder route.
 *
 * Mounts the complete provider tree for a specific buildId and hydrates
 * the session + doc stores depending on whether the session is a new build
 * or an existing-app load.
 *
 * The provider tree (outer -> inner) is:
 *   BlueprintDocProvider        — doc store (entities, undo/redo)
 *   BuilderSessionProvider      — lifecycle + ephemeral UI state
 *   ScrollRegistryProvider      — imperative scroll plumbing
 *   EditGuardProvider           — select-guard predicate stack
 *   CaseListWorkspaceProvider   — the single case-list workspace controller,
 *                                 shared by the center canvas + the right rail
 *   BuilderFormEngineProvider   — form preview runtime controller
 *     SyncBridge                — wires doc store ref into session store
 *     LocationRecoveryEffect    — repairs stale URL selection mid-session
 *     LoadAppHydrator           — clears loading flag for existing apps
 *     {children}
 *
 * Lifecycle:
 * - `/` -> `/build/{id}`: provider mounts, fresh stores, loads app
 * - `/build/A` -> `/build/B`: buildId changes, fresh stores, loads B
 * - `/build/*` -> `/`: provider unmounts, stores are garbage collected
 * - `/build/new` generation: buildId stays 'new' (replaceState), no reset
 */
"use client";

import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { CaseListWorkspaceProvider } from "@/components/builder/case-list-config/CaseListConfigWorkspace";
import { EditGuardProvider } from "@/components/builder/contexts/EditGuardContext";
import { ScrollRegistryProvider } from "@/components/builder/contexts/ScrollRegistryContext";
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
import { PresenceProvider } from "@/lib/collab/PresenceProvider";
import { ReconcilerProvider } from "@/lib/collab/ReconcilerProvider";
import {
	BlueprintDocContext,
	BlueprintDocProvider,
	BlueprintEditableContext,
} from "@/lib/doc/provider";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { BuilderFormEngineProvider } from "@/lib/preview/engine/provider";
import { useCanEdit } from "@/lib/session/hooks";
import {
	BuilderSessionContext,
	BuilderSessionProvider,
} from "@/lib/session/provider";

/** Existing-app data captured in one authorized server transaction. Keeping
 *  the cursor and capability tuple in one prop prevents independently stale
 *  RSC values from becoming separate client authorities. */
export interface InitialBuilderAccess {
	readonly projectId: string;
	readonly role: string;
	readonly canEdit: boolean;
	readonly baseSeq: number;
}

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
	initialDoc,
	initialAccess,
	userId,
}: {
	buildId: string;
	children: ReactNode;
	/** Server-fetched normalized doc — hydrates the doc store synchronously
	 *  in the provider so the first render sees populated entities. Persisted
	 *  as the normalized `BlueprintDoc` shape directly. */
	initialDoc?: PersistableDoc;
	/** Atomic Project capability + cursor snapshot. Omitted for a new build,
	 *  whose reconciler is dormant until creation. */
	initialAccess?: InitialBuilderAccess;
	/** The session user id — the reconciler's echo classification keys on it. */
	userId?: string;
}) {
	return (
		<BuilderProviderInner
			key={buildId}
			buildId={buildId}
			initialDoc={initialDoc}
			initialAccess={initialAccess}
			userId={userId}
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
	initialDoc,
	initialAccess,
	userId,
}: {
	buildId: string;
	children: ReactNode;
	initialDoc?: PersistableDoc;
	initialAccess?: InitialBuilderAccess;
	userId?: string;
}) {
	/* Pre-compute session store init so `derivePhase` returns the correct
	 * phase on the very first render — `Loading` for existing apps, `Idle`
	 * for new builds. The session store captures these values in its lazy
	 * `useState` initializer and never re-reads them. */
	const hasExistingData = Boolean(initialDoc);
	const sessionInit = useState(() => ({
		loading: hasExistingData,
		appId: buildId === "new" ? undefined : buildId,
		projectId: initialAccess?.projectId,
		role: initialAccess?.role,
		canEdit: initialAccess?.canEdit ?? true,
	}))[0];

	/* The builder provider stack below the two stores, wrapped in
	 * `ReconcilerProvider` (which reads both stores + owns the single
	 * reconciler + EventSource). */
	const inner = (
		<ScrollRegistryProvider>
			<EditGuardProvider>
				<CaseListWorkspaceProvider>
					<BuilderFormEngineProvider>
						<SyncBridge />
						<LocationRecoveryEffect />
						{initialDoc ? <LoadAppHydrator /> : null}
						{children}
					</BuilderFormEngineProvider>
				</CaseListWorkspaceProvider>
			</EditGuardProvider>
		</ScrollRegistryProvider>
	);

	return (
		<BlueprintDocProvider
			appId={buildId === "new" ? undefined : buildId}
			initialDoc={initialDoc}
			startTracking={Boolean(initialDoc)}
		>
			<BuilderSessionProvider init={sessionInit}>
				<BlueprintEditableBridge>
					<ReconcilerProvider
						appId={buildId === "new" ? undefined : buildId}
						baseSeq={initialAccess?.baseSeq ?? 0}
						userId={userId ?? ""}
					>
						{/* The presence layer rides the reconciler's single
						 *  EventSource (`subscribePresence`) and reads `useLocation`,
						 *  so it mounts inside the reconciler + below the stores.
						 *  It reads the LIVE app id from the session store (not
						 *  `buildId`), so a new build's creator heartbeats the instant
						 *  the SA mints the app. */}
						<PresenceProvider userId={userId ?? ""}>{inner}</PresenceProvider>
					</ReconcilerProvider>
				</BlueprintEditableBridge>
			</BuilderSessionProvider>
		</BlueprintDocProvider>
	);
}

/** Reactive edit gate for every mutation hook. The session's access tuple is
 *  the only authority; a reload can pause, downgrade, or restore editing
 *  without remounting the document store. */
function BlueprintEditableBridge({ children }: { children: ReactNode }) {
	const canEdit = useCanEdit();
	return (
		<BlueprintEditableContext.Provider value={canEdit}>
			{children}
		</BlueprintEditableContext.Provider>
	);
}

// ── Hydrators & bridge ──────────────────────────────────────────────────

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
 * Runs once per mount (gated by `hydratedRef`).
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
