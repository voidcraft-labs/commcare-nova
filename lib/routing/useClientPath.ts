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
	readPreviewHeldMenu,
} from "./previewHeldMenu";

/** Module-level listener set for notifying subscribers of programmatic
 *  `pushState`/`replaceState` calls (which don't fire `popstate`). */
const listeners = new Set<() => void>();

let cachedSegmentsPathname: string | undefined;
let cachedSegments: string[] = [];

let activeProjectScope: BuilderHistoryScope | null = null;

function reconcileHistory(event: "activate" | "pop"): boolean {
	const { pathname, search } = window.location;
	const replacement = reconcileBuilderHistoryEntry(
		{ pathname, search, state: window.history.state },
		activeProjectScope,
		event,
	);
	if (!replacement) return false;
	window.history.replaceState(replacement.state, "", replacement.url);
	return replacement.url !== `${pathname}${search}`;
}

function onPopState(): void {
	reconcileHistory("pop");
	notifyPathChange();
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
	return window.location.pathname;
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

/** The state of a builder history write from the current entry
 * (`previewHeldMenu.ts::builderEntryState`), scoped to the active Project. */
function writtenState(
	write: (relative: string) => BuilderHistoryWrite,
	relative: string,
): Record<string, unknown> {
	return builderEntryState(
		{
			pathname: window.location.pathname,
			state: scopedBuilderHistoryState(
				window.history.state,
				activeProjectScope,
			),
		},
		write(new URL(relative, window.location.href).pathname),
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
	const relative = builderNavigationUrl(url, window.location.href);
	const state = writtenState(
		(pathname) => ({ pathname, replace, held: heldMenu }),
		relative,
	);
	if (replace) window.history.replaceState(state, "", relative);
	else window.history.pushState(state, "", relative);
	notifyPathChange();
}

/** A write that keeps the screen on show and changes only its lens (a
 * language): a new entry that keeps the held form menu the current entry
 * carries, one lens deeper (`previewHeldMenu.ts`). */
export function pushBuilderLensHistory(url: string): void {
	const relative = builderNavigationUrl(url, window.location.href);
	const state = writtenState(
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
	const { pathname, search } = window.location;
	const back = previewHeldMenuBack(window.history.state);
	if (back.kind === "show-list") {
		pushBuilderHistory(`${pathname}${search}`, true);
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
	if (previewHeldMenuIsPrevious(window.history.state, held)) {
		window.history.back();
		return;
	}
	pushBuilderHistory(url, false, held);
}

function heldMenuSnapshot(): string {
	const held = readPreviewHeldMenu(window.history.state);
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

/** URL-owned builder query state. Uses the same history notification channel
 * as pathname navigation so push/replace and back/forward stay coherent. */
export function useBuilderSearch(): string {
	return useSyncExternalStore(
		subscribe,
		() => window.location.search,
		() => "",
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
