/**
 * Low-level store subscription hooks.
 *
 * These three hooks are the ONLY place components can talk to the
 * BlueprintDoc store. Everything else in the codebase imports a named
 * domain hook from `lib/doc/hooks/**` and lets it handle the subscription
 * shape and memoization.
 *
 * Phase 6 enforces this rule via a Biome `noRestrictedImports` lint rule:
 * imports of this file from outside `lib/doc/hooks/**` will fail the build.
 *
 * The store instance comes from `BlueprintDocContext` (Phase 1b). Calling
 * any of these hooks outside a `<BlueprintDocProvider>` throws.
 */

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
