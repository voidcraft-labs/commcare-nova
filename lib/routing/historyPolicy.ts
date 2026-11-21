/** History metadata and URL policy. The browser adapter performs the returned
 * replacement synchronously before notifying path subscribers. */
import {
	type BuilderHistoryScope,
	PROJECT_SCOPE_STATE_KEY,
	readBuilderHistoryScope,
} from "./builderHistoryState";
import { withoutPreviewHistorySteps } from "./previewHeldMenu";

export type { BuilderHistoryScope } from "./builderHistoryState";

export function scopedBuilderHistoryState(
	state: unknown,
	scope: BuilderHistoryScope | null,
): Record<string, unknown> {
	const existing =
		typeof state === "object" && state !== null
			? (state as Record<string, unknown>)
			: {};
	return {
		...existing,
		...(scope ? { [PROJECT_SCOPE_STATE_KEY]: scope } : {}),
	};
}

export interface BuilderHistoryEntry {
	pathname: string;
	search: string;
	state: unknown;
}

/** A fresh runtime owns its direct link. Only an older generation of the same
 * runtime and app must lose Project case identity. An old app's pop listener
 * cannot claim another app's entry while React is still changing routes. */
export function reconcileBuilderHistoryEntry(
	entry: BuilderHistoryEntry,
	active: BuilderHistoryScope | null,
	event: "activate" | "pop",
): { url: string; state: Record<string, unknown> } | undefined {
	if (!active) return undefined;
	const stamp = readBuilderHistoryScope(entry.state);
	const stale =
		stamp?.scopeId === active.scopeId &&
		stamp.appId === active.appId &&
		stamp.epoch !== active.epoch;
	if (event === "pop" && !stale) return undefined;
	const parts = entry.pathname.split("/").filter(Boolean);
	const isCaseRecord =
		parts[0] === "build" && parts[3] === "cases" && parts.length >= 5;
	const pathname =
		stale && isCaseRecord
			? `/${[parts[0], parts[1], parts[2], "results"].join("/")}`
			: entry.pathname;
	const state = scopedBuilderHistoryState(entry.state, active);
	return {
		url: `${pathname}${entry.search}`,
		/* An older generation's entry loses its id, so nothing the session
		 * holds for it is read under the new one, and the entry it was pushed
		 * after, which names another generation's step. */
		state: stale ? withoutPreviewHistorySteps(state) : state,
	};
}

/** An explicit query owns its complete state. Path-only navigation carries
 * Builder language lenses and drops route-owned recovery parameters. */
export function builderNavigationUrl(url: string, currentHref: string): string {
	const next = new URL(url, currentHref);
	if (!url.includes("?")) {
		const current = new URL(currentHref).searchParams;
		const persistent = new URLSearchParams();
		for (const value of current.getAll("lang"))
			persistent.append("lang", value);
		next.search = persistent.toString();
	}
	return `${next.pathname}${next.search}${next.hash}`;
}
