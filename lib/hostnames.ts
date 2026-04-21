/**
 * Hostname routing contract.
 *
 * Three hostnames map to the same Cloud Run service; middleware enforces
 * a per-host path allowlist so the MCP subdomain only serves MCP routes
 * and the docs subdomain only serves docs. Everything off-allowlist 404s.
 *
 * Unknown hostnames (e.g. Cloud Run's internal `*-uc.a.run.app` host used
 * by health checks) default to main-app behavior — we don't want to 404
 * platform pings.
 */

export const HOSTNAMES = {
	main: "commcare.app",
	mcp: "mcp.commcare.app",
	docs: "docs.commcare.app",
} as const;

export type Hostname = (typeof HOSTNAMES)[keyof typeof HOSTNAMES];

/**
 * Path prefixes each hostname is allowed to serve. Matching is prefix-based
 * via `startsWith`; `/` exactly matches the root page for hostnames that
 * expose one.
 */
export const HOSTNAME_ALLOWLIST: Record<Hostname, readonly string[]> = {
	[HOSTNAMES.main]: [
		"/",
		"/api/auth",
		"/api/chat",
		"/api/compile",
		"/api/commcare",
		"/api/log",
		"/api/user",
		"/api/admin",
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/admin",
		"/build",
		"/consent",
		"/settings",
		"/sign-in",
		"/_next",
		"/favicon",
	],
	[HOSTNAMES.mcp]: ["/mcp", "/.well-known/oauth-protected-resource"],
	[HOSTNAMES.docs]: ["/", "/_next", "/favicon"],
} as const;

/** Normalize the Host header: strip trailing dot, strip explicit :443 / :80. */
export function normalizeHost(raw: string | null): string {
	if (!raw) return "";
	let host = raw.toLowerCase().trim();
	if (host.endsWith(".")) host = host.slice(0, -1);
	host = host.replace(/:(80|443)$/, "");
	return host;
}

/** Classify a normalized host to a known hostname, or `null` if unknown. */
export function classifyHost(host: string): Hostname | null {
	if (host === HOSTNAMES.main) return HOSTNAMES.main;
	if (host === HOSTNAMES.mcp) return HOSTNAMES.mcp;
	if (host === HOSTNAMES.docs) return HOSTNAMES.docs;
	return null;
}

/** True if `path` is allowed on `host`. */
export function isPathAllowedOnHost(host: Hostname, path: string): boolean {
	const allow = HOSTNAME_ALLOWLIST[host];
	for (const prefix of allow) {
		if (prefix === "/" ? path === "/" : path.startsWith(prefix)) return true;
	}
	return false;
}
