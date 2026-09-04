// lib/preview/hooks/useSearchInputRunState.ts
//
// Running search-screen state with one-time prompt defaults. The flipbook keeps
// this hook mounted while edit mode is visible, so reconciliation deliberately
// mirrors the form engine: a changed default updates an untouched prompt, while
// a worker's typed/cleared value survives blueprint edits. Moving to a different
// module is a new search session and clears both submitted values and touch state.

"use client";

import { useEffect, useMemo, useState } from "react";
import type { SearchInputDef } from "@/lib/domain";
import type { PreviewSearchSessionValues } from "@/lib/preview/engine/identity";
import type { PreviewLookupData } from "@/lib/preview/engine/lookupEvaluation";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import {
	resolveSearchHiddenValues,
	resolveSearchInputDefaults,
} from "@/lib/preview/engine/searchExpressionEvaluation";

interface SearchRunState {
	readonly scopeKey: string;
	readonly revision: string;
	readonly allowedKeys: ReadonlySet<string>;
	readonly keyShapes: ReadonlyMap<string, string>;
	readonly defaults: SearchInputValues;
	readonly draft: SearchInputValues;
	/** The worker's answers as of the last Search. */
	readonly submitted: SearchInputValues;
	/** Hidden inputs' system-generated values, resolved when the worker searched. */
	readonly submittedHidden: SearchInputValues;
	readonly hasSubmitted: boolean;
	readonly touched: ReadonlySet<string>;
}

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
	readonly changeDraft: (next: SearchInputValues) => void;
	readonly submit: (next: SearchInputValues) => void;
	readonly clear: () => void;
}

export function useSearchInputRunState(args: {
	readonly scopeKey: string;
	readonly searchInputs: readonly SearchInputDef[];
	readonly session: PreviewSearchSessionValues;
	/** The builder session's lookup snapshot — defaults carrying lookup
	 *  carriers fold over it; while it is absent they stay unresolved
	 *  and land through the ordinary untouched-prompt refresh. */
	readonly lookupData?: PreviewLookupData;
}): SearchInputRunState {
	const desired = useMemo(
		() =>
			buildDesiredState(
				args.scopeKey,
				args.searchInputs,
				args.session,
				args.lookupData,
			),
		[args.scopeKey, args.searchInputs, args.session, args.lookupData],
	);
	const [stored, setStored] = useState<SearchRunState>(desired);

	// Derive the current view during render. This is the stale-state guard: a
	// module switch cannot render or query with the previous module's values in
	// the one frame before the synchronization effect commits.
	const current = reconcileSearchRunState(stored, desired);

	useEffect(() => {
		setStored((previous) => reconcileSearchRunState(previous, desired));
	}, [desired]);

	const commitDraft = (next: SearchInputValues, submit: boolean) => {
		setStored((previous) => {
			const base = reconcileSearchRunState(previous, desired);
			const draft = retainAllowed(next, base.allowedKeys);
			return {
				...base,
				draft,
				submitted: submit ? draft : base.submitted,
				// Hidden values are read when the worker searches, the moment
				// CommCare seeds them, so a `now()` search time is the time of
				// this Search rather than of the screen's first render.
				submittedHidden: submit
					? resolveSearchHiddenValues(
							args.searchInputs,
							args.session,
							args.lookupData,
						)
					: base.submittedHidden,
				hasSubmitted: submit ? true : base.hasSubmitted,
				touched: changedKeys(base.draft, draft, base.touched, base.allowedKeys),
			};
		});
	};

	return {
		draft: current.draft,
		submitted: withHiddenValues(current.submitted, current.submittedHidden),
		draftActive: hasNonEmptyValue(current.draft),
		queryActive: hasNonEmptyValue(current.submitted),
		hasSubmitted: current.hasSubmitted,
		changeDraft: (next) => commitDraft(next, false),
		submit: (next) => commitDraft(next, true),
		clear: () => {
			setStored((previous) => {
				const base = reconcileSearchRunState(previous, desired);
				return {
					...base,
					draft: new Map(),
					submitted: new Map(),
					submittedHidden: new Map(),
					hasSubmitted: false,
					// Clearing is an intentional worker edit. Mark every prompt so a
					// later session/auth refresh does not immediately resurrect defaults.
					touched: new Set(base.allowedKeys),
				};
			});
		},
	};
}

