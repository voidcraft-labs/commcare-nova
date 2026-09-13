/**
 * The provider prompt-cache keys Nova's roles send. Each is the role's cache
 * affinity: the same key across turns (or steps) is what lets the provider
 * reuse the static prefix. Named here so the call sites and the dev-only
 * agent anatomy spell them identically.
 */
export const promptCacheKeys = {
	/** The Solutions Architect: one key per app, stable across turns. */
	app: (appId: string) => `nova:app:${appId}`,
	/** The design author: one key per design session. */
	design: (designSessionId: string) => `nova:design:${designSessionId}`,
	/** The build executor: one key per design session, shared by its slices. */
	executor: (designSessionId: string) =>
		`nova:design-executor:${designSessionId}`,
} as const;
