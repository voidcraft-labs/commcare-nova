/**
 * Streamable HTTP MCP endpoint for Nova.
 *
 * ## External URL vs internal path
 *
 * External callers (Claude Code and other MCP clients) talk to
 * `https://mcp.commcare.app/mcp`. Internally, Next.js File-system
 * routing puts this handler at `app/api/mcp/route.ts`, so its canonical
 * pathname is `/api/mcp`. The `/mcp` → `/api/mcp` rewrite lives in
 * `proxy.ts` on the MCP host (see the host allowlist in
 * `lib/hostnames.ts`): the external URL stays clean, the internal
 * layout follows Next.js convention.
 *
 * `mcp-handler`'s default `basePath: "/api"` composes with the `/mcp`
 * segment to produce the exact pathname it expects to match against
 * internally. Keeping `basePath: "/api"` explicit here is belt-and-
 * suspenders in case a library version changes the default.
 *
 * ## Request flow
 *
 *   1. `mcpHandler` verifies the bearer against the local JWKS at
 *      `https://commcare.app/api/auth/jwks`, validates `iss` + `aud`
 *      against the values declared below, and enforces that the token
 *      carries ALL scopes listed in the outer `scopes` array (the
 *      helper's semantics are "must include all, extras allowed" —
 *      confirmed in `@better-auth/core/dist/oauth2/verify.d.mts`).
 *      Missing/invalid token → 401 with a `WWW-Authenticate` header
 *      pointing at the authorization server so Claude Code can
 *      auto-discover and start the OAuth flow. Missing required scope
 *      → 403.
 *   2. On success, `mcpHandler` hands the verified `JWTPayload` to the
 *      inner handler. We narrow it to our `JwtClaims` shape (see
 *      `lib/mcp/types.ts`), confirm the user still has an active
 *      `oauthConsent` for the calling client (the instant-revocation
 *      lock — see "Why the consent check" below), and instantiate a
 *      per-request `createMcpHandler` that registers every Nova tool
 *      on a fresh `McpServer`.
 *   3. The MCP JSON-RPC layer inside `createMcpHandler` dispatches the
 *      tool call through the registered callback.
 *
 * ## Why scope enforcement at the verify layer
 *
 * The plugin's `verifyAccessToken` config takes a `scopes` array that
 * it checks as part of token verification. Declaring required scopes
 * here means every tool registered downstream inherits the check for
 * free — there is no per-handler `requireScope(...)` call to forget,
 * and a newly added tool can't accidentally ship without scope
 * enforcement. If in the future we need a read-only token class that
 * can hit the read tools but not the write tools, the right shape is
 * two separate mount points with different scope sets (one requiring
 * `nova.read`, one requiring both), not a per-tool branch inside a
 * single mount.
 *
 * ## Why the JWT narrowing runs here
 *
 * `JWTPayload` from `jose` is intentionally loose — `sub` is
 * `string | undefined`, `aud` is `string | string[] | undefined`, and
 * every other claim is typed `unknown`. The Nova tools downstream want
 * a concrete `JwtClaims` with `sub: string` guaranteed. The verify
 * layer has already checked the token signature + aud + iss, so a
 * missing `sub` at this point means the token is structurally broken;
 * we throw rather than silently coerce.
 *
 * ## Why the consent check runs every request
 *
 * JWT access tokens are self-contained — the MCP route never calls
 * back to the AS to re-validate, so on its own, signature verification
 * has no way to honor a revoke that happened after the token was
 * minted. The per-request `oauthConsent` lookup IS the revocation
 * lock: deleting the consent from `/settings` makes the next MCP
 * request fail immediately, regardless of token expiry.
 */

import { mcpHandler } from "@better-auth/oauth-provider";
import type { JWTPayload } from "jose";
import { createMcpHandler } from "mcp-handler";
import { hasActiveConsent } from "@/lib/db/oauth-consents";
import {
	AS_ISSUER,
	AS_ORIGIN,
	MCP_RESOURCE_METADATA_URL,
	MCP_RESOURCE_URL,
} from "@/lib/hostnames";
import { log } from "@/lib/logger";
import { parseScopes, SCOPES } from "@/lib/mcp/scopes";
import { registerNovaPrompts, registerNovaTools } from "@/lib/mcp/server";
import type { JwtClaims } from "@/lib/mcp/types";

/**
 * Max wall-clock duration for a single MCP request, in seconds.
 *
 * Exported at module scope for Next.js App Router segment config (the
 * platform's request-timeout knob) AND passed into `createMcpHandler`'s
 * `maxDuration` (the MCP runtime's own streaming cutoff). They serve
 * different layers — platform vs protocol — so both are needed.
 *
 * 300s (5 min) accommodates the longest realistic single tool call
 * (app generation with dozens of shared-tool invocations bundled under
 * one `run_id`) without leaving abandoned requests to accumulate.
 */
export const maxDuration = 300;

/**
 * Closed set of reasons that flow into the `error_description` param
 * of `WWW-Authenticate`. RFC 6750 quotes the value but performs no
 * escaping, so widening to `string` would let a future caller
 * inject sibling params (`error="..." x="injected"`) by passing a
 * value containing `"`. Add new reasons here, never widen.
 */
type UnauthorizedReason =
	| "missing client identity"
	| "missing subject claim"
	| "consent revoked"
	| "auth check failed";

