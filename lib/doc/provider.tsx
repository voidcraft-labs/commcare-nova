/**
 * BlueprintDoc React context + provider.
 *
 * Creates a new store instance per mount — the builder is a singleton
 * per route, but the store is not a module-level global. Consumers
 * access the store via the named hooks under `lib/doc/hooks/**`; the
 * raw context is exported only so those hooks can read it.
 */

"use client";

import { createContext, type ReactNode, useRef } from "react";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { PersistableDoc } from "@/lib/domain/blueprint";

// Re-export the store type so hooks can import it from a stable module path
// without creating a circular import through store.ts.
export type BlueprintDocStore = ReturnType<typeof createBlueprintDocStore>;

export const BlueprintDocContext = createContext<BlueprintDocStore | null>(
	null,
);

/**
 * Whether the user-edit mutation path is enabled for this doc. `true`
 * everywhere by default; the builder sets it `false` for a view-only member
 * so `useBlueprintMutations` inertly no-ops every gated dispatch (the single
 * choke point that makes the whole canvas read-only — see `useCanEdit`). The
 * agent-stream / replay / hydration writers bypass `useBlueprintMutations`
 * and so are unaffected, which is correct: a viewer triggers neither.
 */
export const BlueprintEditableContext = createContext<boolean>(true);

export interface BlueprintDocProviderProps {
	/**
	 * The on-disk doc to load on mount. Accepts the persisted
	 * `PersistableDoc` shape (no `fieldParent` — that field is computed and
	 * never stored). If `undefined`, the provider creates an empty doc for
	 * the `Idle` phase before the SA has produced a scaffold.
	 *
	 * `load()` rebuilds the `fieldParent` reverse index from `fieldOrder`
	 * so callers don't need to supply it.
	 */
	initialDoc?: PersistableDoc;
	/**
	 * The app's document ID. `undefined` for brand-new apps
	 * before generation produces an ID; the doc's `appId` starts as ""
	 * and is populated when the app is persisted.
	 */
	appId?: string;
	/**
	 * Whether to begin with undo tracking active. Defaults to `true` —
	 * meaning the first user edit after load is undoable. Agent streams
	 * should pass `false`, then call `endAgentWrite()` after the stream
	 * completes.
	 */
	startTracking?: boolean;
	/**
	 * Whether the user may edit this doc. Defaults to `true`. A view-only
	 * Project member passes `false` so every `useBlueprintMutations` dispatch
	 * no-ops (provided through {@link BlueprintEditableContext}).
	 */
	canEdit?: boolean;
	children: ReactNode;
}

export function BlueprintDocProvider({
	initialDoc,
	appId,
	startTracking = true,
	canEdit = true,
	children,
}: BlueprintDocProviderProps) {
	// useRef ensures the store is created exactly once per mount, regardless of
	// how many times the parent re-renders. Avoids the useEffect-based pattern
	// which would create a store on the first render and then immediately replace
	// it on mount, causing a flash of empty state.
	const storeRef = useRef<BlueprintDocStore>(null);

	// Brand-new apps pass `undefined` — fall back to "" so the doc always has
	// a string `appId`. The real ID is populated when the app is persisted.
	const effectiveAppId = appId ?? "";

	if (!storeRef.current) {
		const store = createBlueprintDocStore();
		if (initialDoc) {
			// `load()` rebuilds the fieldParent index from fieldOrder so it is
			// always correct even if the persisted document omitted it.
			store.getState().load(initialDoc);
		} else {
			// Empty-doc branch still needs to know its app identity so consumers
			// that read `doc.appId` (routing, persistence, telemetry) don't see
			// an empty string before any blueprint arrives. This is the path
			// taken during the `Idle` phase — the provider mounts before the SA
			// has produced a scaffold, and we need `appId` from the URL immediately.
			store.setState((s) => {
				s.appId = effectiveAppId;
			});
		}
		// Start tracking unless explicitly disabled. The store owns undo
		// tracking through a suppression-depth counter (see store.ts): the
		// live builder releases the birth pause (depth 1 → 0) via the store's
		// `startTracking()`. A fresh build passes `false` here (it generates
		// first) and calls `startTracking()` when its first run ends —
		// `ChatContainer` drives that so undo works post-build without a page
		// reload. A replay mount never tracks.
		if (startTracking) {
			store.getState().startTracking();
		}
		storeRef.current = store;
	}

	return (
		<BlueprintDocContext.Provider value={storeRef.current}>
			<BlueprintEditableContext.Provider value={canEdit}>
				{children}
			</BlueprintEditableContext.Provider>
		</BlueprintDocContext.Provider>
	);
}
