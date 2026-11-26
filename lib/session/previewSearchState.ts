/**
 * The running app's completed-search context, one per module.
 *
 * A search-first module's Results exist only as the outcome of a search
 * the worker ran, and the no-matches registration form opens only from a
 * COMPLETED search that found nothing: not before a search, not while one
 * runs, and not after one failed. These reducers are the whole rule; the
 * case-list screen writes through them as its query settles, and the form
 * screen reads the result to admit or refuse the form.
 *
 * `attempt` counts searches within one module run. A launch carries the
 * attempt it was offered on, so a form opened from an earlier search cannot
 * read a later search's answers or outrun a search still running.
 * `submission` is each search's own identity, unique across every search:
 * the count restarts when Search again retires a search, so what is kept per
 * search (its device values) is kept under `submission`, never `attempt`.
 *
 * The same slot holds two kinds no attempt reader reads, so every list's
 * search stands and lets go by one rule (`lib/preview/searchStanding.ts`): a
 * Search action's search on a menu whose forms do not read it (`action`),
 * and the Search screen asked for again (`manual`). `searchAttemptOf` is the
 * attempt readers' view, `submittedSearchOf` the list's.
 */

import { v7 as uuidv7 } from "uuid";
import type {
	PreviewSearchAnswers,
	PreviewSearchDeviceValues,
	PreviewSearchFailure,
	PreviewSearchState,
} from "./types";

export const NOT_SEARCHED: PreviewSearchState = { kind: "not-searched" };

export type PreviewSearchOutcome =
	| { readonly kind: "completed"; readonly matchCount: number }
	| { readonly kind: "failed"; readonly reason: PreviewSearchFailure };

/** One search of a menu whose forms read it, numbered within the run. */
export type PreviewSearchAttempt = Extract<
	PreviewSearchState,
	{ readonly kind: "running" | "failed" | "completed" }
>;

/** A search the list holds with the worker's answers: an attempt of a menu
 *  whose forms read the search, or a Search action's search. */
export type PreviewSubmittedSearch =
	| PreviewSearchAttempt
	| Extract<PreviewSearchState, { readonly kind: "action" }>;

/** The state as an attempt of a menu whose forms read the search, if it is
 *  one; a Search action's search and a Search screen asked for again are
 *  not. */
export function searchAttemptOf(
	state: PreviewSearchState | undefined,
): PreviewSearchAttempt | undefined {
	return state?.kind === "running" ||
		state?.kind === "failed" ||
		state?.kind === "completed"
		? state
		: undefined;
}

/** The state as a search the list holds with answers, if it is one. */
export function submittedSearchOf(
	state: PreviewSearchState | undefined,
): PreviewSubmittedSearch | undefined {
	return state?.kind === "action" ? state : searchAttemptOf(state);
}

/** A Search action ran with these answers on a menu whose forms do not read
 *  the search: the session holds it so it stands and lets go as every search
 *  does (`lib/preview/searchStanding.ts`). */
export function actionSearch(
	answers: PreviewSearchAnswers,
	submission: string = newSearchSubmission(),
	automatic = false,
): PreviewSearchState {
	return {
		kind: "action",
		submission,
		answers,
		...(automatic && { automatic: true as const }),
	};
}

/** The worker asked for the Search screen again: Web Apps'
 *  `force_manual_search`, which stands and lets go as a search does. */
export function manualSearch(
	submission: string = newSearchSubmission(),
): PreviewSearchState {
	return { kind: "manual", submission };
}

function attemptOf(state: PreviewSearchState | undefined): number {
	return searchAttemptOf(state)?.attempt ?? 0;
}

/** A new search's identity. `uuid` draws on `crypto.getRandomValues`,
 * which every browsing context holds; `crypto.randomUUID` exists only in a
 * secure one, so Preview opened over plain http on a LAN address would
 * throw at Search. */
export function newSearchSubmission(): string {
	return uuidv7();
}

/** The worker pressed Search with these answers, or the menu ran its
 *  default search as it opened (`automatic`). */
