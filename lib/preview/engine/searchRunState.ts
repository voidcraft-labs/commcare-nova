// Search draft, submission and blueprint reconciliation state.
import type { SearchInputDef } from "@/lib/domain";
import type { PreviewSearchSessionValues } from "@/lib/preview/engine/identity";
import type { PreviewLookupData } from "@/lib/preview/engine/lookupEvaluation";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import {
	resolveSearchHiddenValues,
	resolveSearchInputDefaults,
} from "@/lib/preview/engine/searchExpressionEvaluation";

export interface SearchRunState {
	readonly scopeKey: string;
	readonly revision: string;
	/** The hidden inputs' identity (name, uuid, value), so an edit to one
	 *  moves the revision even though nobody answers it. */
	readonly hiddenRevision: string;
	/** Resolve the hidden inputs against the current session and lookup
	 *  data; what a fresh search would carry. */
	readonly resolveHidden: () => SearchInputValues;
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

/** Draft commands own search answers independently of their React adapter. */
export function changeSearchRunDraft(
	previous: SearchRunState,
	desired: SearchRunState,
	next: SearchInputValues,
	submit: boolean,
): SearchRunState {
	const base = reconcileSearchRunState(previous, desired);
	const draft = retainAllowed(next, base.allowedKeys);
	return {
		...base,
		draft,
		submitted: submit ? draft : base.submitted,
		submittedHidden: submit ? desired.resolveHidden() : base.submittedHidden,
		hasSubmitted: submit ? true : base.hasSubmitted,
		touched: changedKeys(base.draft, draft, base.touched, base.allowedKeys),
	};
}

export function restoreSearchRun(
	previous: SearchRunState,
	desired: SearchRunState,
	values: SearchInputValues,
): SearchRunState {
	const base = reconcileSearchRunState(previous, desired);
	const draft = retainAllowed(values, base.allowedKeys);
	return {
		...base,
		draft,
		submitted: draft,
		submittedHidden: new Map(
			[...values].filter(([key]) => !base.allowedKeys.has(key)),
		),
		hasSubmitted: true,
		touched: changedKeys(base.draft, draft, base.touched, base.allowedKeys),
	};
}

export function clearSearchRun(
	previous: SearchRunState,
	desired: SearchRunState,
): SearchRunState {
	const base = reconcileSearchRunState(previous, desired);
	return {
		...base,
		draft: new Map(),
		submitted: new Map(),
		submittedHidden: new Map(),
		hasSubmitted: false,
		// An intentional clear must survive later default refreshes.
		touched: new Set(base.allowedKeys),
	};
}
export function buildSearchRunState(
	scopeKey: string,
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	lookupData?: PreviewLookupData,
): SearchRunState {
	const allowedKeys = new Set<string>();
	const keyShapes = new Map<string, string>();
	for (const input of searchInputs) {
		// A hidden input has no draft key: the worker never answers it. Its
		// value is resolved at submit, and a constraint judged over the draft
		// seeds it itself (`emitPreviewSearchPredicate`).
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
	const hiddenRevision = JSON.stringify(
		searchInputs
			.filter((input) => input.kind === "hidden")
			.map((input) => [input.name, input.uuid, input.value])
			.sort(([left], [right]) => String(left).localeCompare(String(right))),
	);
	const revision = JSON.stringify({
		shapes: [...keyShapes].sort(([left], [right]) => left.localeCompare(right)),
		defaults: [...defaults].sort(([left], [right]) =>
			left.localeCompare(right),
		),
		hidden: hiddenRevision,
	});
	return {
		scopeKey,
		revision,
		hiddenRevision,
		resolveHidden: () =>
			resolveSearchHiddenValues(searchInputs, session, lookupData),
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
export function reconcileSearchRunState(
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
		// A hidden input that was removed or renamed must not keep feeding
		// its old name into the query, and one that was added or re-authored
		// should carry what the device would seed on the next screen build.
		// The last search stands, so its hidden values are re-resolved rather
		// than dropped.
		submittedHidden:
			previous.hasSubmitted &&
			previous.hiddenRevision !== desired.hiddenRevision
				? desired.resolveHidden()
				: previous.submittedHidden,
		hasSubmitted: previous.hasSubmitted,
		touched,
	};
}

export function withHiddenValues(
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

export function hasNonEmptyValue(values: SearchInputValues): boolean {
	return [...values.values()].some((value) => value !== "");
}
