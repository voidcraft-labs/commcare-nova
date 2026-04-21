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
 * Path prefixes each hostname is allowed to serve. Matching is segment-anchored
 * (see `isPathAllowedOnHost`); `/` matches only the root page exactly so it
 * doesn't act as a wildcard for an entire host.
 *
 * Declared with `satisfies` so each host's prefix tuple keeps its literal-string
 * element types — the `Record<Hostname, readonly string[]>` constraint is
 * enforced without widening the value type.
 */
export const HOSTNAME_ALLOWLIST = {
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
} as const satisfies Record<Hostname, readonly string[]>;

/** Normalize the Host header: lowercase, strip trailing dot, strip :80 / :443. */
export function normalizeHost(raw: string | null): string {
	if (!raw) return "";
	let host = raw.toLowerCase().trim();
	if (host.endsWith(".")) host = host.slice(0, -1);
	host = host.replace(/:(80|443)$/, "");
	return host;
}

/**
 * Membership set derived from `HOSTNAMES` so `classifyHost` cannot silently
 * drift when a new hostname is added — the only place to register one is the
 * `HOSTNAMES` map itself.
 */
const KNOWN_HOSTNAMES = new Set<string>(Object.values(HOSTNAMES));

/** Classify a normalized host to a known hostname, or `null` if unknown. */
export function classifyHost(host: string): Hostname | null {
	// The cast is sound: membership is gated by a set built from `HOSTNAMES`,
	// so any string in the set is, by construction, a `Hostname`.
	return KNOWN_HOSTNAMES.has(host) ? (host as Hostname) : null;
}

/**
 * True if `path` is allowed on `host`. Matching is anchored at path-segment
 * boundaries — `/admin` allows `/admin` and `/admin/users` but NOT `/admins`,
 * because the allowlist is a security boundary and substring matches would
 * leak future routes that happen to share a prefix.
 */
export function isPathAllowedOnHost(host: Hostname, path: string): boolean {
	return HOSTNAME_ALLOWLIST[host].some((prefix) =>
		prefix === "/"
			? path === "/"
			: path === prefix || path.startsWith(`${prefix}/`),
	);
}