export function beginSearch(
	state: PreviewSearchState | undefined,
	answers: PreviewSearchAnswers,
	submission: string = newSearchSubmission(),
	automatic = false,
): PreviewSearchState {
	return {
		kind: "running",
		attempt: attemptOf(state) + 1,
		submission,
		answers,
		...(automatic && { automatic: true as const }),
	};
}

/**
 * The query for `attempt` settled. A settlement for any other attempt is
 * stale (a later Search superseded it) and leaves the state untouched, as
 * does one that arrives when no search is running.
 */
export function settleSearch(
	state: PreviewSearchState | undefined,
	attempt: number,
	outcome: PreviewSearchOutcome,
): PreviewSearchState | undefined {
	if (state === undefined || state.kind !== "running") return state;
	if (state.attempt !== attempt) return state;
	const kept = {
		...(state.deviceValues !== undefined && {
			deviceValues: state.deviceValues,
		}),
		...(state.automatic && { automatic: true as const }),
	};
	return outcome.kind === "completed"
		? {
				kind: "completed",
				attempt,
				submission: state.submission,
				answers: state.answers,
				matchCount: outcome.matchCount,
				...kept,
			}
		: {
				kind: "failed",
				attempt,
				submission: state.submission,
				answers: state.answers,
				reason: outcome.reason,
				...kept,
			};
}

/**
 * The device worked out the `_xpath_query` rows of search `submission` as it
 * sent it. The first value for a search stands: a device evaluates the
 * request once and keeps it for the query step, so a later value (the
 * device's cases after a claim, a lookup that arrived) leaves the state
 * untouched, as does a value for any other search.
 */
export function recordSearchDeviceValues(
	state: PreviewSearchState | undefined,
	submission: string,
	value: PreviewSearchDeviceValues["value"],
): PreviewSearchState | undefined {
	const attempt = searchAttemptOf(state);
	if (attempt === undefined) return state;
	if (attempt.submission !== submission || attempt.deviceValues !== undefined)
		return state;
	return { ...attempt, deviceValues: { value } };
}

/** A search the device has yet to work out values for. */
export interface SearchAwaitingDeviceValues {
	readonly moduleUuid: string;
	readonly submission: string;
	readonly answers: PreviewSearchAnswers;
}

/**
 * The searches whose device values are still to be worked out: each one
 * pressed and still running with none recorded, and each that history ran
 * again past its list with other answers (`searchRunPastItsList`). The device
 * works a search's values out as it sends it, so they are recorded while it
 * runs, and every later state carries them forward (`settleSearch`); a
 * completed search holds them, or is the registered case, read by its id
 * with none.
 */
export function searchesAwaitingDeviceValues(
	states: Readonly<Record<string, PreviewSearchState>>,
): readonly SearchAwaitingDeviceValues[] {
	return Object.entries(states).flatMap(([moduleUuid, state]) =>
		(state.kind === "running" ||
			(state.kind === "completed" && state.rerunPastList)) &&
		state.deviceValues === undefined
			? [{ moduleUuid, submission: state.submission, answers: state.answers }]
			: [],
	);
}

/**
 * A case list registration form registered a case: the wire returns with
 * the module's search keyed to exactly that case (`CaseListFormWorkflow`'s
 * `case_fixture` query), so the completed search now holds it alone: one
 * match where the form created it, none where its open condition kept it
 * off the device, since the query then finds no case of that id. Where the
 * frame ends on that search (`listed` false), its list shows no row all the
 * same (`PreviewSearchState`'s `listsNoRow`).
 */
export function recordRegisteredCase(
	state: PreviewSearchState | undefined,
	caseId: string,
	created = true,
	listed = true,
): PreviewSearchState {
	const held = searchAttemptOf(state);
	const base =
		held !== undefined
			? {
					attempt: held.attempt,
					submission: held.submission,
					answers: held.answers,
				}
			: {
					attempt: attemptOf(state) + 1,
					submission: newSearchSubmission(),
					answers: {},
				};
	return {
		kind: "completed",
		...base,
		matchCount: created ? 1 : 0,
		registeredCaseId: caseId,
		...(!listed && { listsNoRow: true as const }),
	};
}

