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

import { useMemo, useSyncExternalStore } from "react";

/** Module-level listener set for notifying subscribers of programmatic
 *  `pushState`/`replaceState` calls (which don't fire `popstate`). */
const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	window.addEventListener("popstate", callback);
	return () => {
		listeners.delete(callback);
		window.removeEventListener("popstate", callback);
	};
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
	 * through useLocation → useSelect → useIsQuestionSelected and defeats
	 * the per-wrapper re-render isolation. */
	return useMemo(() => extractSegments(pathname), [pathname]);
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
	const parts = pathname.split("/").filter(Boolean);
	/* parts = ["build", appId, ...segments] */
	const segments = parts.slice(2);
	return segments.length === 0 ? EMPTY_SEGMENTS : segments;
}
