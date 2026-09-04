/**
 * How a settled Results load reads as a search outcome.
 *
 * The running case list asks the same `loadCasesAction` for a search as
 * for a browse; what makes the answer a SEARCH outcome is the module's
 * search state, kept in the builder session (`lib/session/previewSearchState.ts`).
 * This is the one mapping from the load's discriminated result to that
 * state's settlement: a settled row set or empty answer completes the
 * search with its match count, a deterministic or transport failure fails
 * it, and an in-flight load settles nothing.
 */

import type { PreviewSearchOutcome } from "@/lib/session/previewSearchState";
import type { LoadCasesResult } from "./caseDataBindingTypes";

export type SearchLoadState =
	| LoadCasesResult
	| { readonly kind: "idle" }
	| { readonly kind: "loading" };

export function searchOutcomeFromLoad(
	state: SearchLoadState,
): PreviewSearchOutcome | undefined {
	switch (state.kind) {
		case "rows":
			return {
				kind: "completed",
				matchCount: state.totalCount ?? state.rows.length,
			};
		case "empty":
			return { kind: "completed", matchCount: 0 };
		case "invalid-search":
		case "error":
		case "unauthenticated":
		case "persona-unavailable":
			return { kind: "failed", reason: state.kind };
		case "idle":
		case "loading":
			return undefined;
	}
}
