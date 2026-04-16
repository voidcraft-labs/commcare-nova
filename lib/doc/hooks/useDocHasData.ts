/**
 * useDocHasData — true when the doc store has at least one module.
 *
 * The selector returns a boolean primitive, so `Object.is` comparison
 * in `useBlueprintDoc` is sufficient — no shallow wrapper needed.
 */

import { useBlueprintDoc } from "./useBlueprintDoc";

/** True when entity data is populated (at least one module exists). */
export function useDocHasData(): boolean {
	return useBlueprintDoc((s) => s.moduleOrder.length > 0);
}
