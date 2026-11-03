// lib/preview/caseListPhase.ts
//
// Which screen a module's case list is on. The author's search workflow
// (`caseSearchConfig.workflow`, `moduleSearchWorkflow`) says what a worker
// sees first, and the platform decides whether it applies: Web Apps launches
// the case list's Search action on its own for search first and skip to
// results (Core's cli `EntityScreen.evaluateAutoLaunch`, which Formplayer
// runs), and Android holds no reader of `auto_launch`, so it opens the
// worker's list with the Search action. A menu whose forms read the search
// (CommCare's inline search, which only an app declaring Web Apps alone can
// hold) has no list before its search runs.

import type { SearchWorkflow } from "@/lib/domain";
import type { CaseQueryConstraintSource } from "@/lib/preview/engine/caseDataBindingTypes";
import type { PreviewPlatformRules } from "./platform";

export type CaseListStep =
	/** The worker's list: Results now, Search beside it when relevant. */
	| "browse"
	/** Only the Search screen; no results query has run. */
	| "search"
	/** Results of a search; the Search screen is behind Search again. */
	| "results";

export function caseListStep(args: {
	/** The module's workflow; undefined where it has no effective ordinary search. */
	readonly workflow: SearchWorkflow | undefined;
	/** The menu's forms read the search (`moduleFormsReadSearch`). */
	readonly formsReadSearch: boolean;
	/** The Search button's display condition holds (or there is none). */
	readonly searchRelevant: boolean;
	/** Whether a search has been submitted in this module's run: the
	 * screen's own submission, or a completed search the session holds for
	 * the module (a case list registration returns here after the screen
	 * may have been rebuilt). */
	readonly hasSubmitted: boolean;
	/** The submitted search's read returned no rows. */
	readonly submittedFoundNothing?: boolean;
	/** The worker pressed Search again on Results and has not searched since:
	 *  skip to results then shows the Search screen, since the Web Apps client
	 *  asks for the query screen with a forced manual search
	 *  (`MenuSessionRunnerService.java::handleQueryScreen`, `autoSearch` is
	 *  `doDefaultSearch() && !forceManualSearch`). */
	readonly searchReopened?: boolean;
	/** Android keeps the search screen, with the answers as typed, after a
	 *  search that found nothing (`QueryRequestActivity.java::processSuccess`
	 *  shows a toast and the activity does not finish); Web Apps alone
	 *  launches the Search action on its own (`searchActionAutoLaunch`). */
	readonly rules: Pick<
		PreviewPlatformRules,
		"zeroSearchResults" | "searchActionAutoLaunch"
	>;
}): CaseListStep {
	if (
		args.rules.zeroSearchResults === "stay-on-search" &&
		args.hasSubmitted &&
		args.submittedFoundNothing === true
	)
		return "search";
	if (args.workflow === undefined) return "browse";
	/* Forms that read the search: the search runs before the list exists.
	 * Skip to results runs the default search as the menu opens; search
	 * first shows the Search screen, with only its Search button when no
	 * field is visible, until a search is submitted. */
	if (args.formsReadSearch && args.workflow !== "listFirst")
		return opensOn(args.workflow, args);
	if (
		args.rules.searchActionAutoLaunch &&
		args.searchRelevant &&
		args.workflow !== "listFirst"
	)
		return opensOn(args.workflow, args);
	return "browse";
}

function opensOn(
	workflow: Exclude<SearchWorkflow, "listFirst">,
	run: { readonly hasSubmitted: boolean; readonly searchReopened?: boolean },
): CaseListStep {
	if (run.hasSubmitted) return "results";
	if (workflow === "skipToResults" && run.searchReopened !== true)
		return "results";
	return "search";
}

/**
 * How an empty result reads. On the `results` step every result is the
 * outcome of a search the worker ran or the menu ran on opening, so an unconstrained empty answer
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