function buildDesiredState(
	scopeKey: string,
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	lookupData?: PreviewLookupData,
): SearchRunState {
	const allowedKeys = new Set<string>();
	const keyShapes = new Map<string, string>();
	for (const input of searchInputs) {
		// A hidden input has no draft key: the worker never answers it, and
		// its value is resolved at submit.
		if (input.kind === "hidden") continue;
		const shape = `${input.uuid}:${input.type}`;
		if (input.type === "date-range") {
			const fromKey = `${input.name}:from`;
			const toKey = `${input.name}:to`;
			allowedKeys.add(fromKey);
			allowedKeys.add(toKey);
			keyShapes.set(fromKey, shape);
			keyShapes.set(toKey, shape);
		} else {
			allowedKeys.add(input.name);
			keyShapes.set(input.name, shape);
		}
	}
	const defaults = resolveSearchInputDefaults(
		searchInputs,
		session,
		lookupData,
	);
	const revision = JSON.stringify({
		shapes: [...keyShapes].sort(([left], [right]) => left.localeCompare(right)),
		defaults: [...defaults].sort(([left], [right]) =>
			left.localeCompare(right),
		),
	});
	return {
		scopeKey,
		revision,
		allowedKeys,
		keyShapes,
		defaults,
		draft: defaults,
		submitted: new Map(),
		submittedHidden: new Map(),
		hasSubmitted: false,
		touched: new Set(),
	};
}

/** Pure reconciliation shared by render-time and effect-time stale guards. */
function reconcileSearchRunState(
	previous: SearchRunState,
	desired: SearchRunState,
): SearchRunState {
	if (previous.scopeKey !== desired.scopeKey) return desired;
	// Removing the final prompt removes the Search surface itself. A prior
	// submission belongs to that surface and must not survive as a phase-only
	// flag: CaseListScreen uses it to activate advanced search settings such as
	// owner exclusions. Genuine filter-only launch is derived independently
	// from the effective filter and needs no synthetic submission.
	if (previous.revision === desired.revision) return previous;
	if (desired.allowedKeys.size === 0) return desired;

	const keyIsCompatible = (key: string) =>
		previous.keyShapes.get(key) === desired.keyShapes.get(key);
	const touched = new Set(
		[...previous.touched].filter(
			(key) => desired.allowedKeys.has(key) && keyIsCompatible(key),
		),
	);
	const draft = new Map<string, string>();
	for (const key of desired.allowedKeys) {
		if (touched.has(key)) {
			const value = previous.draft.get(key);
			if (value !== undefined) draft.set(key, value);
			continue;
		}
		const nextDefault = desired.defaults.get(key);
		if (nextDefault !== undefined) draft.set(key, nextDefault);
	}

	return {
		...desired,
		draft,
		submitted: new Map(
			[...previous.submitted].filter(
				([key]) => desired.allowedKeys.has(key) && keyIsCompatible(key),
			),
		),
		submittedHidden: previous.submittedHidden,
		hasSubmitted: previous.hasSubmitted,
		touched,
	};
}

function withHiddenValues(
	submitted: SearchInputValues,
	hidden: SearchInputValues,
): SearchInputValues {
	if (hidden.size === 0) return submitted;
	return new Map([...submitted, ...hidden]);
}

function retainAllowed(
	values: SearchInputValues,
	allowedKeys: ReadonlySet<string>,
): SearchInputValues {
	return new Map([...values].filter(([key]) => allowedKeys.has(key)));
}

function changedKeys(
	previous: SearchInputValues,
	next: SearchInputValues,
	priorTouched: ReadonlySet<string>,
	allowedKeys: ReadonlySet<string>,
): ReadonlySet<string> {
	const touched = new Set(priorTouched);
	for (const key of allowedKeys) {
		if ((previous.get(key) ?? "") !== (next.get(key) ?? "")) touched.add(key);
	}
	return touched;
}

function hasNonEmptyValue(values: SearchInputValues): boolean {
	return [...values.values()].some((value) => value !== "");
}
