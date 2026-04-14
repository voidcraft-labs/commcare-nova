/**
 * useDocHasData — true when the doc store has at least one module.
 *
 * Replaces `selectHasData` from the legacy builderSelectors. Reads
 * directly from the doc store, so no dependency on the mirrored entity
 * maps in the legacy builder store.
 *
 * The selector returns a boolean primitive, so `Object.is` comparison
 * in `useBlueprintDoc` is sufficient — no shallow wrapper needed.
 */

import { useBlueprintDoc } from "./useBlueprintDoc";

/** True when entity data is populated (at least one module exists). */
export function useDocHasData(): boolean {
	return useBlueprintDoc((s) => s.moduleOrder.length > 0);
}
