/**
 * Client-side path subscription — replaces `useSearchParams()` for
 * intra-builder navigation.
 *
 * Uses `useSyncExternalStore` to subscribe to `window.location.pathname`
 * changes. Re-renders happen on:
 *   - `popstate` events (browser back/forward)
 *   - Explicit `notifyPathChange()` calls after `pushState`/`replaceState`
 *
 * This avoids Next.js's `useSearchParams`/`useRouter`, which trigger
 * server-side RSC re-renders on every navigation.
 *
 * It is also the only writer of the builder's history entries, and every
 * write goes through `writeHistory`, which keeps in the entry only what
 * `builderHistoryState.ts` names: identifiers and topology. What a Preview
 * entry was shown with is filed in the running Preview session's records
 * (`previewEntryRecords.ts`) under the entry's id.
 */
"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PreviewHeldCaseListMenu } from "@/lib/preview/menuProjection";
import { sealedBuilderHistoryState } from "./builderHistoryState";
import {
	type BuilderHistoryScope,
	builderNavigationUrl,
	reconcileBuilderHistoryEntry,
	scopedBuilderHistoryState,
} from "./historyPolicy";
import {
	heldPreviewEntryRecords,
	newPreviewEntry,
	PREVIEW_ENTRY_STATE_KEY,
	type PreviewEntryRecord,
	type PreviewEntryRecordOf,
	type PreviewHistoryEntry,
	previewEntryOf,
	previewEntryRecordReader,
	previewEntryRecordsToRead,
	previewEntryRecordsToWrite,
	type RecordedPreviewSearch,
	type RecordedSearchResultDetail,
} from "./previewEntryRecords";
import {
	type BuilderHistoryWrite,
	builderEntryState,
	previewHeldMenuBack,
	previewHeldMenuIsPrevious,
	previewHeldMenuStands,
	readPreviewHeldMenu,
	stepsBackToPrevious,
} from "./previewHeldMenu";
import {
	previewSearchHistoryWrite,
	readPreviewSearchContexts,
	readPreviewStandingSearches,
	withoutPreviewSearchesEnd,
	withPreviewSearchBegun,
	withPreviewSearchesEnded,
	withPreviewStandingSearches,
} from "./previewSearchHistory";
import {
	type RecordedPreviewSelections,
	samePreviewSelections,
} from "./previewSelectionsHistory";

/** The one write of a builder history entry: whatever state a writer
 *  computed, the browser keeps only the identifiers and topology
 *  `builderHistoryState.ts` names, beside the framework's own keys. */
function writeHistory(
	method: "push" | "replace",
	state: unknown,
	url: string,
): void {
	const sealed = sealedBuilderHistoryState(state);
	if (method === "push") window.history.pushState(sealed, "", url);
	else window.history.replaceState(sealed, "", url);
}

/** The records of the running Preview session `session`, to read. */
function recordsToRead(session: string): PreviewEntryRecordOf {
	return previewEntryRecordReader(previewEntryRecordsToRead(session));
}

/** Module-level listener set for notifying subscribers of programmatic
 *  `pushState`/`replaceState` calls (which don't fire `popstate`). */
const listeners = new Set<() => void>();

let cachedSegmentsPathname: string | undefined;
let cachedSegments: string[] = [];

let activeProjectScope: BuilderHistoryScope | null = null;

/** Counts every move to another history entry or screen: a builder write,
 * Back and Forward, and a Project generation's reconcile. A language change
 * keeps the screen on show, and a record of standing searches rewrites the
 * entry in place, so neither is a move. */
let builderHistoryMoves = 0;

/** Where the worker is in the builder's history, for work that continues
 * after an await (a claim landing): the value read when it began differs
 * from the current one once the worker has moved meanwhile, so the work
 * that would navigate from the screen it began on is dropped. */
export function readBuilderHistoryMove(): number {
	return builderHistoryMoves;
}

/** How the builder last moved to the screen on show: `back` for Back and
 * Forward and for a screen's own step back (`stepBackToBuilderEntry`),
 * `forward` for every other move. A list reads it as it shows again, to keep
 * or start afresh the worker's place in it (`lib/preview/caseListReturn.ts`). */
let builderHistoryArrival: "back" | "forward" = "forward";

export function readBuilderHistoryArrival(): "back" | "forward" {
	return builderHistoryArrival;
}

