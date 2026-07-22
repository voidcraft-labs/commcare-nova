/**
 * Project-scope reset registry.
 *
 * The session store owns the monotonic `scopeEpoch`; this registry is only the
 * fan-out seam for client caches whose authorization follows the app's current
 * Project. A reset is synchronous and happens before the authoritative reload
 * GET, so stale tenant data cannot remain visible during a handoff.
 */

export type ProjectScopeResetSubscriber = (scopeEpoch: number) => void;

export interface ProjectScopeResetRegistry {
	/** Subscribe a Project-scoped cache/controller. Returns an unsubscribe. */
	subscribe: (subscriber: ProjectScopeResetSubscriber) => () => void;
	/** Fan out a newer session-owned epoch. Duplicate/stale epochs are ignored. */
	reset: (scopeEpoch: number) => void;
	/** Whether an async completion captured in `scopeEpoch` still belongs to the
	 *  active Project generation. Every future async cache must check this before
	 *  publishing its result. */
	isCurrent: (scopeEpoch: number) => boolean;
}

export function createProjectScopeResetRegistry(): ProjectScopeResetRegistry {
	const subscribers = new Set<ProjectScopeResetSubscriber>();
	let latestEpoch = 0;

	return {
		subscribe(subscriber) {
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
		reset(scopeEpoch) {
			if (!Number.isSafeInteger(scopeEpoch) || scopeEpoch <= latestEpoch)
				return;
			latestEpoch = scopeEpoch;
			const failures: unknown[] = [];
			for (const subscriber of [...subscribers]) {
				try {
					subscriber(scopeEpoch);
				} catch (error) {
					/* Keep clearing the other caches, then fail the whole boundary
					 * closed. Partially-cleared tenant state is never safe to reveal. */
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					"One or more Project-scoped caches failed to reset",
				);
			}
		},
		isCurrent: (scopeEpoch) => scopeEpoch === latestEpoch,
	};
}
