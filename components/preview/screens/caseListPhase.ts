// components/preview/screens/caseListPhase.ts
//
// Which screen a module's case list is on. A browse-then-search module
// shows Results at once, with the Search pane beside it when the Search
// action applies. A module that opens on Search (`searchFirst`) shows the
// Search screen alone until a search completes, and Results only after,
// exactly the running app's inline search, where the search runs before
// the list exists. A search-first module with nothing visible to answer
// runs its search on its own, so it is on Results from the start.

import type { CaseQueryConstraintSource } from "@/lib/preview/engine/caseDataBindingTypes";

export type CaseListStep =
	/** The ordinary composition: Results now, Search beside it when relevant. */
	| "browse"
	/** Only the Search screen; no results query has run. */
	| "search"
	/** Results of a completed search; the Search screen is behind Search again. */
	| "results";

export function caseListStep(args: {
	/** `caseSearchConfig.searchFirst` on an effective Search config. */
	readonly searchFirst: boolean;
	/** Whether the module has a visible prompt for a worker to answer. */
	readonly hasVisibleInputs: boolean;
	/** Whether a search has been submitted in this module's run. */
	readonly hasSubmitted: boolean;
}): CaseListStep {
	if (!args.searchFirst) return "browse";
	if (!args.hasVisibleInputs) return "results";
	return args.hasSubmitted ? "results" : "search";
}

/**
 * How an empty result reads. On a search-first module every result is the
 * outcome of a search the worker ran, so an unconstrained empty answer
 * (every prompt left blank) still reads as "nothing matched this search"
 * rather than an invitation to add case data, while the authored-rules arm
 * keeps naming the rules that emptied it.
 */
export function resultsConstraintContext(
	step: CaseListStep,
	source: CaseQueryConstraintSource,
): CaseQueryConstraintSource {
	if (step === "results" && source === "unconstrained") return "worker-search";
	return source;
}