/** Whether Results may offer the no-matches registration form: a search
 *  the worker ran found nothing. A search keyed to a registered case is the
 *  return of a registration, never a search that found nothing, and one run
 *  again past its list holds answers no list counted. */
export function noMatchesActionAvailable(
	state: PreviewSearchState | undefined,
): state is Extract<PreviewSearchState, { kind: "completed" }> {
	return (
		state !== undefined &&
		state.kind === "completed" &&
		state.matchCount === 0 &&
		state.registeredCaseId === undefined &&
		state.rerunPastList === undefined
	);
}

/** The identity of what a list's run took from a submitted search: the
 *  search, and the answers it ran with. History can give a search back with
 *  other answers than it last ran with (`searchWithLatestInputs`), which the
 *  run must take again (`lib/preview/searchStanding.ts::previewSearchRunFollows`). */
export function submittedSearchKey(search: PreviewSubmittedSearch): string {
	const answers = Object.entries(search.answers).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return JSON.stringify([search.submission, answers]);
}

/**
 * A search history gives back, as Web Apps runs it. Web Apps keeps, for each
 * query, the answers the worker last gave it, in the page and never on an
 * address (`utils.js::Utils.setCurrentQueryInputs`, written by every
 * `CloudcareUrl.setQueryData`: a Search press, every field the worker
 * changes as the client checks it, `query.js::_updateModelsForValidation`,
 * and the Search screen as it is shown, `menus/utils.js::getMenuView`, with
 * no answers; no submission, crumb or Home clears them). An address records
 * only that the query ran, and Back and Forward answer it with those latest
 * answers (`CloudcareUrl.fromJson` over `Utils.getCurrentQueryInputs`), which
 * Formplayer gives the prompts before it runs the query again
 * (`MenuSessionRunnerService.java::answerQueryPrompts`: an answer the inputs
 * leave out is no answer, `QueryScreen.answerPrompts`).
 *
 * So the latest answers are the search's answers, each prompt's
 * (`promptKeys`: every field the worker answers and every hidden field, which
 * Nova emits as a prompt of its own) answered by them and no other: a prompt
 * they leave out has no answer, a hidden one included (`answerUserPrompt`
 * with no value removes it). The answers a Search press and a field change
 * write are every prompt view's, the hidden ones among them
 * (`query.js::getAnswers`), so they carry the hidden values; the Search
 * screen drawn writes none, so a search history gives back after it runs with
 * no answer at all, its hidden values gone too. It runs again where the
 * answers differ from those it ran with. A Search screen asked for again
 * holds no answers; the menu's default search (`automatic`) writes no query
 * data, and Formplayer runs it again with no answers; a search a
 * registration keyed to its case is read by that case; and where the worker
 * has given no answers in this session, the search keeps its own.
 */
export function searchWithLatestInputs<
	S extends Exclude<PreviewSearchState, { kind: "not-searched" }>,
>(
	search: S,
	latest: PreviewSearchAnswers | undefined,
	promptKeys: ReadonlySet<string>,
): PreviewSearchState {
	/* A search a screen past the list ran again holds answers its list never
	 * counted, so the list runs it again, whatever the latest answers. */
	if (search.kind === "completed" && search.rerunPastList)
		return {
			kind: "running",
			attempt: search.attempt,
			submission: search.submission,
			answers:
				latestPromptAnswers(search, latest, promptKeys) ?? search.answers,
		};
	const answers = latestPromptAnswers(search, latest, promptKeys);
	if (answers === undefined || search.kind === "manual") return search;
	if (search.kind === "action") return { ...search, answers };
	return {
		kind: "running",
		attempt: search.attempt,
		submission: search.submission,
		answers,
	};
}

