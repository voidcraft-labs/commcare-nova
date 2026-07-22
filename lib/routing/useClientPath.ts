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

const PROJECT_SCOPE_STATE_KEY = "__novaProjectScope";
interface BuilderHistoryScope {
	/** Identifies one mounted reconciler runtime, not merely an app id. */
	scopeId: string;
	/** The app that owns case ids in this entry; null while `/build/new` is
	 * waiting for atomic creation to mint an id. */
	appId: string | null;
	epoch: number;
}
let activeProjectScope: BuilderHistoryScope | null = null;

function scopedHistoryState(): Record<string, unknown> {
	const existing =
		typeof window.history.state === "object" && window.history.state !== null
			? (window.history.state as Record<string, unknown>)
			: {};
	return {
		...existing,
		...(activeProjectScope
			? { [PROJECT_SCOPE_STATE_KEY]: activeProjectScope }
			: {}),
	};
}

function historyProjectScopeStamp(): BuilderHistoryScope | null {
	const stamp = (window.history.state as Record<string, unknown> | null)?.[
		PROJECT_SCOPE_STATE_KEY
	];
	if (
		typeof stamp !== "object" ||
		stamp === null ||
		typeof (stamp as { scopeId?: unknown }).scopeId !== "string" ||
		!(
			(stamp as { appId?: unknown }).appId === null ||
			typeof (stamp as { appId?: unknown }).appId === "string"
		) ||
		typeof (stamp as { epoch?: unknown }).epoch !== "number"
	)
		return null;
	return stamp as BuilderHistoryScope;
}

/** A case id is Project data, unlike module/form UUIDs from the blueprint. If
 * back/forward enters an older generation, replace the deep link with Results
 * before subscribers can parse it and start a destination-scope row fetch. */
function scrubCurrentCaseEntry(): boolean {
	if (!activeProjectScope) return false;
	const currentPath = window.location.pathname;
	const parts = window.location.pathname.split("/").filter(Boolean);
	const isCaseRecord =
		parts[0] === "build" && parts[3] === "cases" && parts.length >= 5;
	const nextPath = isCaseRecord
		? `/${[parts[0], parts[1], parts[2], "results"].join("/")}`
		: currentPath;
	window.history.replaceState(scopedHistoryState(), "", nextPath);
	return nextPath !== currentPath;
}

function onPopState(): void {
	const stamp = historyProjectScopeStamp();
	/* The old app's listener is still mounted when Back first enters another
	 * app. It has no authority to rewrite that app's valid case link. Only an
	 * older generation of this exact reconciler runtime + app is stale; a new
	 * runtime will authorize and restamp its own entry when it mounts. */
	if (
		activeProjectScope &&
		stamp?.scopeId === activeProjectScope.scopeId &&
		stamp.appId === activeProjectScope.appId &&
		stamp.epoch !== activeProjectScope.epoch
	) {
		scrubCurrentCaseEntry();
	}
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
	const stamp = historyProjectScopeStamp();
	if (
		stamp?.scopeId === scopeId &&
		stamp.appId === activeProjectScope.appId &&
		stamp.epoch !== epoch
	) {
		if (scrubCurrentCaseEntry()) notifyPathChange();
		return;
	}
	/* Direct loads, app changes, and newly mounted runtimes are authoritative
	 * entries, not evidence of a stale Project generation. Preserve the path
	 * (including a legitimate case deep link) and claim it for this runtime. */
	window.history.replaceState(
		scopedHistoryState(),
		"",
		window.location.pathname,
	);
}

export function deactivateBuilderHistoryScope(scopeId: string): void {
	if (activeProjectScope?.scopeId === scopeId) activeProjectScope = null;
}

/** The only write path for intra-builder screen history. */
export function pushBuilderHistory(url: string, replace = false): void {
	if (replace) window.history.replaceState(scopedHistoryState(), "", url);
	else window.history.pushState(scopedHistoryState(), "", url);
	notifyPathChange();
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
