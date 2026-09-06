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
import {
	type BuilderHistoryScope,
	builderNavigationUrl,
	reconcileBuilderHistoryEntry,
	scopedBuilderHistoryState,
} from "./historyPolicy";

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

/** The only write path for intra-builder screen history. */
export function pushBuilderHistory(url: string, replace = false): void {
	const relative = builderNavigationUrl(url, window.location.href);
	const state = scopedBuilderHistoryState(
		window.history.state,
		activeProjectScope,
	);
	if (replace) window.history.replaceState(state, "", relative);
	else window.history.pushState(state, "", relative);
	notifyPathChange();
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
