"use client";

import { useEffect, useMemo, useState } from "react";
import type { SearchInputDef } from "@/lib/domain";
import { PLATFORMS } from "@/lib/domain/platforms";
import { PreviewDataRefusal, readPreviewScreen } from "../engine/dataRefusal";
import {
	awaitsPreviewIdentity,
	type PreviewSearchSessionValues,
} from "../engine/identity";
import type { SearchInputValues } from "../engine/runtimeBindings";
import type { PreviewSearchEnvironment } from "../engine/searchExpressionEvaluation";
import {
	buildSearchRunState,
	changeSearchRunDraft,
	clearSearchRun,
	hasNonEmptyValue,
	openSearchRunState,
	reconcileSearchRunState,
	restoreSearchRun,
	searchScreenOpeningCovered,
	withHiddenValues,
} from "../engine/searchRunState";
import {
	effectivePreviewPlatform,
	type PreviewPlatformRules,
	previewPlatformRules,
} from "../platform";

import {
	type SearchRangeTarget,
	useSearchRangeOpening,
} from "./useSearchRangeOpening";
export interface SearchInputRunState {
	readonly defaults: SearchInputValues;
	readonly openingMessage?: string;
	readonly retryOpening?: () => void;
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
	/** Core's refusal of the Search screen: a starting value, a hidden
	 *  value, a required condition or the check of a prompt its starting
	 *  value answers reads data the worker's device lacks (a place key of a
	 *  worker assigned nowhere), which Core's query manager reads as the
	 *  screen opens and stops on, on both platforms. The state then holds no
	 *  field, and the screen shows the refusal. */
	readonly refusal?: PreviewDataRefusal;
	/** The screen has not opened yet: the session is still waiting for its
	 *  worker (`identity.ts::awaitsPreviewIdentity`), or the lookup data that
	 *  covers what the screen reads as it opens has not arrived
	 *  (`searchRunState.ts::searchScreenOpeningCovered`). The screen has read
	 *  nothing, holds no field, refuses nothing and waits, so no automatic
	 *  search runs before its choice lists are judged, and a search pressed
	 *  now would carry no hidden value. Their arrival opens it as above. */
	readonly pending?: true;
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
	readonly rangeTarget?: SearchRangeTarget;
	readonly searchInputs: readonly SearchInputDef[];
	readonly session: PreviewSearchSessionValues;
	readonly environment: PreviewSearchEnvironment;
	/** The platform Preview plays; defaults to an app's default platform. */
	readonly rules?: Pick<PreviewPlatformRules, "hiddenSearchFieldWithDefault">;
	/** The lookup data failed to load, so the screen opens over what the
	 *  data it holds covers rather than waiting for data that will not
	 *  arrive. */
	readonly lookupLoadFailed?: boolean;
}): SearchInputRunState {
	/* The screen reads what Core's query manager reads as it opens (its
	 * starting values, hidden values, choice lists, required conditions and
	 * the checks its starting values answer), so a read any of them makes of
	 * data the device lacks is the screen's refusal on both platforms, held as state. A
	 * session still waiting for its worker, or for the lookup data those
	 * reads read, is read not at all. */
	const waitingForWorker = awaitsPreviewIdentity(args.session);
	const ranges = useSearchRangeOpening(
		args.scopeKey,
		args.environment.moduleUuid,
		args.environment.doc.modules[args.environment.moduleUuid]?.caseListConfig
			?.searchInputs ?? args.searchInputs,
		args.rangeTarget,
		!waitingForWorker,
	);
	const pending =
		waitingForWorker ||
		ranges.pending ||
		ranges.retry !== undefined ||
		(args.lookupLoadFailed !== true &&
			!searchScreenOpeningCovered(
				args.searchInputs,
				args.environment,
				ranges.opened,
			));

	const read = useMemo(
		() =>
			ranges.refusal
				? {
						kind: "refused" as const,
						refusal: new PreviewDataRefusal(ranges.refusal),
					}
				: pending
					? undefined
					: readPreviewScreen(() =>
							openSearchRunState(
								args.scopeKey,
								args.searchInputs,
								args.session,
								args.environment,
								ranges.opened,
							),
						),
		[
			pending,
			ranges.refusal,
			ranges.opened,
			args.scopeKey,
			args.searchInputs,
			args.session,
			args.environment,
		],
	);
	/* A screen that waits or refuses holds no field: the state of a screen
	 * with no inputs, which the opened screen replaces as a new revision. */
	const desired = useMemo(
		() =>
			read?.kind === "read"
				? read.value
				: buildSearchRunState(
						args.scopeKey,
						[],
						args.session,
						args.environment,
					),
		[read, args.scopeKey, args.session, args.environment],
	);
	const [stored, setStored] = useState(desired);
	/* The new scope or revision is projected before the synchronization
	 * effect can commit, once per stored and desired state: a projection
	 * rebuilds its draft and submission, so a render that projected again
	 * would hand the screen a new query reference each time, and a screen
	 * that adjusts its own state to a new query during render would never
	 * settle. The effect then stores that same projection, so the reference
	 * the screen rendered is the one it keeps. */
	const current = useMemo(
		() => reconcileSearchRunState(stored, desired),
		[stored, desired],
	);
	useEffect(() => {
		setStored((previous) =>
			previous === stored
				? current
				: reconcileSearchRunState(previous, desired),
		);
	}, [stored, current, desired]);
	// The query reload identity must remain stable during unrelated renders.
	const submitted = useMemo(
		() => withHiddenValues(current.submitted, current.submittedHidden),
		[current.submitted, current.submittedHidden],
	);
	return {
		retryOpening: ranges.retry,
		openingMessage: ranges.message,
		defaults: current.defaults,
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
		...(read?.kind === "refused" ? { refusal: read.refusal } : {}),
		...(pending ? { pending: true as const } : {}),
	};
}
