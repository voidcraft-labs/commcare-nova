// lib/preview/engine/searchInputConstraints.ts
//
// The two author-facing constraints a Search prompt carries, evaluated over
// the worker's draft exactly as CommCare's query screen evaluates them
// (`RemoteQuerySessionManager.validateUserAnswers`):
//
//   - REQUIRED fires only when the answer is blank. An unconditional
//     requirement always fires on blank; a conditional one fires on blank
//     when its `when` predicate holds against the sibling answers.
//   - VALIDATION (the check) is skipped when the answer is blank and fires
//     when its rule evaluates false against the answer and its siblings.
//
// Both predicates read the search-input instance, so a bare `input(...)` of
// any sibling is meaningful here; an unanswered sibling reads blank. There is
// no case row on this screen, and the validator has already refused every
// case read in these slots.
//
// The server action re-runs this gate before opening a case store so a
// request built by hand cannot skip a required prompt Preview enforced.

import {
	type SearchInputDef,
	searchInputRequiredMessage,
	type VisibleSearchInputDef,
} from "@/lib/domain";
import { type Predicate, walkTerms } from "@/lib/domain/predicate";
import type { PreviewSearchSessionValues } from "./identity";
import {
	type PreviewLookupData,
	predicateLookupsCovered,
} from "./lookupEvaluation";
import {
	type SearchInputValues,
	withSearchInputExpressionValues,
} from "./runtimeBindings";
import { evaluatePreviewSearchPredicate } from "./searchExpressionEvaluation";

export interface SearchInputConstraintOptions {
	/**
	 * Evaluate only constraints whose predicates read no authenticated session
	 * data. The server action uses this pass before it has resolved the worker,
	 * then runs the full pass with the resolved session.
	 */
	readonly sessionIndependentOnly?: boolean;
}

/**
 * Per-prompt required / check errors over the draft, keyed by the prompt's
 * wire name. At most one message per prompt: required wins over the check,
 * because the check never runs on a blank answer.
 */
export function searchInputConstraintErrors(
	searchInputs: readonly SearchInputDef[],
	values: SearchInputValues,
	session: PreviewSearchSessionValues,
	lookupData?: PreviewLookupData,
	options?: SearchInputConstraintOptions,
): ReadonlyMap<string, string> {
	const errors = new Map<string, string>();
	const expressionValues = withSearchInputExpressionValues(
		searchInputs,
		values,
	);
	/* `undefined` means "cannot be judged here": a session read before the
	 * worker is resolved, or a lookup carrier whose rows this caller does not
	 * hold. The constraint then neither fires nor clears on this pass. */
	const holds = (predicate: Predicate): boolean | undefined => {
		if (
			options?.sessionIndependentOnly === true &&
			predicateReadsSession(predicate)
		) {
			return undefined;
		}
		if (!predicateLookupsCovered(predicate, lookupData)) return undefined;
		return evaluatePreviewSearchPredicate(
			predicate,
			searchInputs,
			session,
			values,
			lookupData,
		);
	};

	for (const input of searchInputs) {
		if (input.kind === "hidden") continue;
		const answer = expressionValues.get(input.name) ?? "";
		if (answer === "") {
			const message = requiredMessageFor(input, holds);
			if (message !== undefined) errors.set(input.name, message);
			continue;
		}
		if (input.validation === undefined) continue;
		const passes = holds(input.validation.rule);
		if (passes === false) errors.set(input.name, input.validation.message);
	}
	return errors;
}

function requiredMessageFor(
	input: VisibleSearchInputDef,
	holds: (predicate: Predicate) => boolean | undefined,
): string | undefined {
	const message = searchInputRequiredMessage(input);
	if (message === undefined || input.required === undefined) return undefined;
	if (input.required.when === undefined) return message;
	return holds(input.required.when) === true ? message : undefined;
}

function predicateReadsSession(predicate: Predicate): boolean {
	let reads = false;
	walkTerms(predicate, (term) => {
		if (
			term.kind === "session-user" ||
			term.kind === "session-user-property" ||
			term.kind === "session-context"
		) {
			reads = true;
		}
	});
	return reads;
}
