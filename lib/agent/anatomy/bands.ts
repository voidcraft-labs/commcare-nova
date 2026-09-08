/**
 * The two bands of a moment's weight. Client-safe on purpose: the token bar
 * draws the same split the estimator sums.
 */

import type { ContextItem } from "./types";

/** Which band an item belongs to: the static part the provider caches
 * across calls, or the per-turn variable part. A missing item sits where its
 * piece would (the variable band) and weighs nothing. */
export function bandOf(kind: ContextItem["kind"]): "static" | "variable" {
	switch (kind) {
		case "system":
		case "tools":
		case "output-schema":
			return "static";
		case "message":
		case "compaction":
		case "missing":
			return "variable";
	}
}
