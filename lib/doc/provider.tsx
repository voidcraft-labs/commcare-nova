/**
 * BlueprintDoc React context + provider.
 *
 * Creates a new store instance per mount (matching the existing
 * `useBuilder.tsx` pattern — the builder is a singleton per route, but
 * the store itself is not a module-level global). Consumers access the
 * store via the hooks under `lib/doc/hooks/**`.
 *
 * Phase 0 added the Phase 0 types; Phase 1a builds the store and hooks
 * behind this provider; Phase 1b wires the provider into the builder
 * route layout.
 */

"use client";

import { createContext, type ReactNode, useRef } from "react";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

// Re-export the store type so hooks can import it from a stable module path
// without creating a circular import through store.ts.
export type BlueprintDocStore = ReturnType<typeof createBlueprintDocStore>;

export const BlueprintDocContext = createContext<BlueprintDocStore | null>(
	null,
);

export interface BlueprintDocProviderProps {
	/**
	 * The blueprint to load on mount. If `undefined`, the provider creates
	 * an empty doc — useful for pre-generation states (Phase 1b's `Idle`
	 * phase before the SA has produced a scaffold).
	 */
	initialBlueprint?: AppBlueprint;
	/** The app's Firestore document ID. Attached to the doc's `appId`. */
	appId: string;
	/**
	 * Whether to begin with undo tracking active. Defaults to `true` —
	 * meaning the first user edit after load is undoable. Agent streams
	 * should pass `false`, then call `endAgentWrite()` after the stream
	 * completes.
	 */
	startTracking?: boolean;
	children: ReactNode;
}

export function BlueprintDocProvider({
	initialBlueprint,
	appId,
	startTracking = true,
	children,
}: BlueprintDocProviderProps) {
	// useRef ensures the store is created exactly once per mount, regardless of
	// how many times the parent re-renders. Avoids the useEffect-based pattern
	// which would create a store on the first render and then immediately replace
	// it on mount, causing a flash of empty state.
	const storeRef = useRef<BlueprintDocStore>(null);

	if (!storeRef.current) {
		const store = createBlueprintDocStore();
		if (initialBlueprint) {
			store.getState().load(initialBlueprint, appId);
		} else {
			// Empty-doc branch still needs to know its app identity so consumers
			// that read `doc.appId` (routing, persistence, telemetry) don't see
			// an empty string before any blueprint arrives. This is the path
			// Phase 1b takes during the `Idle` phase — the provider mounts
			// before the SA has produced a scaffold, and we need `appId` from
			// the URL immediately.
			store.setState((s) => {
				s.appId = appId;
			});
		}
		// Start tracking unless explicitly disabled. Agent write streams pass
		// `false` here and call `endAgentWrite()` when the stream completes,
		// collapsing the entire agent output into one undoable snapshot.
		if (startTracking) {
			store.temporal.getState().resume();
		}
		storeRef.current = store;
	}

	return (
		<BlueprintDocContext.Provider value={storeRef.current}>
			{children}
		</BlueprintDocContext.Provider>
	);
}
