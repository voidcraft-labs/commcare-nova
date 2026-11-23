// Search draft, submission and blueprint reconciliation state.
import {
	joinMultiSelectSearchAnswer,
	MULTI_SELECT_SEARCH_ANSWER_DELIMITER,
	type SearchInputDef,
	searchInputDefault,
	searchInputLookupSortColumnId,
	type Uuid,
} from "@/lib/domain";
import { PreviewDataRefusal } from "@/lib/preview/engine/dataRefusal";
import type { PreviewSearchSessionValues } from "@/lib/preview/engine/identity";
import {
	expressionLookupsCovered,
	lookupOptionsSourceCovered,
	predicateLookupsCovered,
} from "@/lib/preview/engine/lookupEvaluation";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";
import {
	type PreviewSearchEnvironment,
	resolveSearchHiddenValues,
	resolveSearchInputChoices,
	resolveSearchInputDefaults,
} from "@/lib/preview/engine/searchExpressionEvaluation";
import { readSearchScreenConditionsAtOpen } from "@/lib/preview/engine/searchInputConstraints";
import type { LookupChoice } from "@/lib/preview/engine/types";

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
	const admitted = retainAllowed(next, base.allowedKeys);
	// SearchInputForm recognizes its controlled acknowledgement by identity.
	// Copy only when admission actually removes a key, or an earlier echo can
	// replace a newer local answer that arrived during its debounce.
	const draft = admitted.size === next.size ? next : admitted;
	return {
		...base,
		draft,
		submitted: submit ? draft : base.submitted,
		submittedHidden: submit ? desired.resolveHidden() : base.submittedHidden,
		hasSubmitted: submit ? true : base.hasSubmitted,
		touched: changedKeys(base.draft, draft, base.touched, base.keyShapes),
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
		touched: changedKeys(base.draft, draft, base.touched, base.keyShapes),
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
	environment: PreviewSearchEnvironment,
	/** The starting values the screen opened with, where its opening has
	 *  read them (`openSearchRunState`); otherwise each is read here. */
	startingValues?: SearchInputValues,
): SearchRunState {
	const keyShapes = new Map<string, string>();
	for (const input of searchInputs) {
		// A hidden input has no draft key: the worker never answers it. Its
		// value is resolved at submit, and a constraint judged over the draft
		// seeds it itself (`emitPreviewSearchPredicate`).
		if (input.kind === "hidden") continue;
		const shape = `${input.uuid}:${input.type}`;
		if (input.type === "date-range") {
			keyShapes.set(`${input.name}:from`, shape);
			keyShapes.set(`${input.name}:to`, shape);
			keyShapes.set(`${input.name}:starting`, shape);
			keyShapes.set(`${input.name}:opening`, shape);
		} else {
			keyShapes.set(input.name, shape);
		}
	}
	const allowedKeys = new Set(keyShapes.keys());
	const defaults =
		startingValues ??
		resolveSearchInputDefaults(searchInputs, session, environment);
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
			resolveSearchHiddenValues(searchInputs, session, environment),
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

/** The answers a worker gives on a Search screen, by key: each field's
 *  name, a date range's two ends apart. A hidden field has none: the worker
 *  never answers it, and its value is resolved at submit. */
export function searchInputAnswerKeys(
	searchInputs: readonly SearchInputDef[],
): Set<string> {
	const keys = new Set<string>();
	for (const input of searchInputs) {
		if (input.kind === "hidden") continue;
		if (input.type === "date-range") {
			keys.add(`${input.name}:from`);
			keys.add(`${input.name}:to`);
		} else keys.add(input.name);
	}
	return keys;
}

/** Every key a query's prompts answer by: the answers the worker gives
 *  (`searchInputAnswerKeys`) and each hidden field's name, since Nova emits a
 *  hidden field as a prompt of its own (`<prompt hidden="true">`), which Core
 *  answers as it answers any prompt (`QueryScreen.answerPrompts` walks every
 *  prompt). */
export function searchPromptKeys(
	searchInputs: readonly SearchInputDef[],
): Set<string> {
	const keys = searchInputAnswerKeys(searchInputs);
	for (const input of searchInputs) {
		if (input.kind === "hidden") keys.add(input.name);
		else if (input.type === "date-range") {
			keys.add(input.name + ":starting");
			keys.add(input.name + ":opening");
		}
	}
	return keys;
}

/**
 * The Search screen's run state as the screen opens, having made every read
 * Core's query manager makes there (`RemoteQuerySessionManager.java`'s
 * constructor): each prompt's starting value and each hidden value
 * (`initUserAnswers`), then each choice prompt's rows
 * (`refreshItemSetChoices` → `populateItemSetChoices`, through
 * `searchExpressionEvaluation.ts::resolveSearchInputChoices`: a table with no
 * rows, or a row filter over data the device lacks, is
 * `ItemSetUtils.populateDynamicChoices`' refusal), letting go of each chosen
 * value of a starting value the rows do not offer (`checkForValidSelectValue`,
 * `searchStartingValuesOffered`), then each required condition and the
 * check of each prompt a starting value still answers
 * (`validateUserAnswers`,
 * `searchInputConstraints.ts::readSearchScreenConditionsAtOpen`). A read of
 * data the worker's device lacks throws Core's refusal, which stops the
 * screen on Web Apps and Android alike, whatever the screen goes on to show:
 * Formplayer's `QueryScreen.init` builds the manager before an automatic
 * search runs, so skip to results refuses as search first does. The screen
 * opens only over lookup data that covers what it reads
 * (`searchScreenOpeningCovered`); a reader that cannot wait for it (the
 * running screen whose lookup load failed) gets the reads the data covers.
 */
export function openSearchRunState(
	scopeKey: string,
	searchInputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	environment: PreviewSearchEnvironment,
	openedRanges?: ReadonlyMap<Uuid, Readonly<Record<string, string>>>,
): SearchRunState {
	const read = resolveSearchInputDefaults(
		searchInputs,
		session,
		environment,
		undefined,
		openedRanges,
	);
	resolveSearchHiddenValues(searchInputs, session, environment);
	const choices = new Map<string, readonly LookupChoice[]>();
	for (const input of searchInputs) {
		if (input.kind === "hidden" || !("options" in input)) continue;
		const offered = resolveSearchInputChoices(input, session, environment);
		if (offered !== undefined) choices.set(input.name, offered);
	}
	const failed = searchStartingChoicesFail(searchInputs, read, choices);
	if (failed !== undefined)
		throw new PreviewDataRefusal({
			kind: "unoffered-starting-choice",
			inputUuid: failed.uuid,
			input: failed.label || failed.name,
		});
	const opened = buildSearchRunState(
		scopeKey,
		searchInputs,
		session,
		environment,
		searchStartingValuesOffered(read, choices),
	);
	readSearchScreenConditionsAtOpen(
		searchInputs,
		opened.defaults,
		session,
		environment,
	);
	return opened;
}

/**
 * The starting values once each choice prompt's rows are read: a chosen
 * value the rows do not offer is let go, and a starting value left with no
 * chosen value is none, as Core's `refreshItemSetChoices` does before it
 * judges a required condition or a check
 * (`RemoteQuerySessionManager.checkForValidSelectValue`, over the answer
 * split at `ANSWER_DELIMITER` as `extractMultipleChoices` splits it with
 * Java's `String.split`, a single choice's answer included). Core repeats
 * the pass until no value changes; a choice list here reads no answer, so
 * one pass settles it. Core gives that repeat as many passes as the screen
 * has prompts, so on a screen of one prompt a value it lets go fails the
 * screen instead (`searchStartingChoicesFail`).
 */
export function searchStartingValuesOffered(
	startingValues: SearchInputValues,
	choices: ReadonlyMap<string, readonly LookupChoice[]>,
): SearchInputValues {
	let offered: Map<string, string> | undefined;
	for (const [name, rows] of choices) {
		const value = startingValues.get(name);
		if (value === undefined) continue;
		const chosen = javaSplit(
			value,
			MULTI_SELECT_SEARCH_ANSWER_DELIMITER,
		).filter(
			(token) => token === "" || rows.some((row) => row.value === token),
		);
		const kept =
			chosen.length > 0 ? joinMultiSelectSearchAnswer(chosen) : undefined;
		if (kept === value) continue;
		offered ??= new Map(startingValues);
		if (kept === undefined) offered.delete(name);
		else offered.set(name, kept);
	}
	return offered ?? startingValues;
}

/**
 * The field whose starting choice fails the Search screen, if one does.
 * Core's `RemoteQuerySessionManager.refreshItemSetChoices` repeats its choice
 * pass while a pass lets a value go, and gives it one pass for each prompt
 * the query holds (every Search field, a hidden one included: each is a
 * `<prompt>`, `suite/case-search/searchPrompts.ts::buildSearchPrompts`),
 * throwing "Invalid itemset state" when it is still letting values go after
 * that many. A choice list here reads no answer, so the pass after the one
 * that lets the starting choices go lets nothing go: two passes settle any
 * screen, and only a screen of one prompt fails, as soon as its one field
 * starts on a choice its list does not offer. Formplayer then answers the
 * screen with that error, and Android's `QueryRequestActivity`, which
 * catches only an `XPathException` as it builds the manager, stops the app.
 */
export function searchStartingChoicesFail(
	searchInputs: readonly SearchInputDef[],
	startingValues: SearchInputValues,
	choices: ReadonlyMap<string, readonly LookupChoice[]>,
): SearchInputDef | undefined {
	/* The pass that lets a value go is dirty, and the next one is clean. */
	const passesGiven = searchInputs.length;
	if (passesGiven >= 2) return undefined;
	return searchInputs.find((input) => {
		const rows = choices.get(input.name);
		const value = startingValues.get(input.name);
		if (rows === undefined || value === undefined) return false;
		/* `checkForValidSelectValue`: a blank choice is always valid. */
		return javaSplit(value, MULTI_SELECT_SEARCH_ANSWER_DELIMITER).some(
			(token) => token !== "" && !rows.some((row) => row.value === token),
		);
	});
}

/** Java's `String.split` over a literal separator: trailing empty parts are
 *  dropped, leading and inner ones kept. */
function javaSplit(value: string, separator: string): string[] {
	const parts = value.split(separator);
	while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}

/**
 * Whether the lookup data covers everything the Search screen reads as it
 * opens (`openSearchRunState`): each starting value, hidden value, choice
 * list, required condition and check. Until it does the screen has not
 * opened, as Core's query manager is built over the fixtures the device
 * holds: it holds no field, refuses nothing and runs no automatic search.
 */
export function searchScreenOpeningCovered(
	searchInputs: readonly SearchInputDef[],
	environment: Pick<PreviewSearchEnvironment, "lookup">,
	openedRanges?: ReadonlyMap<Uuid, Readonly<Record<string, string>>>,
): boolean {
	const lookup = environment.lookup;
	for (const input of searchInputs) {
		if (input.kind === "hidden") {
			if (!expressionLookupsCovered(input.value, lookup)) return false;
			continue;
		}
		const start = searchInputDefault(input);
		if (
			start !== undefined &&
			!openedRanges?.has(input.uuid) &&
			!expressionLookupsCovered(start, lookup)
		)
			return false;
		if (
			"options" in input &&
			!lookupOptionsSourceCovered(
				input.options,
				lookup,
				searchInputLookupSortColumnId(input.options),
			)
		)
			return false;
		const when = input.required?.when;
		if (when !== undefined && !predicateLookupsCovered(when, lookup))
			return false;
		const rule = input.validation?.rule;
		if (rule !== undefined && !predicateLookupsCovered(rule, lookup))
			return false;
	}
	return true;
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
	keyShapes: ReadonlyMap<string, string>,
): ReadonlySet<string> {
	const changed = new Set<string>();
	for (const [key, shape] of keyShapes)
		if (previous.get(key) !== next.get(key)) changed.add(shape);
	// Both ends belong to the same answer. Refreshing the worker's untouched
	// end from a different starting expression would construct a new range.
	const touched = new Set(priorTouched);
	for (const [key, shape] of keyShapes)
		if (changed.has(shape)) touched.add(key);
	return touched;
}

export function hasNonEmptyValue(values: SearchInputValues): boolean {
	return [...values].some(
		([key, value]) => !key.endsWith(":opening") && value !== "",
	);
}
