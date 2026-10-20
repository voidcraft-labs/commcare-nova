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

function attemptOf(state: PreviewSearchState | undefined): number {
	return state === undefined || state.kind === "not-searched"
		? 0
		: state.attempt;
}

/** A new search's identity. `uuid` draws on `crypto.getRandomValues`,
 * which every browsing context holds; `crypto.randomUUID` exists only in a
 * secure one, so Preview opened over plain http on a LAN address would
 * throw at Search. */
export function newSearchSubmission(): string {
	return uuidv7();
}

/** The worker pressed Search with these answers. */
export function beginSearch(
	state: PreviewSearchState | undefined,
	answers: PreviewSearchAnswers,
	submission: string = newSearchSubmission(),
): PreviewSearchState {
	return {
		kind: "running",
		attempt: attemptOf(state) + 1,
		submission,
		answers,
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
	const deviceValues =
		state.deviceValues === undefined
			? {}
			: { deviceValues: state.deviceValues };
	return outcome.kind === "completed"
		? {
				kind: "completed",
				attempt,
				submission: state.submission,
				answers: state.answers,
				matchCount: outcome.matchCount,
				...deviceValues,
			}
		: {
				kind: "failed",
				attempt,
				submission: state.submission,
				answers: state.answers,
				reason: outcome.reason,
				...deviceValues,
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
	if (state === undefined || state.kind === "not-searched") return state;
	if (state.submission !== submission || state.deviceValues !== undefined)
		return state;
	return { ...state, deviceValues: { value } };
}

/** A search the device has yet to work out values for. */
export interface SearchAwaitingDeviceValues {
	readonly moduleUuid: string;
	readonly submission: string;
	readonly answers: PreviewSearchAnswers;
}

/**
 * The searches whose device values are still to be worked out: each one
 * pressed and still running with none recorded. The device works a search's
 * values out as it sends it, so they are recorded while it runs, and every
 * later state carries them forward (`settleSearch`); a completed search
 * holds them, or is the registered case, read by its id with none.
 */
export function searchesAwaitingDeviceValues(
	states: Readonly<Record<string, PreviewSearchState>>,
): readonly SearchAwaitingDeviceValues[] {
	return Object.entries(states).flatMap(([moduleUuid, state]) =>
		state.kind === "running" && state.deviceValues === undefined
			? [{ moduleUuid, submission: state.submission, answers: state.answers }]
			: [],
	);
}

/**
 * The no-matches form registered a case: the wire returns to Results
 * showing exactly that case (`CaseListFormWorkflow`'s `case_fixture`
 * frame), so the completed search now holds one match.
 */
export function recordRegisteredCase(
	state: PreviewSearchState | undefined,
	caseId: string,
): PreviewSearchState {
	const base =
		state !== undefined && state.kind !== "not-searched"
			? {
					attempt: state.attempt,
					submission: state.submission,
					answers: state.answers,
				}
			: {
					attempt: attemptOf(state) + 1,
					submission: newSearchSubmission(),
					answers: {},
				};
	return {
		kind: "completed",
		...base,
		matchCount: 1,
		registeredCaseId: caseId,
	};
}

/** Whether Results may offer the no-matches registration form. */
export function noMatchesActionAvailable(
	state: PreviewSearchState | undefined,
): state is Extract<PreviewSearchState, { kind: "completed" }> {
	return (
		state !== undefined && state.kind === "completed" && state.matchCount === 0
	);
}
