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
 */
"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PreviewHeldCaseListMenu } from "@/lib/preview/menuProjection";
import {
	type BuilderHistoryScope,
	builderNavigationUrl,
	reconcileBuilderHistoryEntry,
	scopedBuilderHistoryState,
} from "./historyPolicy";
import {
	type BuilderHistoryWrite,
	builderEntryState,
	previewHeldMenuBack,
	previewHeldMenuIsPrevious,
	previewHeldMenuOf,
	previewHeldMenuStands,
	readPreviewHeldMenu,
	stepsBackToPrevious,
} from "./previewHeldMenu";
import {
	previewSearchesCarriedOn,
	previewSearchHistoryWrite,
	type RecordedPreviewSearch,
	readPreviewSearchContexts,
	readPreviewStandingSearches,
	withoutPreviewSearchesEnd,
	withPreviewSearchBegun,
	withPreviewSearchesEnded,
	withPreviewStandingSearches,
} from "./previewSearchHistory";
import {
	type RecordedPreviewSelections,
	readPreviewSelections,
	samePreviewSelections,
	withPreviewSelections,
} from "./previewSelectionsHistory";

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
	window.history.replaceState(replacement.state, "", replacement.url);
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

/** A builder history write from the current entry: the new entry's state
 * (`previewHeldMenu.ts::builderEntryState`), scoped to the active Project,
 * with the searches the write carries on, and whether a push consumes a
 * submission's end on the entry it leaves
 * (`previewSearchHistory.ts::previewSearchHistoryWrite`). */
function writtenState(
	write: (relative: string) => BuilderHistoryWrite,
	relative: string,
): { readonly state: Record<string, unknown>; readonly consumesEnd: boolean } {
	const current = scopedBuilderHistoryState(
		window.history.state,
		activeProjectScope,
	);
	const written = write(new URL(relative, window.location.href).pathname);
	const searches = previewSearchHistoryWrite(
		current,
		builderEntryState(
			{ pathname: window.location.pathname, state: current },
			written,
		),
		"lens" in written ? "lens" : written.replace ? "replace" : "push",
	);
	return { state: searches.written, consumesEnd: searches.consumesEnd };
}

/** The entry a push leaves keeps its searches for Back and Forward, and its
 *  next step after them carries them on again. */
function consumePreviewSearchesEnd(): void {
	window.history.replaceState(
		withoutPreviewSearchesEnd(window.history.state),
		"",
		window.location.href,
	);
}

/** The only write path for intra-builder screen history. An entry carries a
 * Preview case list's held form menu only where the write names one
 * (`previewHeldMenu.ts`); every other entry drops it. */
export function pushBuilderHistory(
	url: string,
	replace = false,
	heldMenu?: PreviewHeldCaseListMenu,
): void {
	writeBuilderHistory(url, replace, heldMenu, "forward");
}

function writeBuilderHistory(
	url: string,
	replace: boolean,
	heldMenu: PreviewHeldCaseListMenu | undefined,
	arrival: "back" | "forward",
): void {
	takeInPendingPop();
	const relative = builderNavigationUrl(url, window.location.href);
	const { state, consumesEnd } = writtenState(
		(pathname) => ({ pathname, replace, held: heldMenu }),
		relative,
	);
	builderHistoryMoves += 1;
	builderHistoryArrival = arrival;
	if (replace) window.history.replaceState(state, "", relative);
	else {
		if (consumesEnd) consumePreviewSearchesEnd();
		window.history.pushState(state, "", relative);
	}
	notifyPathChange();
}

/** A write that keeps the screen on show and changes only its lens (a
 * language): a new entry that keeps the held form menu the current entry
 * carries, one lens deeper (`previewHeldMenu.ts`). */
export function pushBuilderLensHistory(url: string): void {
	takeInPendingPop();
	const relative = builderNavigationUrl(url, window.location.href);
	const { state } = writtenState(
		(pathname) => ({ pathname, lens: true }),
		relative,
	);
	window.history.pushState(state, "", relative);
	notifyPathChange();
}

