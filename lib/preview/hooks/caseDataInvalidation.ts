// lib/preview/hooks/caseDataInvalidation.ts
//
// One client-side revision signal for case data. Case rows are shared by
// every builder representation of a module: the running-app list, the
// authoring Results / Details canvases, case-loading forms, and the
// builder-owned case-data manager. A write must therefore invalidate the
// data source, not manually reload whichever surface happened to launch it.

"use client";

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const revisions = new Map<string, number>();
const replacementRevisions = new Map<string, number>();

export type CaseDataInvalidationKind = "update" | "replacement";

function revisionKey(appId: string | undefined, caseType: string | undefined) {
	return appId && caseType ? `${appId}\u0000${caseType}` : "";
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Announce that rows for one `(appId, caseType)` changed. Subscribers for
 * other case types receive the store notification but keep the same snapshot,
 * so React does not re-render or re-fetch them.
 */
export function invalidateCaseData(
	appId: string,
	caseType: string,
	kind: CaseDataInvalidationKind = "update",
): void {
	const key = revisionKey(appId, caseType);
	revisions.set(key, (revisions.get(key) ?? 0) + 1);
	if (kind === "replacement") {
		replacementRevisions.set(key, (replacementRevisions.get(key) ?? 0) + 1);
	}
	for (const listener of listeners) listener();
}

/** A dependency value that changes after an in-app case-data write. */
export function useCaseDataRevision(
	appId: string | undefined,
	caseType: string | undefined,
): number {
	const key = revisionKey(appId, caseType);
	const getSnapshot = () => (key === "" ? 0 : (revisions.get(key) ?? 0));
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * A narrower revision for destructive replacement. Unlike an ordinary update,
 * replacing a population invalidates every case identity the running app may
 * be carrying in a detail screen or case-loading form. Those navigation
 * surfaces subscribe to this signal so they can leave the stale record before
 * another action is allowed to use it.
 */
export function useCaseDataReplacementRevision(
	appId: string | undefined,
	caseType: string | undefined,
): number {
	const key = revisionKey(appId, caseType);
	const getSnapshot = () =>
		key === "" ? 0 : (replacementRevisions.get(key) ?? 0);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
