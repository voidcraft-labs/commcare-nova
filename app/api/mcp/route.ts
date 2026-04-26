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
 * `mcp-handler` matches `new URL(req.url).pathname` against
 * `${basePath}/mcp` to dispatch the streamable-HTTP transport. Next.js
 * middleware rewrites the routing target without touching `Request.url`,
 * so the wire pathname must drive `basePath` per environment — see the
 * comment at the `createMcpHandler` call site below.
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
 * ## Two-layer scope enforcement
 *
 * Scope checks split between this verify layer and the individual tool
 * handlers, picked by whether the scope is *comparable* (read vs
 * write — one is a subset of the other in capability) or *orthogonal*
 * to read/write (HQ access — a separate authorization to a third-party
 * system that cuts across both axes).
 *
 *   - **Comparable, verify-layer.** `nova.read` and `nova.write` are
 *     declared in `verifyAccessToken({ scopes })` below. Every tool
 *     registered downstream inherits the check for free — there is no
 *     per-handler `assertScope(...)` call to forget, and a newly added
 *     Nova-internal tool can't ship without enforcement.
 *   - **Orthogonal, per-tool.** `nova.hq.read` and `nova.hq.write` gate
 *     access to CommCare HQ. They're not comparable to read/write
 *     (you can have HQ access without Nova write, or vice versa), so
 *     mount-splitting can't capture them — it would require a 4-way
 *     mount cross-product. Instead, HQ tools call `assertScope` (in
 *     `lib/mcp/scopes.ts`) at the top of their handler. Adding HQ
 *     scopes to *this* layer's `scopes` array would mandate them for
 *     every MCP request, defeating the orthogonal split.
 *
 * ## Why the JWT narrowing runs here
 *
 * `JWTPayload` from `jose` is intentionally loose — `sub` is
 * `string | undefined`, `aud` is `string | string[] | undefined`, and
 * every other claim is typed `unknown`. The Nova tools downstream want
 * a concrete `JwtClaims` with `sub: string` guaranteed. The verify
 * layer has already checked the token signature + aud + iss, so a
 * missing `sub` at this point means the token is structurally broken;
 * we return a 401 (NOT a throw — `mcpHandler`'s outer catch reshapes
 * only `APIError` throws into 401s, so a plain throw would surface as
 * 500 and prevent Claude Code from triggering re-auth).
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
	MCP_RESOURCE_PATH,
	MCP_RESOURCE_URL,
} from "@/lib/hostnames";
import { log } from "@/lib/logger";
import { parseScopes, SCOPES } from "@/lib/mcp/scopes";
import { registerNovaTools } from "@/lib/mcp/server";
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
	| "missing token issue time"
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
		 * `@better-auth/core/dist/oauth2/verify.d.mts`). Both Nova
		 * read/write scopes are the floor for any tool call. The HQ
		 * scopes (`nova.hq.read`, `nova.hq.write`) deliberately stay
		 * OUT of this list — they're orthogonal to read/write and
		 * enforced per-tool inside the HQ handlers via `assertScope`,
		 * so a client without HQ scopes can still call non-HQ tools.
		 * See the "Two-layer scope enforcement" section in the module
		 * docblock above. */
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
		if (typeof jwt.iat !== "number" || !Number.isFinite(jwt.iat)) {
			log.error("[mcp] access token missing required `iat` claim", {
				sub: jwt.sub,
				clientId,
			});
			return mcpUnauthorizedResponse("missing token issue time");
		}

		/* The revocation lock — see the module docblock for why this
		 * exists. Firestore failure also returns 401: same reasoning as
		 * the missing-claim paths above. */
		let consentActive: boolean;
		try {
			consentActive = await hasActiveConsent(jwt.sub, clientId, jwt.iat);
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
			},
			{ serverInfo: { name: "nova", version: "1.0.0" } },
			/* `mcp-handler` matches `new URL(req.url).pathname` against
			 * its computed `${basePath}/mcp` endpoint. `Request.url`
			 * carries the wire URL the client sent — Next's middleware
			 * rewrites the routing target but does not update the
			 * Request, so a hardcoded `basePath: "/api"` 404s every
			 * production request that arrives via the
			 * `mcp.commcare.app/mcp` host (wire pathname `/mcp`, not
			 * `/api/mcp`). Strip the trailing `/mcp` from
			 * `MCP_RESOURCE_PATH` so basePath tracks the wire pathname
			 * per environment: empty in prod, `/api` in dev.
			 * `maxDuration` caps streaming response time at the protocol
			 * layer (distinct from the Next.js platform-timeout
			 * `maxDuration` exported above). */
			{
				basePath: MCP_RESOURCE_PATH.replace(/\/mcp$/, ""),
				maxDuration,
			},
		)(req);
	},
);

/**
 * MCP's streamable HTTP transport uses three HTTP verbs:
 *   - `POST` — JSON-RPC calls (tool invocations, initialization).
 *   - `GET`  — SSE stream for server-to-client notifications.
 *   - `DELETE` — explicit session termination.
 *
 * Nova holds no per-session state across requests (a fresh `McpServer`
 * is constructed per call), so DELETE is a no-op for resource release;
 * we still route it through the verified handler so token + scope
 * checks fire uniformly across verbs.
 */
export { handler as DELETE, handler as GET, handler as POST };