/**
 * Build a 401 with the upstream plugin's `WWW-Authenticate` shape plus
 * RFC 6750 §3 `error` / `error_description` for client-side diagnostics.
 */
function mcpUnauthorizedResponse(reason: UnauthorizedReason): Response {
	return new Response(null, {
		status: 401,
		headers: {
			"WWW-Authenticate": `Bearer resource_metadata="${MCP_RESOURCE_METADATA_URL}", error="invalid_token", error_description="${reason}"`,
		},
	});
}

/**
 * Build the verified-and-routed MCP handler. `mcpHandler` adds the
 * token-verification outer layer; `createMcpHandler` is instantiated
 * fresh inside the callback per request so each session gets its own
 * `McpServer` bound to the caller's identity.
 */
const handler = mcpHandler(
	{
		/* JWKS lives on the AS origin — the `jwt` plugin exposes
		 * `/api/auth/jwks` there and that's the signing keypair
		 * `oauth-provider` uses to mint access tokens. `AS_ORIGIN`
		 * resolves to `https://commcare.app` in prod and `BETTER_AUTH_URL`
		 * in dev (typically `http://localhost:3000`). */
		jwksUrl: `${AS_ORIGIN}/api/auth/jwks`,
		verifyOptions: {
			/* `issuer` is what the AS stamps as `iss` on every token it
			 * mints. Better Auth's issuer includes its `/api/auth` base path
			 * (see the AS metadata document's `issuer`). `audience` is what
			 * the AS stamps as `aud` (pinned via
			 * `validAudiences: [MCP_RESOURCE_URL]` in `lib/auth.ts`). */
			issuer: AS_ISSUER,
			audience: MCP_RESOURCE_URL,
		},
		/* Outer-level scopes — a sibling of `verifyOptions`, NOT nested
		 * inside it. The verify helper's semantics are "token must carry
		 * ALL listed scopes, extras allowed" (source of truth:
		 * `@better-auth/core/dist/oauth2/verify.d.mts`). Both Nova scopes
		 * are required on every request because read + write tools share
		 * this single mount; split into separate mounts with distinct
		 * scope sets if a read-only token class is ever introduced. */
		scopes: [SCOPES.read, SCOPES.write],
	},
	async (req: Request, jwt: JWTPayload): Promise<Response> => {
		/* `azp` carries the OAuth client_id (OIDC's "authorized party"
		 * claim) on every token `@better-auth/oauth-provider` mints. A
		 * structurally broken token (missing `sub` or `azp`) MUST return
		 * 401, not throw — `mcpHandler`'s outer catch only re-shapes
		 * `APIError` throws into 401s; a plain throw surfaces as 500
		 * and hangs Claude Code instead of triggering re-auth. */
		if (!jwt.sub) {
			log.error("[mcp] access token missing required `sub` claim");
			return mcpUnauthorizedResponse("missing subject claim");
		}
		const clientId = typeof jwt.azp === "string" ? jwt.azp : undefined;
		if (!clientId) {
			log.error("[mcp] access token missing required `azp` claim", {
				sub: jwt.sub,
			});
			return mcpUnauthorizedResponse("missing client identity");
		}

		/* The revocation lock — see the module docblock for why this
		 * exists. Firestore failure also returns 401: same reasoning as
		 * the missing-claim paths above. */
		let consentActive: boolean;
		try {
			consentActive = await hasActiveConsent(jwt.sub, clientId);
		} catch (err) {
			log.error("[mcp] consent lookup failed", err);
			return mcpUnauthorizedResponse("auth check failed");
		}
		if (!consentActive) {
			return mcpUnauthorizedResponse("consent revoked");
		}

		const claims: JwtClaims = {
			sub: jwt.sub,
			/* `scope` is space-delimited per RFC 6749. We pass the raw
			 * string through; `parseScopes` splits it into the array the
			 * tool context expects. Non-string values are dropped rather
			 * than coerced — a malformed claim is cleaner as "no scopes
			 * reported" than as a `toString()`d object. */
			scope: typeof jwt.scope === "string" ? jwt.scope : undefined,
		};

		/* Fresh `McpServer` per request. Binding tools on every call is
		 * cheap (register* helpers just call `server.registerTool`) and
		 * the alternative — a long-lived server — would leak the first
		 * caller's identity into every subsequent request. */
		return createMcpHandler(
			(server) => {
				registerNovaTools(server, {
					userId: claims.sub,
					scopes: parseScopes(claims.scope),
				});
				registerNovaPrompts(server);
			},
			{ serverInfo: { name: "nova", version: "1.0.0" } },
			/* `basePath: "/api"` composes with this route's `/mcp` segment
			 * to produce `/api/mcp`, which is the internal pathname the
			 * library matches against. `maxDuration` caps streaming
			 * response time at the protocol layer (distinct from the
			 * Next.js platform-timeout `maxDuration` exported above). */
			{ basePath: "/api", maxDuration },
		)(req);
	},
);

/**
 * MCP's streamable HTTP transport uses three HTTP verbs:
 *   - `POST` — JSON-RPC calls (tool invocations, initialization).
 *   - `GET`  — SSE stream for server-to-client notifications.
 *   - `DELETE` — explicit session termination.
 *
 * All three share the same verified handler so scope enforcement
 * uniformly covers every method, including session teardown.
 */
export { handler as DELETE, handler as GET, handler as POST };
