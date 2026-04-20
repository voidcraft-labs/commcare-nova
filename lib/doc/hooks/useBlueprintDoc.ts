/**
 * Low-level store subscription hooks.
 *
 * These three hooks are the ONLY place components can talk to the
 * BlueprintDoc store. Everything else in the codebase imports a named
 * domain hook from `lib/doc/hooks/**` and lets it handle the subscription
 * shape and memoization.
 *
 * A Biome `noRestrictedImports` lint rule enforces this boundary: imports
 * of `@/lib/doc/store` from `components/` or `app/` code fail the build.
 *
 * The store instance comes from `BlueprintDocContext` (Phase 1b). Calling
 * any of these hooks outside a `<BlueprintDocProvider>` throws.
 */

"use client";

import { useContext } from "react";
import type { TemporalState } from "zundo";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import type { BlueprintDocState } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";

/** Throw with a helpful message if the provider is missing. */
function useStoreInstance(): BlueprintDocStore {
	const store = useContext(BlueprintDocContext);
	if (!store) {
		throw new Error(
			"BlueprintDoc hooks require a <BlueprintDocProvider> ancestor",
		);
	}
	return store;
}

/**
 * Subscribe to a slice of the BlueprintDoc via a selector. Re-renders only
 * when the selected value changes (reference equality via `Object.is`).
 */
export function useBlueprintDoc<T>(selector: (s: BlueprintDocState) => T): T {
	const store = useStoreInstance();
	return useStore(store, selector);
}

/**
 * Subscribe with shallow equality — use when the selector returns a plain
 * object whose fields are primitives or stable references. Prevents
 * re-render on identity changes that don't affect any selected field.
 */
export function useBlueprintDocShallow<T>(
	selector: (s: BlueprintDocState) => T,
): T {
	const store = useStoreInstance();
	return useStore(store, useShallow(selector));
}

/**
 * Subscribe with a caller-supplied equality function. Use when the selector
 * returns a value whose default `Object.is` comparison would over-trigger
 * re-renders (e.g. an array that is structurally unchanged but allocated
 * anew because an ancestor map was rewritten by Immer).
 *
 * zustand's `useStore` hard-codes `Object.is`; this wrapper delegates to
 * `useStoreWithEqualityFn` (zustand/traditional) which threads a custom
 * comparator through the subscription.
 */
export function useBlueprintDocEq<T>(
	selector: (s: BlueprintDocState) => T,
	equalityFn: (a: T, b: T) => boolean,
): T {
	const store = useStoreInstance();
	return useStoreWithEqualityFn(store, selector, equalityFn);
}

/**
 * Imperative access to the raw doc store API — read/write via
 * `storeApi.getState()` without subscribing to re-renders. Use in
 * effect-time snapshots, callback closures, test harness setup, and
 * non-React callers that need the store reference.
 */
export function useBlueprintDocApi(): BlueprintDocStore {
	return useStoreInstance();
}

/**
 * Subscribe to zundo's temporal state (undo/redo history). Uses
 * `useStoreWithEqualityFn` (zundo's recommended API) — the default
 * `useStore` re-renders on every temporal change regardless of selector.
 */
export function useBlueprintDocTemporal<T>(
	selector: (t: TemporalState<BlueprintDoc>) => T,
	equalityFn?: (a: T, b: T) => boolean,
): T {
	const store = useStoreInstance();
	return useStoreWithEqualityFn(
		store.temporal,
		(t) => selector(t as TemporalState<BlueprintDoc>),
		equalityFn,
	);
}
