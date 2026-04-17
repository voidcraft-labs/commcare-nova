/**
 * useAncestors — walk fieldParent from a field up to its containing form.
 *
 * Returns the ancestor chain as an ordered array of uuids, from the
 * immediate parent down to the form root. Does not include `fieldUuid`
 * itself. The array is empty when the field is at the top level of a form
 * (its direct parent IS the form, but iterating stops at null).
 *
 * Example: field C nested under group B nested under form F:
 *   useAncestors(C) → [B, F]
 *
 * Subscription strategy: subscribes to the entire `fieldParent` map via a
 * reference-stable selector. The memo recomputes only when the parentIndex
 * reference changes (i.e., when any structural mutation fires). This is
 * acceptable because structural mutations are infrequent and the walk is O(depth),
 * which is bounded by form nesting depth (typically ≤ 3 levels).
 */

import { useMemo } from "react";
import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDoc } from "./useBlueprintDoc";

/**
 * Walks `fieldParent` from `fieldUuid` upward, returning the chain from
 * immediate parent to the containing form. Does not include the field itself.
 */
export function useAncestors(fieldUuid: Uuid): Uuid[] {
	const parentIndex = useBlueprintDoc((s) => s.fieldParent);
	return useMemo(() => {
		const chain: Uuid[] = [];
		let current: Uuid | null = parentIndex[fieldUuid] ?? null;
		while (current) {
			chain.push(current);
			current = parentIndex[current] ?? null;
		}
		return chain;
	}, [fieldUuid, parentIndex]);
}