function reconcileHistory(event: "activate" | "pop"): boolean {
	const { pathname, search } = window.location;
	const replacement = reconcileBuilderHistoryEntry(
		{ pathname, search, state: window.history.state },
		activeProjectScope,
		event,
	);
	if (!replacement) return false;
	builderHistoryMoves += 1;
	writeHistory("replace", replacement.state, replacement.url);
	return replacement.url !== `${pathname}${search}`;
}

/** Work that must see a popped entry before any screen renders it. */
const popListeners = new Set<() => void>();

/** The popstate the builder has taken in, so it is taken in once. */
let poppedEvent: Event | null = null;

function onPopState(event: Event): void {
	if (event === poppedEvent) return;
	poppedEvent = event;
	builderHistoryMoves += 1;
	builderHistoryArrival = "back";
	reconcileHistory("pop");
	for (const listener of popListeners) listener();
	notifyPathChange();
}

/**
 * A Back or Forward the browser is still dispatching that the builder has not
 * taken in. The builder's popstate listener is one of several on the window,
 * which run in the order they were added: Next's App Router adds its own at
 * hydration, before any builder screen subscribes, and react-dom renders the
 * transition that listener starts in the microtask right after it returns,
 * while the popstate is still the window's current event
 * (`shouldAttemptEagerTransition`, which reads `window.event` as this does).
 * That render reaches builder screens before the pop listeners have returned
 * the popped entry's facts to the session.
 */
function popPending(): boolean {
	const event = window.event;
	return (
		event?.type === "popstate" && event !== poppedEvent && listeners.size > 0
	);
}

/** Take in a pending Back or Forward now, so the write that follows lands on
 *  the popped entry after its facts have returned to the session. */
function takeInPendingPop(): void {
	const event = window.event;
	if (event !== undefined && popPending()) onPopState(event);
}

interface ViewedEntry {
	readonly pathname: string;
	readonly search: string;
	readonly state: unknown;
}

/** The history entry as the builder last took it in. */
let viewed: ViewedEntry | null = null;

function seeCurrentEntry(): ViewedEntry {
	const { pathname, search } = window.location;
	const state: unknown = window.history.state;
	if (
		viewed === null ||
		viewed.pathname !== pathname ||
		viewed.search !== search ||
		viewed.state !== state
	)
		viewed = { pathname, search, state };
	return viewed;
}

/**
 * The current history entry, as every builder screen reads it. While a Back
 * or Forward is pending (`popPending`) it stays the entry the builder last
 * took in, so a render reaching the builder first shows the entry the session
 * still belongs to; the popped entry reaches the screens once the pop
 * listeners have returned its facts. A render of the popped entry with the
 * session of the entry the worker left would show the wrong cases, and its
 * record of the session's selections (`usePreviewSelectionsArrival`) would
 * overwrite the very record the pop listeners return.
 */
function viewedEntry(): ViewedEntry {
	if (viewed !== null && popPending()) return viewed;
	return seeCurrentEntry();
}

/** Run `listener` on every Back and Forward, once the entry is reconciled
 * to the active Project and before the path subscribers render it: a
 * session fact the entry carries (`previewSelectionsHistory.ts`) is then in
 * place for the screen's first render on that entry, as Web Apps sends a
 * popped address's selections with the request that draws its screen. */
export function subscribeBuilderHistoryPop(listener: () => void): () => void {
	popListeners.add(listener);
	return () => {
		popListeners.delete(listener);
	};
}

function subscribe(callback: () => void): () => void {
	if (listeners.size === 0) window.addEventListener("popstate", onPopState);
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
		if (listeners.size === 0)
			window.removeEventListener("popstate", onPopState);
	};
}

/** Imperative subscription for hooks that project URL state together with
 * document topology. Keeping this on the same listener set preserves the one
 * `popstate` listener invariant. */
export function subscribeBuilderPathChange(callback: () => void): () => void {
	return subscribe(callback);
}

function getSnapshot(): string {
	return viewedEntry().pathname;
}

function getServerSnapshot(): string {
	/* Safe SSR fallback — the builder always mounts at /build/{id}, so
	 * an empty sub-path (home screen) is the correct default. The actual
	 * pathname is hydrated on the first client render. */
	return "/build/new";
}

