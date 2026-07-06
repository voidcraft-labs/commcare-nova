import { isValidIP, normalizeIP } from "@better-auth/core/utils/ip";

/**
 * Extract the caller's IP from a `Headers` object for audit-log
 * payloads. Reads the proxy-stamped `x-nova-client-ip` header that
 * `proxy.ts` populates from `X-Forwarded-For`'s trusted suffix; the
 * proxy strips any client-supplied value first, so anything reaching
 * here under that name is guaranteed proxy-derived (the leftmost
 * spoofable region of XFF cannot reach this code path). `isValidIP`
 * rejects anything that isn't a parseable IPv4/IPv6 address (defends
 * against an upstream regression that lets a malformed value through),
 * and `normalizeIP` collapses equivalent representations so log
 * queries pivot on one canonical form. Returns `"unknown"` when the
 * header is absent (proxy didn't run for this request — tests, dev
 * paths bypassing the middleware) or the value fails validation.
 *
 * The Headers parameter lets the same helper serve route handlers
 * (passing `req.headers`) and Server Components / Server Actions
 * (passing `await headers()`) — the async vs sync seam stays at the
 * call site, where it belongs.
 *
 * Lives in this dependency-free leaf (only the `@better-auth/core` IP
 * utils, ~30ms to load) rather than the `auth-utils` barrel: the MCP
 * API-key route (`app/api/mcp/api-key-auth.ts`) needs only this helper,
 * and pulling it from `auth-utils` dragged that module's full Better
 * Auth server + DB-pool + Sentry graph (~2.8s to transform/eval) into
 * the request path — a real cold-start cost in prod and a per-test
 * timeout risk under load. `auth-utils` re-exports it for existing
 * importers.
 */
export function callerIpFromHeaders(reqHeaders: Headers): string {
	const trusted = reqHeaders.get("x-nova-client-ip");
	if (!trusted || !isValidIP(trusted)) return "unknown";
	return normalizeIP(trusted);
}
