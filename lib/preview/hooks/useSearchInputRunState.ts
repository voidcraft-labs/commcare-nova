"use client";

import { useEffect, useMemo, useState } from "react";
import type { SearchInputDef } from "@/lib/domain";
import type { PreviewSearchSessionValues } from "../engine/identity";
import type { PreviewLookupData } from "../engine/lookupEvaluation";
import type { SearchInputValues } from "../engine/runtimeBindings";
import {
	buildSearchRunState,
	changeSearchRunDraft,
	clearSearchRun,
	hasNonEmptyValue,
	reconcileSearchRunState,
	restoreSearchRun,
	withHiddenValues,
} from "../engine/searchRunState";

export interface SearchInputRunState {
	readonly draft: SearchInputValues;
	/** Every value the last Search carried: the worker's answers plus the
	 *  hidden inputs' system-generated values, exactly as CommCare's
	 *  search-input instance would hold them. */
	readonly submitted: SearchInputValues;
	readonly draftActive: boolean;
	readonly queryActive: boolean;
	/** Whether the worker has performed the Search action, including a submit
	 *  with every prompt blank. Distinct from `queryActive`, which only reflects
	 *  non-empty criteria. */
	readonly hasSubmitted: boolean;
	/** The hidden inputs' values a search pressed now would carry. */
	readonly resolveHidden: () => SearchInputValues;
	readonly changeDraft: (next: SearchInputValues) => void;
	readonly submit: (next: SearchInputValues) => void;
	/** Re-enter the submitted phase with the values of a search this screen
	 *  did not press itself (the module's standing search context): the
	 *  visible prompts' answers and the hidden values as that search carried
	 *  them, so a `now()` search time is the time of that search. */
	readonly restore: (values: SearchInputValues) => void;
	readonly clear: () => void;
}

/** React owns subscription timing; searchRunState owns the search commands. */
export function useSearchInputRunState(args: {
	readonly scopeKey: string;
	readonly searchInputs: readonly SearchInputDef[];
	readonly session: PreviewSearchSessionValues;
	readonly lookupData?: PreviewLookupData;
}): SearchInputRunState {
	const desired = useMemo(
		() =>
			buildSearchRunState(
				args.scopeKey,
				args.searchInputs,
				args.session,
				args.lookupData,
			),
		[args.scopeKey, args.searchInputs, args.session, args.lookupData],
	);
	const [stored, setStored] = useState(desired);
	// Project the new scope before the synchronization effect can commit.
	const current = reconcileSearchRunState(stored, desired);
	useEffect(() => {
		setStored((previous) => reconcileSearchRunState(previous, desired));
	}, [desired]);
	// The query reload identity must remain stable during unrelated renders.
	const submitted = useMemo(
		() => withHiddenValues(current.submitted, current.submittedHidden),
		[current.submitted, current.submittedHidden],
	);
	return {
		draft: current.draft,
		submitted,
		draftActive: hasNonEmptyValue(current.draft),
		queryActive: hasNonEmptyValue(current.submitted),
		hasSubmitted: current.hasSubmitted,
		resolveHidden: desired.resolveHidden,
		changeDraft: (next) =>
			setStored((previous) =>
				changeSearchRunDraft(previous, desired, next, false),
			),
		submit: (next) =>
			setStored((previous) =>
				changeSearchRunDraft(previous, desired, next, true),
			),
		restore: (values) =>
			setStored((previous) => restoreSearchRun(previous, desired, values)),
		clear: () => setStored((previous) => clearSearchRun(previous, desired)),
	};
}