/**
 * Call after every `pushState` / `replaceState` to notify all
 * `useBuilderPathSegments` subscribers that the URL has changed.
 *
 * Without this, programmatic navigation wouldn't trigger re-renders
 * because the browser only fires `popstate` on back/forward — not
 * on `pushState`/`replaceState`.
 */
export function notifyPathChange(): void {
	seeCurrentEntry();
	for (const fn of listeners) fn();
}

/** Activate/advance the history authorization generation. Called by the
 * reconciler reset registry, so the current source case id is scrubbed in the
 * same synchronous boundary stack. */
export function activateBuilderHistoryScope(
	scopeId: string,
	appId: string | undefined,
	epoch: number,
): void {
	activeProjectScope = { scopeId, appId: appId ?? null, epoch };
	if (reconcileHistory("activate")) notifyPathChange();
}

export function deactivateBuilderHistoryScope(scopeId: string): void {
	if (activeProjectScope?.scopeId === scopeId) activeProjectScope = null;
}

/** A case list's held form menu a write opens, with the Preview session
 *  that holds it, whose records the entry's record is filed in. */
export interface PreviewHeldMenuWrite {
	readonly menu: PreviewHeldCaseListMenu;
	readonly session: string;
}

/** The current entry as the builder writes from it: its state, scoped to
 *  the active Project, and its record in `records`. */
function currentEntry(
	records: ReadonlyMap<string, PreviewEntryRecord>,
): PreviewHistoryEntry {
	const state = scopedBuilderHistoryState(
		window.history.state,
		activeProjectScope,
	);
	return {
		state,
		record: previewEntryRecordReader(records)(previewEntryOf(state)),
	};
}

/** A builder history write from the current entry: the new entry
 * (`previewHeldMenu.ts::builderEntryState`) with the searches the write
 * carries on, its record filed under its new id, and whether a push consumes
 * a submission's end on the entry it leaves
 * (`previewSearchHistory.ts::previewSearchHistoryWrite`). A write that opens
 * a held menu reads and files records in that menu's session; any other
 * carries the current entry's record on in the session it belongs to. */
function writtenState(
	write: (relative: string) => BuilderHistoryWrite,
	relative: string,
	session: string | undefined,
	resultDetail?: RecordedSearchResultDetail,
): { readonly state: Record<string, unknown>; readonly consumesEnd: boolean } {
	const records =
		session === undefined
			? heldPreviewEntryRecords()
			: previewEntryRecordsToWrite(session);
	const current = currentEntry(records);
	const written = write(new URL(relative, window.location.href).pathname);
	const searches = previewSearchHistoryWrite(
		current,
		builderEntryState(
			{ pathname: window.location.pathname, ...current },
			written,
			previewEntryRecordReader(records),
		),
		"lens" in written ? "lens" : written.replace ? "replace" : "push",
	);
	const entry = previewEntryOf(searches.written.state);
	if (entry !== undefined)
		records.set(
			entry,
			resultDetail === undefined
				? searches.written.record
				: { ...searches.written.record, searchResultDetail: resultDetail },
		);
	return { state: searches.written.state, consumesEnd: searches.consumesEnd };
}

/** The entry a push leaves keeps its searches for Back and Forward, and its
 *  next step after them carries them on again. */
function consumePreviewSearchesEnd(): void {
	writeHistory(
		"replace",
		withoutPreviewSearchesEnd(window.history.state),
		window.location.href,
	);
}

/** The only write path for intra-builder screen history. An entry's record
 * holds a Preview case list's held form menu only where the write names one
 * (`previewHeldMenu.ts`); every other entry's holds none. */
export function pushBuilderHistory(
	url: string,
	replace = false,
	heldMenu?: PreviewHeldMenuWrite,
	searchResult?: {
		readonly detail: RecordedSearchResultDetail;
		readonly session: string;
	},
): void {
	writeBuilderHistory(url, replace, heldMenu, "forward", searchResult);
}