/** A device's Back off a Preview case list's held form menu
 * (`previewHeldMenu.ts::previewHeldMenuBack`): back past every entry of the
 * menu's one step, its language changes included, to its list's entry before
 * it, which takes the menu's language as it lands, since a device's Back keeps
 * the language the worker reads; or, where no list entry is behind the menu
 * (a menu a crumb opened again from a form, a deep-linked case's details with
 * nothing before them), the menu's entry becomes the list's. */
export function stepBackOffPreviewHeldMenu(): void {
	takeInPendingPop();
	const { pathname, search } = window.location;
	const back = previewHeldMenuBack(window.history.state);
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
		window.history.replaceState(
			window.history.state,
			"",
			`${pathname}${search}${window.location.hash}`,
		);
		notifyPathChange();
	};
	window.addEventListener("popstate", keepLens);
	window.history.go(-back.steps);
}

/** The crumb of the case a Preview case list's form menu holds: where the
 * entry before this one is that menu's own (a form opened from it), a step
 * back onto it, as a device's step back off the form lands there; otherwise
 * the menu on an entry of its own (`previewHeldMenu.ts`). */
export function reopenPreviewHeldMenu(
	url: string,
	held: PreviewHeldCaseListMenu,
): void {
	takeInPendingPop();
	if (previewHeldMenuIsPrevious(window.history.state, held)) {
		/* The entry behind can have changed since the form was pushed (the
		 * menu's own Back showed the list in it, and Forward came back here):
		 * where the step lands on an entry that no longer holds the menu, the
		 * menu opens again on an entry of its own. The step always fires one
		 * popstate, after the path listener's. */
		const checkLanding = () => {
			window.removeEventListener("popstate", checkLanding);
			if (!previewHeldMenuStands(window.history.state, held))
				pushBuilderHistory(url, false, held);
		};
		window.addEventListener("popstate", checkLanding);
		window.history.back();
		return;
	}
	pushBuilderHistory(url, false, held);
}

/** A screen's own Back to the screen it was opened from, at `url`: where
 * the entry this screen was pushed after is that screen
 * (`previewHeldMenu.ts::stepsBackToPrevious`), a step back onto it, so
 * history holds the screen once and the browser's next Back goes on past it,
 * as a device's next step back does; otherwise `url` in place of this entry.
 * `leave` lets go of what the screen held as the move happens: before the
 * replace, or on the step's popstate before any screen renders the entry it
 * lands on. Where that entry is no longer the screen at `url` (it was
 * replaced since), `url` opens after it; where it shows the screen under an
 * earlier language, it takes the language the worker reads now, as a
 * device's Back keeps it. */
export function stepBackToBuilderEntry(url: string, leave: () => void): void {
	takeInPendingPop();
	const relative = builderNavigationUrl(url, window.location.href);
	const target = new URL(relative, window.location.href);
	const steps = stepsBackToPrevious(window.history.state, target.pathname);
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
			window.history.replaceState(
				window.history.state,
				"",
				`${target.pathname}${target.search}${window.location.hash}`,
			);
	};
	popListeners.add(land);
	window.history.go(-steps);
}

function heldMenuSnapshot(): string {
	const held = readPreviewHeldMenu(viewedEntry().state);
	return held === undefined ? "" : JSON.stringify(held);
}

/** The Preview case list's held form menu the current history entry carries
 * (`previewHeldMenu.ts`). It changes with the entry, on a write and on Back
 * and Forward, whose URL stays the list's, so it subscribes to the same
 * notification channel as the path. */
export function usePreviewHeldMenu(): PreviewHeldCaseListMenu | undefined {
	const snapshot = useSyncExternalStore(subscribe, heldMenuSnapshot, () => "");
	return useMemo(
		() =>
			snapshot === "" ? undefined : previewHeldMenuOf(JSON.parse(snapshot)),
		[snapshot],
	);
}

/** Record which of Preview's searches stand on the current history entry
 * (`previewSearchHistory.ts`). It rewrites only that record: the entry's
 * address, held form menu and the entry it was pushed after stay, so this is
 * no screen write and does not go through `builderEntryState`. */
export function recordPreviewStandingSearches(
	submissions: readonly string[],
): void {
	takeInPendingPop();
	const current = readPreviewStandingSearches(window.history.state);
	if (
		current.length === submissions.length &&
		current.every((submission, i) => submission === submissions[i])
	)
		return;
	window.history.replaceState(
		withPreviewStandingSearches(window.history.state, submissions),
		"",
		window.location.href,
	);
	notifyPathChange();
}

