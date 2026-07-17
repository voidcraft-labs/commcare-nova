// lib/preview/hooks/useReloadableResource.ts
//
// A reloadable server-data resource: a fetch derived from `deps`, with
// stale-while-revalidate and an awaitable manual `reload`. One async load
// drives BOTH the dep-change effect and `reload`, and a monotonic request
// token gives last-write-wins — so a reload racing the dep effect (or an
// unmount) can never commit a stale settle, and because `reload` IS that
// promise, callers can await it to learn when the fresh data is on screen,
// not merely when the fetch returned.
//
// The case-data hooks (`useCases`, `useCaseCount`, and `useCaseData`) share
// this one primitive rather than each hand-rolling the same concurrency
// machinery — duplicated last-write-wins logic is the kind that silently
// diverges when only one copy gets a fix.

"use client";

import {
	type DependencyList,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

/** A sync readiness decision: either a not-ready state to show without
 *  fetching, or the fetch thunk to run. Returning the thunk from a guarded
 *  branch lets the caller narrow ids INSIDE `prepare`, so the fetch stays
 *  type-safe without assertions. */
export type Prepared<T> = { notReady: T } | { fetch: () => Promise<T> };

export function useReloadableResource<T extends { kind: string }>(opts: {
	/** Sync per-run readiness check — `{ notReady }` short-circuits the fetch
	 *  (e.g. `idle` when ids are missing, `paused` when config is invalid);
	 *  `{ fetch }` runs the load. */
	readonly prepare: () => Prepared<T>;
	/** Shown on the first load, before any settled data exists. */
	readonly loading: T;
	/** Maps a thrown wire error (HTTP 500, network, RSC serialization at the
	 *  boundary) to a committed state — otherwise the resource sticks on
	 *  `loading` forever. */
	readonly toError: (err: unknown) => T;
	/** Keep this prior state on screen during a revalidation
	 *  (stale-while-revalidate); anything else falls back to `loading`. */
	readonly keepStale: (prev: T) => boolean;
	/** Re-fire the load when any of these change. */
	readonly deps: DependencyList;
}): { state: T; fetching: boolean; reload: () => Promise<void> } {
	const [state, setState] = useState<T>(() => {
		const prep = opts.prepare();
		return "notReady" in prep ? prep.notReady : opts.loading;
	});
	const [fetching, setFetching] = useState(false);
	const requestId = useRef(0);
	/* Latest options read through a ref so the stable `load` always runs the
	 * current closures without making every render re-fire the effect. */
	const latest = useRef(opts);
	latest.current = opts;

	const load = useCallback(async (): Promise<void> => {
		const o = latest.current;
		const prep = o.prepare();
		if ("notReady" in prep) {
			setState(prep.notReady);
			setFetching(false);
			return;
		}
		requestId.current += 1;
		const id = requestId.current;
		setState((prev) => (o.keepStale(prev) ? prev : o.loading));
		setFetching(true);
		let next: T;
		try {
			next = await prep.fetch();
		} catch (err: unknown) {
			next = o.toError(err);
		}
		if (id !== requestId.current) return; // a newer load / unmount superseded us
		setState(next);
		setFetching(false);
	}, []);

	// `deps` is the caller's trigger list, forwarded like useEffect's own dep
	// array; `load` is stable and reads current inputs via the latest ref.
	useEffect(() => {
		void load();
		// Invalidate any in-flight load on unmount / dep change so its settle is
		// dropped rather than committed to a gone or superseded view.
		return () => {
			requestId.current += 1;
		};
	}, [load, ...opts.deps]);

	return { state, fetching, reload: load };
}