function writeBuilderHistory(
	url: string,
	replace: boolean,
	heldMenu: PreviewHeldMenuWrite | undefined,
	arrival: "back" | "forward",
	searchResult?: {
		readonly detail: RecordedSearchResultDetail;
		readonly session: string;
	},
): void {
	takeInPendingPop();
	const relative = builderNavigationUrl(url, window.location.href);
	const { state, consumesEnd } = writtenState(
		(pathname) => ({ pathname, replace, held: heldMenu?.menu }),
		relative,
		heldMenu?.session ?? searchResult?.session,
		searchResult?.detail,
	);
	builderHistoryMoves += 1;
	builderHistoryArrival = arrival;
	if (replace) writeHistory("replace", state, relative);
	else {
		if (consumesEnd) consumePreviewSearchesEnd();
		writeHistory("push", state, relative);
	}
	notifyPathChange();
}

/** A write that keeps the screen on show and changes only its lens (a
 * language): a new entry whose record keeps the held form menu the current
 * entry's holds, one lens deeper (`previewHeldMenu.ts`). */
export function pushBuilderLensHistory(url: string): void {
	takeInPendingPop();
	const relative = builderNavigationUrl(url, window.location.href);
	const { state } = writtenState(
		(pathname) => ({ pathname, lens: true }),
		relative,
		undefined,
	);
	writeHistory("push", state, relative);
	notifyPathChange();
}

/** A device's Back off a Preview case list's held form menu
 * (`previewHeldMenu.ts::previewHeldMenuBack`), in the Preview session
 * `session` running now: back past every entry of the menu's one step, its
 * language changes included, to its list's entry before it, which takes the
 * menu's language as it lands, since a device's Back keeps the language the
 * worker reads; or, where no list entry is behind the menu (a menu a crumb
 * opened again from a form, a deep-linked case's details with nothing before
 * them), the menu's entry becomes the list's. */
export function stepBackOffPreviewHeldMenu(session: string): void {
	takeInPendingPop();
	const { pathname, search } = window.location;
	const back = previewHeldMenuBack(
		window.history.state,
		recordsToRead(session),
	);
	if (back.kind === "show-list") {
		writeBuilderHistory(`${pathname}${search}`, true, undefined, "back");
		return;
	}
	/* The entry stepped back to exists, so the step always fires one
	 * popstate, the listener's first and last. */
	const keepLens = () => {
		window.removeEventListener("popstate", keepLens);
		if (
			window.location.pathname !== pathname ||
			window.location.search === search
		)
			return;
		writeHistory(
			"replace",
			window.history.state,
			`${pathname}${search}${window.location.hash}`,
		);
		notifyPathChange();
	};
	window.addEventListener("popstate", keepLens);
	window.history.go(-back.steps);
}

/** The crumb of the case a Preview case list's form menu holds, in the
 * Preview session `session` running now: where the entry before this one is
 * that menu's own (a form opened from it), a step back onto it, as a device's
 * step back off the form lands there; otherwise the menu on an entry of its
 * own (`previewHeldMenu.ts`). */
export function reopenPreviewHeldMenu(
	url: string,
	held: PreviewHeldCaseListMenu,
	session: string,
): void {
	takeInPendingPop();
	if (
		previewHeldMenuIsPrevious(
			window.history.state,
			held,
			recordsToRead(session),
		)
	) {
		/* The entry behind can have changed since the form was pushed (the
		 * menu's own Back showed the list in it, and Forward came back here):
		 * where the step lands on an entry that no longer holds the menu, the
		 * menu opens again on an entry of its own. The step always fires one
		 * popstate, after the path listener's. */
		const checkLanding = () => {
			window.removeEventListener("popstate", checkLanding);
			if (
				!previewHeldMenuStands(
					window.history.state,
					held,
					recordsToRead(session),
				)
			)
				pushBuilderHistory(url, false, { menu: held, session });
		};
		window.addEventListener("popstate", checkLanding);
		window.history.back();
		return;
	}
	pushBuilderHistory(url, false, { menu: held, session });
}

/** A screen's own Back to the screen it was opened from, at `url`, in the
 * Preview session `session` running now: where the entry this screen was
 * pushed after is that screen (`previewHeldMenu.ts::stepsBackToPrevious`), a
 * step back onto it, so history holds the screen once and the browser's next
 * Back goes on past it, as a device's next step back does; otherwise `url` in
 * place of this entry. `leave` lets go of what the screen held as the move
 * happens: before the replace, or on the step's popstate before any screen
 * renders the entry it lands on. Where that entry is no longer the screen at
 * `url` (it was replaced since), `url` opens after it; where it shows the
 * screen under an earlier language, it takes the language the worker reads
 * now, as a device's Back keeps it. */
