// lib/preview/caseListPhase.ts
//
// Which screen a module's case list is on. A browse-then-search module
// shows Results at once, with the Search pane beside it when the Search
// action applies. A module that opens on Search (`searchFirst`) shows the
// Search screen alone until a search completes, and Results only after,
// exactly the running app's inline search, where the search runs before
// the list exists. A search-first module with nothing visible to answer
// runs its search on its own, so it is on Results from the start.

import type { CaseQueryConstraintSource } from "@/lib/preview/engine/caseDataBindingTypes";
import type { PreviewPlatformRules } from "./platform";

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
	/** Whether a search has been submitted in this module's run: the
	 * screen's own submission, or a completed search the session holds for
	 * the module (a no-matches registration returns here after the screen
	 * may have been rebuilt). */
	readonly hasSubmitted: boolean;
	/** The submitted search's read returned no rows. */
	readonly submittedFoundNothing?: boolean;
	/** The platform Preview plays: Android keeps the search screen, with the
	 *  answers as typed, after a search that found nothing
	 *  (`QueryRequestActivity.java::processSuccess` shows a toast and the
	 *  activity does not finish). */
	readonly rules: Pick<PreviewPlatformRules, "zeroSearchResults">;
}): CaseListStep {
	if (
		args.rules.zeroSearchResults === "stay-on-search" &&
		args.hasSubmitted &&
		args.submittedFoundNothing === true
	)
		return "search";
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

/** Input-free Search launches for a Results filter or search-first entry.
 * Android never reads `auto_launch` (manifest
 * `case-search/workflow-skip-to-default-results-auto-launch-true-default-search`):
 * it shows the worker's list first, with the search action. */
export function automaticallyLaunchesSearch(args: {
	readonly relevant: boolean;
	readonly hasVisibleInputs: boolean;
	readonly searchFirst: boolean;
	readonly hasEffectiveFilter: boolean;
	readonly rules: Pick<PreviewPlatformRules, "skipToResults">;
}): boolean {
	return (
		args.rules.skipToResults &&
		args.relevant &&
		!args.hasVisibleInputs &&
		(args.searchFirst || args.hasEffectiveFilter)
	);
}