/** A search begun on the current entry: it stands there beside those of
 * `standing` (the entry's searches still live), and the entry's next step
 * carries it on, after a submission's end too
 * (`previewSearchHistory.ts::withPreviewSearchBegun`). */
export function beginPreviewStandingSearch(
	standing: readonly string[],
	search: RecordedPreviewSearch,
): void {
	takeInPendingPop();
	const current = window.history.state;
	const next = withPreviewSearchBegun(current, standing, search);
	const record = (state: unknown) =>
		JSON.stringify([
			readPreviewStandingSearches(state),
			previewSearchesCarriedOn(state),
			readPreviewSearchContexts(state),
		]);
	if (record(current) === record(next)) return;
	window.history.replaceState(next, "", window.location.href);
	notifyPathChange();
}

/** A form submitted on the current entry ends the searches it was opened
 * under: the entry keeps them, and its next step carries none of them on
 * (`previewSearchHistory.ts::withPreviewSearchesEnded`). */
export function endPreviewStandingSearches(): void {
	takeInPendingPop();
	window.history.replaceState(
		withPreviewSearchesEnded(window.history.state),
		"",
		window.location.href,
	);
}

/** The searches the current history entry records as standing on it,
 * imperatively, for an event handler. */
export function readCurrentPreviewStandingSearches(): string[] {
	return readPreviewStandingSearches(viewedEntry().state);
}

function standingSearchesSnapshot(): string {
	return readPreviewStandingSearches(viewedEntry().state).join(" ");
}

function searchContextsSnapshot(): string {
	return JSON.stringify(readPreviewSearchContexts(viewedEntry().state));
}

/** The contexts the current history entry records of the searches standing
 * on it (`previewSearchHistory.ts::readPreviewSearchContexts`), on writes and
 * on Back and Forward. */
export function usePreviewSearchContexts(): Readonly<
	Record<string, RecordedPreviewSearch>
> {
	const snapshot = useSyncExternalStore(
		subscribe,
		searchContextsSnapshot,
		() => "{}",
	);
	return useMemo(
		() =>
			JSON.parse(snapshot) as Readonly<Record<string, RecordedPreviewSearch>>,
		[snapshot],
	);
}

/** The contexts the current history entry records, imperatively. */
export function readCurrentPreviewSearchContexts(): Readonly<
	Record<string, RecordedPreviewSearch>
> {
	return readPreviewSearchContexts(viewedEntry().state);
}

/** The searches the current history entry records as standing on it. It
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
 * (`previewSelectionsHistory.ts`). Like a record of standing searches it
 * rewrites only that record, so it is no screen write and no move. `read`
 * reads the session once a pending Back or Forward has been taken in, so the
 * record is of the session the entry shows. */
export function recordPreviewSelections(
	read: () => RecordedPreviewSelections,
): void {
	takeInPendingPop();
	const recorded = read();
	if (
		samePreviewSelections(readPreviewSelections(window.history.state), recorded)
	)
		return;
	window.history.replaceState(
		withPreviewSelections(window.history.state, recorded),
		"",
		window.location.href,
	);
	notifyPathChange();
}

/** The case selections the current history entry records, imperatively. */
export function readCurrentPreviewSelections():
	| RecordedPreviewSelections
	| undefined {
	return readPreviewSelections(viewedEntry().state);
}

function selectionsSnapshot(): string {
	return JSON.stringify(readPreviewSelections(viewedEntry().state) ?? null);
}

/** The current history entry's record of its case selections, as a string
 *  that changes with the entry (a write, Back and Forward) and with the
 *  record, for an effect that runs on each arrival. */
export function usePreviewSelectionsSnapshot(): string {
	return useSyncExternalStore(subscribe, selectionsSnapshot, () => "null");
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
export function useIsBuilderFieldPathSelected(uuid: string): boolean {
	const getSelectedSnapshot = useCallback(() => {
		const segments = extractSegments(getSnapshot());
		return (
			(segments.length === 1 || segments.length === 2) &&
			segments[segments.length - 1] === uuid
		);
	}, [uuid]);
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