export function stepBackToBuilderEntry(
	url: string,
	leave: () => void,
	session: string,
): void {
	takeInPendingPop();
	const relative = builderNavigationUrl(url, window.location.href);
	const target = new URL(relative, window.location.href);
	const steps = stepsBackToPrevious(
		window.history.state,
		target.pathname,
		recordsToRead(session),
	);
	if (steps === undefined) {
		leave();
		writeBuilderHistory(relative, true, undefined, "back");
		return;
	}
	/* The entry stepped back to exists, so the step fires one popstate,
	 * whose listeners run this once. */
	const land = () => {
		popListeners.delete(land);
		leave();
		if (window.location.pathname !== target.pathname) {
			writeBuilderHistory(relative, false, undefined, "back");
			return;
		}
		if (window.location.search !== target.search)
			writeHistory(
				"replace",
				window.history.state,
				`${target.pathname}${target.search}${window.location.hash}`,
			);
	};
	popListeners.add(land);
	window.history.go(-steps);
}

/** The record of the entry on show in the Preview session `session`. */
function viewedRecord(session: string): PreviewEntryRecord {
	return recordsToRead(session)(previewEntryOf(viewedEntry().state));
}

/** The Preview case list's held form menu the current history entry shows
 * in the Preview session `session` running now (`previewHeldMenu.ts`). It
 * changes with the entry, on a write and on Back and Forward, whose URL
 * stays the list's, so it subscribes to the same notification channel as the
 * path. */
export function usePreviewHeldMenu(
	session: string,
): PreviewHeldCaseListMenu | undefined {
	const snapshot = useCallback(() => {
		const held = readPreviewHeldMenu(
			viewedEntry().state,
			recordsToRead(session),
		);
		return held === undefined ? "" : JSON.stringify(held);
	}, [session]);
	const shown = useSyncExternalStore(subscribe, snapshot, () => "");
	return useMemo(
		() =>
			shown === "" ? undefined : (JSON.parse(shown) as PreviewHeldCaseListMenu),
		[shown],
	);
}

/** The exact Search result attached to the shown entry in this Preview run. */
export function usePreviewSearchResultDetail(
	session: string,
): RecordedSearchResultDetail | undefined {
	const snapshot = useCallback(
		() => viewedRecord(session).searchResultDetail,
		[session],
	);
	return useSyncExternalStore(subscribe, snapshot, () => undefined);
}

/** The current entry, its id minted where it has none (an entry the page
 * loaded on, or one another writer made), so its record has a key. Minting
 * one rewrites only the entry's id: it is no screen write and no move. */
function currentEntryId(): string {
	const named = previewEntryOf(window.history.state);
	if (named !== undefined) return named;
	const entry = newPreviewEntry();
	writeHistory(
		"replace",
		{
			...(typeof window.history.state === "object" &&
			window.history.state !== null
				? (window.history.state as Record<string, unknown>)
				: {}),
			[PREVIEW_ENTRY_STATE_KEY]: entry,
		},
		window.location.href,
	);
	return entry;
}

/** Rewrite the current entry in place, as the records of standing searches
 * do: its state where the names it carries change, and its record in the
 * Preview session `session`. It keeps the entry's address, id, held form
 * menu and the entry it was pushed after, so it is no screen write and does
 * not go through `builderEntryState`. Whether anything changed. */
function rewriteCurrentEntry(
	session: string,
	next: (entry: PreviewHistoryEntry) => PreviewHistoryEntry,
): boolean {
	const entry = currentEntryId();
	const records = previewEntryRecordsToWrite(session);
	const state = window.history.state as Record<string, unknown>;
	const current: PreviewHistoryEntry = {
		state,
		record: previewEntryRecordReader(records)(entry),
	};
	const written = next(current);
	const stateChanged =
		JSON.stringify(sealedBuilderHistoryState(written.state)) !==
		JSON.stringify(sealedBuilderHistoryState(current.state));
	const recordChanged =
		JSON.stringify(written.record) !== JSON.stringify(current.record);
	if (recordChanged) records.set(entry, written.record);
	if (stateChanged)
		writeHistory("replace", written.state, window.location.href);
	return stateChanged || recordChanged;
}

