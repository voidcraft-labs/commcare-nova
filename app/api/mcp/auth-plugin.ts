/**
 * Better Auth plugin that mounts Nova's MCP endpoint inside the
 * auth router.
 *
 * Mounting MCP as a Better Auth plugin endpoint is what brings the
 * route under `auth.handler`'s middleware chain — most importantly,
 * `onRequestRateLimit` (`node_modules/better-auth/dist/api/index.mjs`,
 * called for every routed request). Without this plugin the MCP
 * route would sit at a Next.js route handler that calls
 * `auth.api.verifyApiKey` directly, bypassing the rate limiter; an
 * unauthenticated attacker could spam `Bearer sk-nova-v1-*` garbage
 * and force a Postgres `auth_apikey` lookup per request. The rate limiter's
 * `customRules` rule for `/mcp` (configured in `lib/auth.ts`) bounds
 * that cost.
 *
 * Wire path: external `mcp.commcare.app/mcp` → proxy.ts rewrites to
 * `/api/mcp` (in-process) → `app/api/mcp/route.ts` synthesizes a new
 * Request with URL `/api/auth/mcp` and forwards to `auth.handler`.
 * Better Auth's basePath strip (`/api/auth`) yields `/mcp`, which
 * matches the endpoint registered here.
 *
 * `disableBody: true` is load-bearing — better-call's router would
 * otherwise consume `request.body` via `getBody()` at context
 * construction time, leaving `mcp-handler` with nothing to read for
 * the JSON-RPC payload. Disabling the pre-read keeps the body
 * stream available to whichever path (JWT or API-key) we dispatch
 * to, which then hands it to `mcp-handler`'s streamable-HTTP
 * transport.
 */

import { createAuthEndpoint } from "@better-auth/core/api";
import type { BetterAuthPlugin } from "better-auth";
import { NOVA_API_KEY_PREFIX } from "@/lib/auth-public";
import { HOSTNAMES, normalizeHost } from "@/lib/hostnames";
import { log } from "@/lib/logger";
import { handleApiKeyMcp } from "./api-key-auth";
import { handleJwtMcp } from "./jwt-auth";

/**
 * RFC 6750 §2.1 ("auth-scheme is case-insensitive") — accept
 * `Bearer` / `bearer` / `BEARER` / mixed case for the scheme. The
 * prefix peek that follows still matches case-sensitively against
 * `NOVA_API_KEY_PREFIX`, which is the actual identification token.
 */
const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Hosts the MCP plugin endpoint will serve. The route's sanctioned
 * external surface is `mcp.commcare.app/mcp`; any other host hitting
 * `/api/auth/mcp` (notably the main host, which admits the
 * `/api/auth` prefix for sign-in / session / OAuth-provider
 * endpoints) is denied at the proxy edge — see `proxy.ts`'s main-
 * host branch. This in-endpoint check is defense-in-depth for the
 * paths a request can take that bypass the proxy: direct Cloud Run
 * service URLs, container-local requests, or any future routing
 * change that broadens the Host classification. Localhost variants
 * cover the dev wire-path (`localhost:3000/api/mcp` → route shim →
 * `auth.handler` with the original Host preserved).
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
	HOSTNAMES.mcp,
	"localhost",
	"127.0.0.1",
]);

/**
 * Read the wire hostname (no port) from the Request. Prefer the
 * `Host` header — Cloud Load Balancer forwards it intact; most
 * clients set it. Fall back to the URL's host when the header is
 * missing (hand-crafted Request shapes don't always include one).
 *
 * `normalizeHost` lowercases, strips trailing dots, and removes the
 * default `:80` / `:443` ports; the trailing `.split(":")[0]` then
 * drops any non-default ports too (notably `localhost:3000` in
 * dev), so the allowed-set check compares hostname against
 * hostname.
 */
