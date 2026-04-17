/**
 * Hook for full-text search across the current blueprint.
 *
 * Returns a stable callback that reads the doc store on demand and
 * delegates to the pure `searchBlueprint` function from
 * `blueprintHelpers.ts`. The callback is safe to call from effects,
 * event handlers, or async flows — it always reads the freshest snapshot.
 *
 * The SA agent also calls `searchBlueprint` directly on its doc reference
 * (no hook needed server-side). This hook is only needed by client-side
 * callers that read from the doc store.
 */

import { useCallback, useContext } from "react";
import {
	type SearchResult,
	searchBlueprint as searchDoc,
} from "@/lib/agent/blueprintHelpers";
import { BlueprintDocContext } from "@/lib/doc/provider";

export type { SearchResult };

/**
 * Returns a stable imperative function `(query: string) => SearchResult[]`.
 *
 * The function reads the doc store's current state on every call (not at
 * hook construction) so it always searches the freshest blueprint. Returns
 * an empty array when the doc is empty (no modules).
 */
export function useSearchBlueprint(): (query: string) => SearchResult[] {
	const store = useContext(BlueprintDocContext);
	if (!store) {
		throw new Error(
			"useSearchBlueprint requires a <BlueprintDocProvider> ancestor",
		);
	}

	return useCallback(
		(query: string): SearchResult[] => {
			const doc = store.getState();
			if (doc.moduleOrder.length === 0) return [];
			return searchDoc(doc, query);
		},
		[store],
	);
}
