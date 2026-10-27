"use client";

import { useEffect, useMemo, useState } from "react";
import type { SearchInputDef } from "@/lib/domain";
import { PLATFORMS } from "@/lib/domain/platforms";
import type { PreviewSearchSessionValues } from "../engine/identity";
import type { SearchInputValues } from "../engine/runtimeBindings";
import type { PreviewSearchEnvironment } from "../engine/searchExpressionEvaluation";
import {
	buildSearchRunState,
	changeSearchRunDraft,
	clearSearchRun,
	hasNonEmptyValue,
	reconcileSearchRunState,
	restoreSearchRun,
	withHiddenValues,
} from "../engine/searchRunState";
import {
	effectivePreviewPlatform,
	type PreviewPlatformRules,
	previewPlatformRules,
} from "../platform";

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
	/** The fields the Search screen draws, in order: every visible input,
	 *  and on Android every hidden input too, which a phone shows as an
	 *  ordinary field holding its starting value (manifest
	 *  `case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset`). */
	readonly drawnInputs: readonly SearchInputDef[];
}

/** The inputs a Search screen draws on a platform: Web Apps hides a hidden
 *  input; Android draws it as an editable field holding its value. */
export function drawnSearchInputs(
	searchInputs: readonly SearchInputDef[],
	rules: Pick<PreviewPlatformRules, "hiddenSearchFieldWithDefault">,
): readonly SearchInputDef[] {
	return rules.hiddenSearchFieldWithDefault === "editable"
		? searchInputs
		: searchInputs.filter((input) => input.kind !== "hidden");
}

const DEFAULT_RULES = previewPlatformRules(
	effectivePreviewPlatform(PLATFORMS, undefined),
);

/** React owns subscription timing; searchRunState owns the search commands. */
export function useSearchInputRunState(args: {
	readonly scopeKey: string;
	readonly searchInputs: readonly SearchInputDef[];
	readonly session: PreviewSearchSessionValues;
	readonly environment: PreviewSearchEnvironment;
	/** The platform Preview plays; defaults to an app's default platform. */
	readonly rules?: Pick<PreviewPlatformRules, "hiddenSearchFieldWithDefault">;
}): SearchInputRunState {
	const desired = useMemo(
		() =>
			buildSearchRunState(
				args.scopeKey,
				args.searchInputs,
				args.session,
				args.environment,
			),
		[args.scopeKey, args.searchInputs, args.session, args.environment],
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
		drawnInputs: drawnSearchInputs(
			args.searchInputs,
			args.rules ?? DEFAULT_RULES,
		),
	};
}
