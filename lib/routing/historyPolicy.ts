/** History metadata and URL policy. The browser adapter performs the returned
 * replacement synchronously before notifying path subscribers. */
export interface BuilderHistoryScope {
	scopeId: string;
	appId: string | null;
	epoch: number;
}

const PROJECT_SCOPE_STATE_KEY = "__novaProjectScope";

function scopeStamp(state: unknown): BuilderHistoryScope | null {
	if (typeof state !== "object" || state === null) return null;
	const stamp = (state as Record<string, unknown>)[PROJECT_SCOPE_STATE_KEY];
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
	const stamp = scopeStamp(entry.state);
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
	return {
		url: `${pathname}${entry.search}`,
		state: scopedBuilderHistoryState(entry.state, active),
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
