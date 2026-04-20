/**
 * Reactive undo/redo availability — subscribes to zundo's temporal state
 * and exposes two booleans. Components toggle toolbar disabled states off
 * these values.
 *
 * Both hooks subscribe through `useBlueprintDocTemporal`, which uses
 * `useStoreWithEqualityFn` (zundo's recommended API) with `Object.is`
 * equality so the subscription only fires a re-render when the boolean
 * actually flips. Naively `useStore`ing the temporal store would trigger
 * on every history mutation regardless of the selected value.
 */

"use client";

import { useBlueprintDocTemporal } from "./useBlueprintDoc";

/** `true` when the doc has at least one past state available to undo into. */
export function useCanUndo(): boolean {
	return useBlueprintDocTemporal((t) => t.pastStates.length > 0);
}

/** `true` when there is at least one future state available to redo into. */
export function useCanRedo(): boolean {
	return useBlueprintDocTemporal((t) => t.futureStates.length > 0);
}
