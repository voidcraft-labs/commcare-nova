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
 * Path prefixes each hostname is allowed to serve. Matching is segment-anchored:
 * an entry `/foo` grants `/foo` exactly and any `/foo/...` subpath, but never
 * `/foobar`. The exception is `/`, which matches only the root page so it
 * doesn't act as a wildcard for an entire host.
 *
 * This is a security boundary — every entry widens the externally reachable
 * surface area on its host. Add with care.
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
 * All hostnames this service knows about, built from `HOSTNAMES` so the set
 * cannot drift from the typed source of truth. Declared as `Set<string>` —
 * `Set.prototype.has` requires its argument to match the element type, so a
 * narrow `Set<Hostname>` would refuse arbitrary string input from the wire.
 * The narrowing happens one level up, inside `isKnownHostname`.
 */
const KNOWN_HOSTNAMES: ReadonlySet<string> = new Set(Object.values(HOSTNAMES));

/** Type predicate: true iff `host` is one of the known hostnames. */
function isKnownHostname(host: string): host is Hostname {
	return KNOWN_HOSTNAMES.has(host);
}

/** Classify a normalized host to a known hostname, or `null` if unknown. */
export function classifyHost(host: string): Hostname | null {
	return isKnownHostname(host) ? host : null;
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
