/**
 * useDocHasData — true when the doc store has at least one module.
 *
 * The selector returns a boolean primitive, so `Object.is` comparison
 * in `useBlueprintDoc` is sufficient — no shallow wrapper needed.
 *
 * The predicate itself lives in `lib/doc/predicates.ts` so it can be
 * shared with non-React callers (subscription callbacks, tests) without
 * duplicating the "what counts as having data?" definition.
 */

import { docHasData } from "../predicates";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** True when entity data is populated (at least one module exists). */
export function useDocHasData(): boolean {
	return useBlueprintDoc(docHasData);
}