/** Record which of Preview's searches stand on the current history entry
 * (`previewSearchHistory.ts`), and prune its record's contexts in the
 * Preview session `session` to them. */
export function recordPreviewStandingSearches(
	submissions: readonly string[],
	session: string,
): void {
	takeInPendingPop();
	if (
		rewriteCurrentEntry(session, (entry) =>
			withPreviewStandingSearches(entry, submissions),
		)
	)
		notifyPathChange();
}

/** A search begun on the current entry: it stands there beside those of
 * `standing` (the entry's searches still live), with its context in the
 * entry's record in the Preview session `session`, and the entry's next
 * step carries it on, after a submission's end too
 * (`previewSearchHistory.ts::withPreviewSearchBegun`). */
export function beginPreviewStandingSearch(
	standing: readonly string[],
	search: RecordedPreviewSearch,
	session: string,
): void {
	takeInPendingPop();
	if (
		rewriteCurrentEntry(session, (entry) =>
			withPreviewSearchBegun(entry, standing, search),
		)
	)
		notifyPathChange();
}

/** A form submitted on the current entry ends the searches it was opened
 * under: the entry keeps them, and its next step carries none of them on
 * (`previewSearchHistory.ts::withPreviewSearchesEnded`). */
export function endPreviewStandingSearches(): void {
	takeInPendingPop();
	writeHistory(
		"replace",
		withPreviewSearchesEnded(window.history.state),
		window.location.href,
	);
}

/** The searches the current history entry names as standing on it,
 * imperatively, for an event handler. */
export function readCurrentPreviewStandingSearches(): string[] {
	return readPreviewStandingSearches(viewedEntry().state);
}

function standingSearchesSnapshot(): string {
	return readPreviewStandingSearches(viewedEntry().state).join(" ");
}

/** The contexts the current history entry's record holds, in the Preview
 * session `session`, of the searches standing on it. */
function currentSearchContexts(
	session: string,
): Readonly<Record<string, RecordedPreviewSearch>> {
	return readPreviewSearchContexts({
		state: viewedEntry().state,
		record: viewedRecord(session),
	});
}

/** The contexts the current history entry's record holds of the searches
 * standing on it (`previewSearchHistory.ts::readPreviewSearchContexts`), in
 * the Preview session `session`, on writes and on Back and Forward. */
export function usePreviewSearchContexts(
	session: string,
): Readonly<Record<string, RecordedPreviewSearch>> {
	const snapshot = useCallback(
		() => JSON.stringify(currentSearchContexts(session)),
		[session],
	);
	const shown = useSyncExternalStore(subscribe, snapshot, () => "{}");
	return useMemo(
		() => JSON.parse(shown) as Readonly<Record<string, RecordedPreviewSearch>>,
		[shown],
	);
}

/** The contexts the current history entry's record holds, imperatively. */
export function readCurrentPreviewSearchContexts(
	session: string,
): Readonly<Record<string, RecordedPreviewSearch>> {
	return currentSearchContexts(session);
}

/** The searches the current history entry names as standing on it. It
 * changes with the entry, on a write and on Back and Forward, so it
 * subscribes to the same notification channel as the path. */
export function usePreviewStandingSearches(): ReadonlySet<string> {
	const snapshot = useSyncExternalStore(
		subscribe,
		standingSearchesSnapshot,
		() => "",
	);
	return useMemo(
		() => new Set(snapshot === "" ? [] : snapshot.split(" ")),
		[snapshot],
	);
}

/** Record the case selections the current history entry is shown with
 * (`previewSelectionsHistory.ts`), in its record in the session `read`
 * names. A record in place, like that of standing searches: no screen write
 * and no move. `read` reads the session once a pending Back or Forward has
 * been taken in, so the record is of the session the entry shows. */
export function recordPreviewSelections(
	read: () => {
		readonly session: string;
		readonly selections: RecordedPreviewSelections;
	},
): void {
	takeInPendingPop();
	const { session, selections } = read();
	const entry = currentEntryId();
	const records = previewEntryRecordsToWrite(session);
	const record = previewEntryRecordReader(records)(entry);
	if (samePreviewSelections(record.selections, selections)) return;
	records.set(entry, { ...record, selections });
	notifyPathChange();
}

/** The case selections the current history entry's record holds in the
 *  Preview session `session`, imperatively. */
