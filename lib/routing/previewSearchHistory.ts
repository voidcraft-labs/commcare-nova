/**
 * Which of Preview's searches stand on a browser history entry. Web Apps
 * keeps a search's query data on the page's address, so Back and Forward
 * return to each entry with the searches it was written with
 * (`cloudcare/js/formplayer/utils/utils.js::CloudcareUrl.fromJson`), and a
 * step forward carries the entry's searches on. Preview keeps each search's
 * context once, in the session store (`previewSearchStates`), and records on
 * each entry the searches (by `submission`) that stand on it
 * (`lib/preview/searchStanding.ts` decides which).
 *
 * The record rides the entry's state beside the held form menu and is not a
 * mark `builderEntryState` drops: a pushed entry inherits the searches of
 * the entry it was pushed from, as Web Apps' `addSelection` keeps the
 * address's query data, and the screen it lands on lets go of the searches
 * off its path. A submission is unique across every search Preview runs, so
 * an entry an earlier session or Project wrote names no search the session
 * now holds.
 *
 * A form's submission ends the searches it was opened under on the next
 * screen alone: Web Apps clears the query data of the address it pushes
 * after a submission (`app.js`'s submit handler: `urlObject.onSubmit()`, then
 * `setUrlToObject`), while every earlier entry keeps its own, so Back still
 * returns to them. The form's entry records that end (`__novaPreviewSearchesEnd`,
 * the searches its next step carries: those begun on it after the
 * submission, such as a search a registration re-keys to its case), and the
 * next write from it consumes the mark (`previewSearchHistoryWrite`).
 *
 * The session keeps one context per module, the search its list runs now, so
 * a search the session has since replaced (the menu's default search run
 * again after a submission or a crumb, which Web Apps sends no query data
 * for) would be gone when history returns to an entry it stood on. Each
 * entry therefore also records the context of each search standing on it,
 * with the Preview session that ran it (`__novaPreviewSearchContexts`), and
 * an entry's search stands where the session no longer holds it
 * (`previewSearchesOnEntry`), as Web Apps answers a query its address still
 * holds from the inputs the page keeps for it (`CloudcareUrl.fromJson`,
 * `Utils.getCurrentQueryInputs`, which no submission, crumb or Home clears).
 */

import type { PreviewSearchState } from "@/lib/session/types";

const STANDING_SEARCHES_STATE_KEY = "__novaPreviewSearches";
const SEARCHES_END_STATE_KEY = "__novaPreviewSearchesEnd";
const SEARCH_CONTEXTS_STATE_KEY = "__novaPreviewSearchContexts";

/** A search's context as an entry records it: its module, the Preview
 *  session that ran it, and the context itself. */
export interface RecordedPreviewSearch {
	readonly moduleUuid: string;
	readonly session: string;
	readonly state: Exclude<PreviewSearchState, { kind: "not-searched" }>;
}

const RECORDED_KINDS: ReadonlySet<string> = new Set([
	"action",
	"manual",
	"running",
	"failed",
	"completed",
]);

function recordedSearchOf(value: unknown): RecordedPreviewSearch | undefined {
	const record = recordOf(value);
	const state = recordOf(record.state);
	return typeof record.moduleUuid === "string" &&
		typeof record.session === "string" &&
		typeof state.kind === "string" &&
		RECORDED_KINDS.has(state.kind) &&
		typeof state.submission === "string"
		? (record as unknown as RecordedPreviewSearch)
		: undefined;
}

/** The contexts an entry records, by submission, of searches standing on it. */
export function readPreviewSearchContexts(
	state: unknown,
): Readonly<Record<string, RecordedPreviewSearch>> {
	const recorded = recordOf(recordOf(state)[SEARCH_CONTEXTS_STATE_KEY]);
	const contexts: Record<string, RecordedPreviewSearch> = {};
	for (const submission of readPreviewStandingSearches(state)) {
		const search = Object.hasOwn(recorded, submission)
			? recordedSearchOf(recorded[submission])
			: undefined;
		if (search !== undefined && search.state.submission === submission)
			contexts[submission] = search;
	}
	return contexts;
}

/**
 * The module searches the screen on an entry holds: the session's own
 * context of each module where it stands on the entry, or where the session
 * no longer holds the search that stands there (a later search, or the
 * menu's default search run again, replaced it), the context the entry
 * recorded for it in the running Preview session. A search another session
 * ran stands nowhere (`previewSessionId`).
 */
export function previewSearchesOnEntry(
	sessionStates: Readonly<Record<string, PreviewSearchState>>,
	standing: ReadonlySet<string>,
	contexts: Readonly<Record<string, RecordedPreviewSearch>>,
	session: string,
): Readonly<Record<string, PreviewSearchState>> {
	let held: Record<string, PreviewSearchState> | undefined;
	for (const [submission, recorded] of Object.entries(contexts)) {
		if (!standing.has(submission) || recorded.session !== session) continue;
		const own = sessionStates[recorded.moduleUuid];
		if (
			own !== undefined &&
			own.kind !== "not-searched" &&
			standing.has(own.submission)
		)
			continue;
		held ??= { ...sessionStates };
		held[recorded.moduleUuid] = recorded.state;
	}
	return held ?? sessionStates;
}

