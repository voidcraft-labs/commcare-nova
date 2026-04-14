/**
 * BuilderSessionProvider — scoped context for the BuilderSession store.
 *
 * Creates a single `BuilderSessionStore` per provider mount. The parent
 * provider's `buildId` controls the lifetime — when the builder navigates
 * to a different app, the session store is garbage collected along with
 * the rest of the provider tree.
 *
 * Exposes two context-bound hooks:
 * - `useBuilderSession(selector)` — `Object.is` equality (primitives, actions).
 * - `useBuilderSessionShallow(selector)` — shallow equality (object slices).
 *
 * These are the only way to subscribe to session state. Named domain hooks
 * in `hooks.tsx` wrap them for ergonomic call sites — components never call
 * `useBuilderSession` with an inline selector.
 */
"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import { useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
	type BuilderSessionState,
	type BuilderSessionStoreApi,
	createBuilderSessionStore,
	type SessionStoreInit,
} from "./store";

// ── Context ───────────────────────────────────────────────────────────────

/** Exported for cross-store wiring in SyncBridge — components should use
 *  the `useBuilderSession*` hooks, not this context directly. */
export const BuilderSessionContext =
	createContext<BuilderSessionStoreApi | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────

export function BuilderSessionProvider({
	children,
	init,
}: {
	children: ReactNode;
	/** Optional initial overrides for lifecycle fields that must be correct
	 *  on the first render — forwarded to `createBuilderSessionStore`. */
	init?: SessionStoreInit;
}) {
	/* Store created once per mount — no hot-swap needed. The parent
	 * `BuilderProvider` unmounts + remounts on buildId change, giving
	 * each session a fresh store automatically. `init` is captured by the
	 * lazy initializer and never re-read on subsequent renders. */
	const [store] = useState(() => createBuilderSessionStore(init));
	return (
		<BuilderSessionContext value={store}>{children}</BuilderSessionContext>
	);
}

// ── Context-bound hooks ───────────────────────────────────────────────────

/** Subscribe to a slice of session state with `Object.is` equality.
 *  Use for primitives and stable-reference values (actions). */
export function useBuilderSession<T>(
	selector: (s: BuilderSessionState) => T,
): T {
	const store = useContext(BuilderSessionContext);
	if (!store) {
		throw new Error(
			"useBuilderSession must be used within BuilderSessionProvider",
		);
	}
	return useStore(store, selector);
}

/** Subscribe to a slice of session state with shallow equality.
 *  Use when the selector returns a new object of primitives each call
 *  (e.g. `{ open, stashed }`) — shallow equality prevents re-renders
 *  when the individual values haven't changed. */
export function useBuilderSessionShallow<T>(
	selector: (s: BuilderSessionState) => T,
): T {
	const store = useContext(BuilderSessionContext);
	if (!store) {
		throw new Error(
			"useBuilderSessionShallow must be used within BuilderSessionProvider",
		);
	}
	return useStoreWithEqualityFn(store, selector, shallow);
}

/** Imperative access to the raw session store API — read/write via
 *  `storeApi.getState()` without subscribing to re-renders. Use in
 *  effect-time snapshots, callback closures, and non-React callers
 *  (e.g. generation stream handlers). */
export function useBuilderSessionApi(): BuilderSessionStoreApi {
	const store = useContext(BuilderSessionContext);
	if (!store) {
		throw new Error(
			"useBuilderSessionApi must be used within BuilderSessionProvider",
		);
	}
	return store;
}