/**
 * A search history gives back on a screen past its list, as Web Apps runs it
 * there. Formplayer replays the whole address on every request
 * (`MenuSessionRunnerService.advanceSessionWithSelections`), so the list's
 * query step runs again with the latest answers (`searchWithLatestInputs`'s
 * rule) on a menu or a form past the list too, and a form of a menu whose
 * forms read the search reads what that run finds (`results:inline`). The
 * case the list chose still stands: the selection is confirmed
 * (`RestoreFactory.isConfirmedSelection`), so `MenuSession.handleInput` sets
 * the datum with no lookup in the new results.
 *
 * Only a completed search of a menu whose forms read it changes: a Search
 * action's search is read by its list alone, which takes the latest answers
 * as it comes on show, and a search still running or failed has no screen
 * past its list. The search keeps its attempt and its identity and holds the
 * latest answers, without the device values worked out for the answers it ran
 * with (`searchesAwaitingDeviceValues` works them out again), and marked
 * `rerunPastList`, as no list counted what these answers find.
 */
export function searchRunPastItsList<
	S extends Exclude<PreviewSearchState, { kind: "not-searched" }>,
>(
	search: S,
	latest: PreviewSearchAnswers | undefined,
	promptKeys: ReadonlySet<string>,
): PreviewSearchState {
	if (search.kind !== "completed") return search;
	const answers = latestPromptAnswers(search, latest, promptKeys);
	if (answers === undefined) return search;
	return {
		kind: "completed",
		attempt: search.attempt,
		submission: search.submission,
		answers,
		matchCount: search.matchCount,
		rerunPastList: true,
	};
}

/** The answers Web Apps answers a search's query with on a step back through
 *  history, where they differ from those the search holds; none where they do
 *  not, or where Web Apps does not answer it from them
 *  (`searchWithLatestInputs`). */
function latestPromptAnswers(
	search: Exclude<PreviewSearchState, { kind: "not-searched" }>,
	latest: PreviewSearchAnswers | undefined,
	promptKeys: ReadonlySet<string>,
): Record<string, string> | undefined {
	if (latest === undefined || search.kind === "manual" || search.automatic)
		return undefined;
	if (search.kind === "completed" && search.registeredCaseId !== undefined)
		return undefined;
	const answers: Record<string, string> = {};
	for (const [key, value] of Object.entries(latest))
		if (promptKeys.has(key)) answers[key] = value;
	const before = Object.keys(search.answers);
	if (
		before.length === Object.keys(answers).length &&
		before.every(
			(key) =>
				Object.hasOwn(answers, key) && answers[key] === search.answers[key],
		)
	)
		return undefined;
	return answers;
}

/**
 * The answers the worker last gave each module's query, kept for the Preview
 * session that ran them: Web Apps keeps them in the page
 * (`utils.js::Utils.queryInputs`), which only a reload clears, and Preview's
 * running session is the scope a history entry's search stands in, so a new
 * session (another worker, another platform, another Preview run) starts
 * with none.
 */
export interface PreviewSearchInputsGiven {
	readonly session: string;
	readonly byModule: Readonly<Record<string, PreviewSearchAnswers>>;
}

export const NO_SEARCH_INPUTS_GIVEN: PreviewSearchInputsGiven = {
	session: "",
	byModule: {},
};

/** The answers given in the running session, by module. */
export function searchInputsGivenIn(
	given: PreviewSearchInputsGiven,
	session: string,
): Readonly<Record<string, PreviewSearchAnswers>> {
	return given.session === session ? given.byModule : {};
}

/** The worker gave a module's query these answers in the running session:
 *  a Search press or a field changed on its Search screen, with every hidden
 *  field's value beside the worker's answers, as Web Apps' prompt views give
 *  them (`query.js::getAnswers`), or none at all as the Search screen is
 *  shown (`menus/utils.js::getMenuView`). The same answers change nothing. */
export function withSearchInputsGiven(
	given: PreviewSearchInputsGiven,
	session: string,
	moduleUuid: string,
	answers: PreviewSearchAnswers,
): PreviewSearchInputsGiven {
	const byModule = searchInputsGivenIn(given, session);
	const current = byModule[moduleUuid];
	if (
		given.session === session &&
		current !== undefined &&
		Object.keys(current).length === Object.keys(answers).length &&
		Object.entries(answers).every(
			([key, value]) => Object.hasOwn(current, key) && current[key] === value,
		)
	)
		return given;
	return { session, byModule: { ...byModule, [moduleUuid]: answers } };
}