function recordOf(state: unknown): Record<string, unknown> {
	return typeof state === "object" && state !== null
		? (state as Record<string, unknown>)
		: {};
}

function stringsOf(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: undefined;
}

/** The searches a history entry's state records as standing on it. */
export function readPreviewStandingSearches(state: unknown): string[] {
	return stringsOf(recordOf(state)[STANDING_SEARCHES_STATE_KEY]) ?? [];
}

/** The entry's state recording exactly these searches as standing on it,
 *  with the contexts it records of them, everything else it carries kept. */
export function withPreviewStandingSearches(
	state: unknown,
	submissions: readonly string[],
): Record<string, unknown> {
	const {
		[STANDING_SEARCHES_STATE_KEY]: _recorded,
		[SEARCH_CONTEXTS_STATE_KEY]: _contexts,
		...rest
	} = recordOf(state);
	if (submissions.length === 0) return rest;
	const known = readPreviewSearchContexts(state);
	const contexts: Record<string, RecordedPreviewSearch> = {};
	for (const submission of submissions)
		if (Object.hasOwn(known, submission))
			contexts[submission] = known[submission];
	return {
		...rest,
		[STANDING_SEARCHES_STATE_KEY]: [...submissions],
		...(Object.keys(contexts).length > 0 && {
			[SEARCH_CONTEXTS_STATE_KEY]: contexts,
		}),
	};
}

/** The searches a step forward from this entry carries on: every search
 *  standing on it, or, where a submission ended them there, only those of
 *  them begun on it since. */
export function previewSearchesCarriedOn(state: unknown): string[] {
	const standing = readPreviewStandingSearches(state);
	const end = stringsOf(recordOf(state)[SEARCHES_END_STATE_KEY]);
	return end === undefined
		? standing
		: standing.filter((submission) => end.includes(submission));
}

/** The entry's state once a form submitted on it has ended every search it
 *  was opened under: the entry keeps them, for Back and Forward, and its
 *  next step carries none of them on. */
export function withPreviewSearchesEnded(
	state: unknown,
): Record<string, unknown> {
	return { ...recordOf(state), [SEARCHES_END_STATE_KEY]: [] };
}

/** The entry's state once a search is begun on it, or its context changes
 *  there: standing there, beside those of `standing` it keeps, with the
 *  context it now has, and carried on by its next step, after a
 *  submission's end as before one. */
export function withPreviewSearchBegun(
	state: unknown,
	standing: readonly string[],
	search: RecordedPreviewSearch,
): Record<string, unknown> {
	const submission = search.state.submission;
	const recorded = withPreviewStandingSearches(
		state,
		standing.includes(submission) ? standing : [...standing, submission],
	);
	const withContext: Record<string, unknown> = {
		...recorded,
		[SEARCH_CONTEXTS_STATE_KEY]: {
			...readPreviewSearchContexts(recorded),
			[submission]: search,
		},
	};
	const end = stringsOf(withContext[SEARCHES_END_STATE_KEY]);
	return end === undefined || end.includes(submission)
		? withContext
		: { ...withContext, [SEARCHES_END_STATE_KEY]: [...end, submission] };
}

/** The entry's state without a submission's end, once the step that ends
 *  the searches has been taken from it. */
export function withoutPreviewSearchesEnd(
	state: unknown,
): Record<string, unknown> {
	const { [SEARCHES_END_STATE_KEY]: _end, ...rest } = recordOf(state);
	return rest;
}

/**
 * The searches one builder history write records, from the entry it was
 * written from (`current`; `written` is the rest of the new entry's state,
 * `previewHeldMenu.ts::builderEntryState`):
 *
 * - a language change (`lens`) keeps the screen, and so its record, a
 *   submission's end included;
 * - any other write is the next step, and records what the entry carries on
 *   (`previewSearchesCarriedOn`), with no end of its own;
 * - a push leaves the entry it was written from behind, which keeps its
 *   searches for Back and Forward and drops a submission's end, the step it
 *   waited for having been taken (`consumesEnd`: the entry left behind is
 *   `withoutPreviewSearchesEnd` of it), so a later step from it carries its
 *   searches on again, as a step from an earlier Web Apps address carries
 *   its query data.
 */
export function previewSearchHistoryWrite(
	current: unknown,
	written: Record<string, unknown>,
	write: "push" | "replace" | "lens",
): {
	readonly written: Record<string, unknown>;
	readonly consumesEnd: boolean;
} {
	if (write === "lens") return { written, consumesEnd: false };
	return {
		written: withPreviewStandingSearches(
			withoutPreviewSearchesEnd(written),
			previewSearchesCarriedOn(current),
		),
		consumesEnd:
			write === "push" && SEARCHES_END_STATE_KEY in recordOf(current),
	};
}
