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
 */

import type {
	PreviewSearchAnswers,
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

/** The worker pressed Search with these answers. */
export function beginSearch(
	state: PreviewSearchState | undefined,
	answers: PreviewSearchAnswers,
): PreviewSearchState {
	return { kind: "running", attempt: attemptOf(state) + 1, answers };
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
	return outcome.kind === "completed"
		? {
				kind: "completed",
				attempt,
				answers: state.answers,
				matchCount: outcome.matchCount,
			}
		: {
				kind: "failed",
				attempt,
				answers: state.answers,
				reason: outcome.reason,
			};
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
			? { attempt: state.attempt, answers: state.answers }
			: { attempt: attemptOf(state) + 1, answers: {} };
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