export function readCurrentPreviewSelections(
	session: string,
): RecordedPreviewSelections | undefined {
	return viewedRecord(session).selections;
}

/** The current history entry's record of its case selections in the
 *  Preview session `session`, as a string that changes with the entry (a
 *  write, Back and Forward) and with the record, for an effect that runs on
 *  each arrival. */
export function usePreviewSelectionsSnapshot(session: string): string {
	const snapshot = useCallback(
		() =>
			`${previewEntryOf(viewedEntry().state) ?? ""} ${JSON.stringify(
				viewedRecord(session).selections ?? null,
			)}`,
		[session],
	);
	return useSyncExternalStore(subscribe, snapshot, () => "null");
}

/** URL-owned builder query state. Uses the same history notification channel
 * as pathname navigation so push/replace and back/forward stay coherent. */
export function useBuilderSearch(): string {
	return useSyncExternalStore(
		subscribe,
		() => viewedEntry().search,
		() => "",
	);
}

/** The builder's query string, with the server's own rendering of it for the
 * first paint. The server snapshot is `initialSearch`, the query the page
 * already validated and handed down, so a screen the query names draws on the
 * server and at hydration alike rather than swapping in after it. */
export function useBuilderSearchFrom(initialSearch: string): string {
	return useSyncExternalStore(
		subscribe,
		() => window.location.search,
		() => initialSearch,
	);
}

/**
 * Extract path segments after `/build/{appId}/` from the browser URL.
 *
 * Returns a stable empty array reference when at the root (home screen).
 * The returned array is freshly allocated on every render where the
 * pathname has changed — callers should derive Location objects via
 * `useMemo` over the segments + doc state.
 */
export function useBuilderPathSegments(): string[] {
	const pathname = useSyncExternalStore(
		subscribe,
		getSnapshot,
		getServerSnapshot,
	);
	/* Memoize so the returned array reference is stable when the pathname
	 * hasn't changed. Without this, every re-render (parent, doc store,
	 * etc.) allocates a fresh array via extractSegments, which cascades
	 * through useLocation → useSelect → useIsFieldSelected and defeats
	 * the per-wrapper re-render isolation. */
	return useMemo(() => extractSegments(pathname), [pathname]);
}

/** Read the current Builder sub-path without subscribing the calling
 * component. Navigation actions use this at event time, so merely needing an
 * `openForm` or `up` callback does not re-render a component on every click. */
export function getBuilderPathSegmentsSnapshot(): string[] {
	return extractSegments(getSnapshot());
}

/**
 * Whether the selected identity in the current Builder path names this field.
 * The primitive snapshot is the performance boundary: a path change not
 * affecting this field still notifies the hook, but React sees the same
 * boolean and does not render its subscriber.
 *
 * Field identities are globally unique, so the path does not need the live
 * document to distinguish a selected field from a form or module here. A
 * matching UUID can only belong to this field.
 */
export function useIsBuilderFieldPathSelected(
	uuid: string,
	route?: string | null,
): boolean {
	const getSelectedSnapshot = useCallback(() => {
		const segments = extractSegments(getSnapshot());
		const sharedRoute = segments[1] === "forms" ? segments[0] : null;
		if (route !== undefined && sharedRoute !== route) return false;
		const size = segments.length - (sharedRoute ? 2 : 0);
		return (size === 1 || size === 2) && segments[segments.length - 1] === uuid;
	}, [uuid, route]);
	return useSyncExternalStore(subscribe, getSelectedSnapshot, () => false);
}

/** Stable empty array returned when there are no sub-path segments. */
const EMPTY_SEGMENTS: string[] = [];

/**
 * Extract the path segments after `/build/{appId}/` from a full pathname.
 *
 * pathname = "/build/{appId}" → []
 * pathname = "/build/{appId}/{seg1}/{seg2}" → ["seg1", "seg2"]
 */
function extractSegments(pathname: string): string[] {
	if (pathname === cachedSegmentsPathname) return cachedSegments;
	const parts = pathname.split("/").filter(Boolean);
	/* parts = ["build", appId, ...segments] */
	const segments = parts.slice(2);
	cachedSegmentsPathname = pathname;
	cachedSegments = segments.length === 0 ? EMPTY_SEGMENTS : segments;
	return cachedSegments;
}