function readWireHost(req: Request): string {
	const headerHost = req.headers.get("host");
	let normalized = "";
	if (headerHost) {
		normalized = normalizeHost(headerHost);
	} else {
		try {
			normalized = normalizeHost(new URL(req.url).host);
		} catch {
			/* fall through to empty host — caller treats as rejected */
		}
	}
	return normalized.split(":")[0] ?? "";
}

/**
 * Plugin id used by Better Auth's plugin registry. Exported as a
 * constant so tests can reference it without string-duplication.
 */
export const NOVA_MCP_PLUGIN_ID = "nova-mcp";

/**
 * Prefix-peek + dispatch. Pure function — takes a Request, returns a
 * Response. Exported so unit tests can drive the auth fork without
 * spinning up the full Better Auth router. The plugin endpoint below
 * is a thin adapter that calls this with the endpoint context's
 * request.
 *
 * Catches around inner-path throws because both the JWT and API-key
 * handlers have their own try/catch around known failure modes, but
 * a novel throw deeper in the stack (network failure during JWKS
 * fetch, plugin bug, unhandled rejection from `mcp-handler`
 * internals) would otherwise propagate. Claude Code reads 500s as
 * "server down, do not retry" but reads 503s as "transient, retry
 * later," which is the right shape for an unexpected failure on an
 * auth route.
 */
export async function dispatchMcpAuthRequest(req: Request): Promise<Response> {
	const wireHost = readWireHost(req);
	if (!ALLOWED_HOSTS.has(wireHost)) {
		/* Defense-in-depth host check — see `ALLOWED_HOSTS` docblock.
		 * Reject without a `WWW-Authenticate` header: this isn't an
		 * auth failure, it's the wrong wire endpoint. 404 mirrors the
		 * proxy-edge denial shape so the wire response matches across
		 * both layers. */
		log.warn("[mcp] rejected request on non-MCP host", { wireHost });
		return new Response(null, { status: 404 });
	}
	try {
		const auth = req.headers.get("authorization") ?? "";
		const match = auth.match(BEARER_PATTERN);
		const bearer = match?.[1] ?? "";
		if (bearer.startsWith(NOVA_API_KEY_PREFIX)) {
			return await handleApiKeyMcp(req, bearer);
		}
		return await handleJwtMcp(req);
	} catch (err) {
		log.error("[mcp] unhandled dispatcher error", err);
		return new Response(null, { status: 503 });
	}
}

/**
 * Define Nova's MCP plugin. Single endpoint mounted at `/mcp`
 * relative to the `/api/auth` basePath — i.e., wire path
 * `/api/auth/mcp` after the route shim's URL synthesis.
 *
 * The endpoint accepts POST/GET/DELETE because `mcp-handler`'s
 * streamable-HTTP transport routes JSON-RPC over POST and rejects
 * the other verbs with 405. Wiring all three through the same
 * dispatcher keeps the rate limiter + auth check uniform; the 405
 * for an unknown verb arrives only after verification passes.
 */
export const novaMcpPlugin = (): BetterAuthPlugin => ({
	id: NOVA_MCP_PLUGIN_ID,
	endpoints: {
		novaMcp: createAuthEndpoint(
			"/mcp",
			{
				method: ["POST", "GET", "DELETE"],
				/* Skip better-call's `getBody()` body pre-read so
				 * `mcp-handler` can consume `request.body` itself. See
				 * the module docblock. */
				disableBody: true,
			},
			async (ctx): Promise<Response> => {
				/* `ctx.request` is always present for HTTP-mounted
				 * endpoints — the `request` field is only undefined for
				 * direct typed-API invocations (`auth.api.novaMcp({...})`),
				 * which we never use for this endpoint. The defense-in-
				 * depth check matches the existing pattern at the entry
				 * of every Better Auth endpoint handler. */
				const req = ctx.request;
				if (!req) {
					log.error("[mcp] plugin endpoint invoked without request");
					return new Response(null, { status: 503 });
				}
				return dispatchMcpAuthRequest(req);
			},
		),
	},
});
