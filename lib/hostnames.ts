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
 * The two origins OAuth + MCP URL construction care about:
 *
 *   - `AS_ORIGIN` — the authorization server. In prod this is the main
 *     host (`https://commcare.app`); it's where the bare AS metadata
 *     wrapper lives so Claude Code can discover the token endpoint.
 *
 *   - `AS_ISSUER` — Better Auth's canonical issuer. The auth handler
 *     lives under `/api/auth`, and Better Auth signs OAuth access tokens
 *     with that pathful base URL as `iss`.
 *
 *   - `MCP_RESOURCE_URL` — the actual MCP endpoint URL. In prod this is
 *     `https://mcp.commcare.app/mcp`; in local dev it is the direct Next
 *     route `http://localhost:3000/api/mcp`. This is what MCP clients
 *     send as the OAuth `resource` value and what appears as `aud` on
 *     MCP-minted tokens.
 *
 * In dev both collapse to `BETTER_AUTH_URL` (typically
 * `http://localhost:3000`) for AS/resource origins, while the MCP
 * resource path stays `/api/mcp` because local smoke tests hit the
 * Next.js route directly rather than the production `/mcp` rewrite.
 *
 * These are derived from env + HOSTNAMES so every code path (the route
 * handler's `verifyOptions`, `oauthProvider`'s `validAudiences`, the
 * protected-resource metadata route) reads a single source of truth
 * instead of constructing URL strings that drift from BETTER_AUTH_URL
 * or the externally reachable MCP path.
 */
const isDev = process.env.NODE_ENV === "development";
const devOrigin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export const AS_ORIGIN = isDev ? devOrigin : `https://${HOSTNAMES.main}`;
export const AS_ISSUER = `${AS_ORIGIN}/api/auth`;
export const MCP_RESOURCE_ORIGIN = isDev
	? devOrigin
	: `https://${HOSTNAMES.mcp}`;

/**
 * Path component of the MCP resource URL, extracted as a constant so
 * `MCP_RESOURCE_METADATA_URL` below can interpolate it directly rather
 * than parsing it back out of `MCP_RESOURCE_URL`. Manual URL surgery
 * (slice, regex strip) in an auth context is exactly the kind of code
 * that drifts wrong under refactor.
 */
const MCP_RESOURCE_PATH = isDev ? "/api/mcp" : "/mcp";

export const MCP_RESOURCE_URL = `${MCP_RESOURCE_ORIGIN}${MCP_RESOURCE_PATH}`;

/**
 * RFC 9728 protected-resource metadata URL — the value the MCP route's
 * `WWW-Authenticate` headers point at, so an OAuth client receiving a
 * 401 can follow it back to the AS metadata. Shape matches the upstream
 * `@better-auth/oauth-provider` so a revoked-consent 401 is
 * byte-identical to a signature-failure 401 and Claude Code's
 * auto-discovery flow doesn't have to branch on which path produced it.
 */
export const MCP_RESOURCE_METADATA_URL = `${MCP_RESOURCE_ORIGIN}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;

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
	[HOSTNAMES.mcp]: [
		"/mcp",
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-protected-resource/mcp",
	],
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
