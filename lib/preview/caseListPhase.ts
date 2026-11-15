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

/**
 * The step the running list shows while the Search action's condition may be
 * undecided: the session is still waiting for its worker, or its lookup
 * tables are still loading. Where the step depends on that condition (Web
 * Apps launching the Search action on its own) the screen `waiting`s,
 * showing neither the worker's list nor the Search screen nor Results: Core
 * decides the step from the condition before it shows any of them
 * (`EntityScreen.evaluateAutoLaunch`), so a list drawn before the condition
 * is decided is one no device shows. Where the step does not depend on it,
 * the step is the one the condition cannot change.
 */
export function caseListScreenStep(
	args: Omit<Parameters<typeof caseListStep>[0], "searchRelevant"> & {
		readonly searchRelevant: boolean | "undecided";
	},
): CaseListStep | "waiting" {
	if (args.searchRelevant !== "undecided") {
		return caseListStep({ ...args, searchRelevant: args.searchRelevant });
	}
	const ifRelevant = caseListStep({ ...args, searchRelevant: true });
	const ifNot = caseListStep({ ...args, searchRelevant: false });
	return ifRelevant === ifNot ? ifRelevant : "waiting";
}

/**
 * Whether the list's Results query runs on this step. The Search screen and
 * a waiting screen have no list. Results with nothing submitted are the menu
 * opening on its default search (skip to results), which has not launched
 * yet: their rows are the default search's, carrying its hidden values, so
 * nothing is read before it runs. Results of a case a registration just
 * created read that case.
 */
export function caseListReadsResults(
	step: CaseListStep | "waiting",
	run: {
		readonly hasSubmitted: boolean;
		readonly readsRegisteredCase: boolean;
	},
): boolean {
	if (step === "browse") return true;
	if (step === "results") return run.hasSubmitted || run.readsRegisteredCase;
	return false;
}

/**
 * Whether the list runs its default search now: the step is Results with
 * nothing submitted (skip to results), the screen is the worker's, and no
 * registered case is what Results read. A search that still stands on the
 * screen (history returning to the list, `lib/preview/searchStanding.ts`),
 * whether its menu's forms read it or a Search action ran it, is that list's
 * standing query, which the screen takes back with its own answers rather
 * than replacing it with the default search: Web Apps sends the query data
 * its address still holds
 * with the request that shows the screen again, and Formplayer answers the
 * prompts from them before it runs the query
 * (`MenuSessionRunnerService.java::handleQueryScreen`, `answerQueryPrompts`
 * over `QueryData.getInputs`, then `doQuery`). A submission holds none: the
 * client clears the address's query data on it (`utils.js::CloudcareUrl.onSubmit`)
 * and Formplayer goes on to the next screen with empty query data
 * (`resolveFormGetNext`), so a list a form's return opens runs its default
 * search again (`FormScreen`'s `letSubmittedSearchesGo`), as App Tests'
 * return does (`app-tests/submission.ts`, `enterAppTestMenu`).
 */
export function caseListLaunchesDefaultSearch(args: {
	readonly step: CaseListStep | "waiting";
	readonly hasSubmitted: boolean;
	/** The session is still waiting for its worker. */
	readonly pending: boolean;
	/** The Search screen refused as it opened (a read of data the worker's
	 *  device lacks): Core's query manager fails as Formplayer's query screen
	 *  is built, before `handleQueryScreen` runs any default search
	 *  (`QueryScreen.init`), so none runs. */
	readonly refused: boolean;
	readonly readsRegisteredCase: boolean;
	/** The session holds this list's search where it stands (an attempt of
	 *  a menu whose forms read it, or a Search action's search), which the
	 *  screen restores; a Search screen asked for again holds none. */
	readonly standingSearch: boolean;
}): boolean {
	return (
		args.step === "results" &&
		!args.hasSubmitted &&
		!args.pending &&
		!args.refused &&
		!args.readsRegisteredCase &&
		!args.standingSearch
	);
}

/**
 * The opening of a menu whose default search runs now, or `undefined` where
 * none runs (`caseListLaunchesDefaultSearch`). It names the Preview session
 * (`previewSessionId`) beside the menu's search settings, because Formplayer
 * runs the default search each time a session's query screen is built
 * (`MenuSessionRunnerService.java::handleQueryScreen`: `autoSearch` is
 * `doDefaultSearch() && !forceManualSearch`): a new worker, platform or
 * Preview run on the same menu, settings unchanged, is a new opening. The
 * hidden inputs' identity is a setting, since the device seeds them on every
 * query-screen build.
 */
export function caseListDefaultSearchOpening(args: {
	readonly launches: boolean;
	readonly session: string;
	readonly settings: Readonly<Record<string, unknown>>;
}): string | undefined {
	return args.launches
		? JSON.stringify({ session: args.session, ...args.settings })
		: undefined;
}

/**
 * One pass of the screen's default-search launch: launch once per opening.
 * The same opening seen again (React's development effect replay, an
 * unrelated render) launches nothing; a pass with no opening (the list holds
 * a search, or is refused) forgets the last, so the next opening launches
 * even with unchanged settings: a search let go, or a refusal lifted, is the
 * menu opening on its default search again.
 */
export function caseListDefaultSearchLaunch(
	launched: string | undefined,
	opening: string | undefined,
): { readonly launched: string | undefined; readonly launch: boolean } {
	if (opening === undefined) return { launched: undefined, launch: false };
	if (launched === opening) return { launched, launch: false };
	return { launched: opening, launch: true };
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
	step: CaseListStep | "waiting",
	source: CaseQueryConstraintSource,
): CaseQueryConstraintSource {
	if (step === "results" && source === "unconstrained") return "worker-search";
	return source;
}
