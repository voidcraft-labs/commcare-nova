/**
 * builderStore — vestigial Zustand store from the legacy builder architecture.
 *
 * All meaningful state has migrated:
 * - Blueprint entity data → `lib/doc/store.ts` (BlueprintDoc)
 * - Generation lifecycle, app identity, replay → `lib/session/store.ts` (BuilderSession)
 * - Cursor mode, sidebars, focus hints → `lib/session/store.ts`
 *
 * The store and its context still exist because `BuilderProvider` in
 * `hooks/useBuilder.tsx` creates a `StoreContext` and exports
 * `useBuilderStore` / `useBuilderStoreShallow` / `useBuilderStoreApi`.
 * No component reads meaningful state from it anymore — the context
 * serves only as a per-build identity sentinel (its reference changes
 * when buildId changes, which the provider tree uses for remount detection).
 *
 * Phase 6 deletes this file entirely.
 */

import { createStore } from "zustand/vanilla";

// ── Store state interface ──────────────────────────────────────────────

/** Near-empty state — retained only so `useBuilderStore<T>(selector)`
 *  has a valid generic constraint. No component reads these fields. */
export interface BuilderState {
	reset: () => void;
}

// ── Store factory ──────────────────────────────────────────────────────

/** The Zustand store API type — used for context typing in BuilderProvider. */
export type BuilderStoreApi = ReturnType<typeof createBuilderStore>;

/** Create a scoped Zustand store for a builder session.
 *  Called once per buildId by BuilderProvider. The store is intentionally
 *  minimal — its only purpose is providing a stable identity reference
 *  per build session. Phase 6 deletes this entirely. */
export function createBuilderStore() {
	return createStore<BuilderState>()((_set) => ({
		reset() {
			/* No-op — nothing to reset. Retained for interface compatibility
			 * until Phase 6 removes the store. */
		},
	}));
}
