/**
 * OAuth-issued JWT auth path for the MCP route.
 *
 * Sibling to `api-key-auth.ts`. The plugin endpoint in `auth-plugin.ts`
 * peeks the bearer prefix and dispatches here for any bearer that does
 * NOT start with `NOVA_API_KEY_PREFIX`. Both paths converge on
 * `dispatchMcpTools` so downstream tools see one `ToolContext`.
 *
 * `mcpHandler` from `@better-auth/oauth-provider` does the heavy
 * lifting: pulls the bearer off the request, verifies it against the
 * AS's JWKS, and returns its own `WWW-Authenticate: Bearer
 * resource_metadata="…"` 401 on missing or invalid tokens so Claude
 * Code can auto-discover the AS and start the OAuth flow.
 *
 * After verify succeeds, the inner callback enforces structural
 * claim presence (`sub`, `azp`, `iat`), then runs TWO revocation
 * locks before building the `ToolContext` and dispatching tools —
 * access-token verification is self-contained, so without them a
 * token outlives the conditions it was minted under. The per-GRANT
 * lock (`hasActiveConsent`) catches a consent revoked from
 * `/settings`; the per-USER lock (`isUserActive`) catches a
 * banned/deleted user, the same gate the API-key path runs so
 * revocation is universal across both MCP bearers.
 */

import { mcpHandler } from "@better-auth/oauth-provider";
import type { JWTPayload } from "jose";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { isUserActive } from "@/lib/db/api-keys";
import { hasActiveConsent } from "@/lib/db/oauth-consents";
import {
	AS_ISSUER,
	AS_ORIGIN,
	MCP_RESOURCE_METADATA_URL,
	MCP_RESOURCE_URL,
} from "@/lib/hostnames";
import { log } from "@/lib/logger";
import { parseScopes } from "@/lib/mcp/scopes";
import type { JwtClaims, ToolContext } from "@/lib/mcp/types";
import { dispatchMcpTools } from "./dispatch";

/**
 * Closed set of reasons that flow into the `error_description` param
 * of `WWW-Authenticate`. RFC 6750 quotes the value but performs no
 * escaping, so widening to `string` would let a future caller inject
 * sibling params (`error="..." x="injected"`) by passing a value
 * containing `"`. Add new reasons here, never widen.
 */
type JwtUnauthorizedReason =
	| "missing client identity"
	| "missing subject claim"
	| "missing token issue time"
	| "consent revoked"
	| "account disabled"
	| "auth check failed";

/**
 * Build a 401 with the upstream plugin's `WWW-Authenticate` shape plus
 * RFC 6750 §3 `error` / `error_description` for client-side diagnostics.
 * The `resource_metadata` parameter points clients at the AS metadata
 * so Claude Code can auto-discover and start the OAuth flow.
 */
function jwtUnauthorizedResponse(reason: JwtUnauthorizedReason): Response {
	return new Response(null, {
		status: 401,
		headers: {
			"WWW-Authenticate": `Bearer resource_metadata="${MCP_RESOURCE_METADATA_URL}", error="invalid_token", error_description="${reason}"`,
		},
	});
}

/**
 * Module-level singleton — `mcpHandler` builds a verifier closure
 * around the JWKS URL and verify options, so reusing it across
 * requests is correct and cheap. Re-instantiating per call would
 * spawn redundant JWKS-fetch caches.
 */
export const handleJwtMcp: (req: Request) => Promise<Response> = mcpHandler(
	{
		/* JWKS lives on the AS origin — the `jwt` plugin exposes
		 * `/api/auth/jwks` there and that's the signing keypair
		 * `oauth-provider` uses to mint access tokens. `AS_ORIGIN`
		 * resolves to `https://commcare.app` in prod and `BETTER_AUTH_URL`
		 * in dev (typically `http://localhost:3000`). */
		jwksUrl: `${AS_ORIGIN}/api/auth/jwks`,
		verifyOptions: {
			/* `issuer` is what the AS stamps as `iss` on every token it
			 * mints. Better Auth's issuer includes its `/api/auth` base
			 * path (see the AS metadata document's `issuer`). `audience`
			 * is what the AS stamps as `aud` (pinned via
			 * `validAudiences: [MCP_RESOURCE_URL]` in `lib/auth.ts`). */
			issuer: AS_ISSUER,
			audience: MCP_RESOURCE_URL,
		},
		/* Outer-level scopes — a sibling of `verifyOptions`, NOT nested
		 * inside it. The verify helper's semantics are "token must carry
		 * ALL listed scopes, extras allowed" (source of truth:
		 * `@better-auth/core/dist/oauth2/verify.d.mts`). The HQ scopes
		 * (`nova.hq.read`, `nova.hq.write`) deliberately stay OUT of
		 * this list — they're orthogonal to read/write and enforced
		 * per-tool inside the HQ handlers via `assertScope`, so a
		 * client without HQ scopes can still call non-HQ tools.
		 *
		 * `NOVA_MCP_FLOOR_SCOPES` is the single source of truth
		 * for the read/write floor — same constant the API-key path's
		 * local check and the Server Actions' `validateScopes`
		 * reference. Spread into a mutable array because Better Auth's
		 * type wants `string[]` not `readonly string[]`. */
		scopes: [...NOVA_MCP_FLOOR_SCOPES],
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
			return jwtUnauthorizedResponse("missing subject claim");
		}
		const clientId = typeof jwt.azp === "string" ? jwt.azp : undefined;
		if (!clientId) {
			log.error("[mcp] access token missing required `azp` claim", {
				sub: jwt.sub,
			});
			return jwtUnauthorizedResponse("missing client identity");
		}
		if (typeof jwt.iat !== "number" || !Number.isFinite(jwt.iat)) {
			log.error("[mcp] access token missing required `iat` claim", {
				sub: jwt.sub,
				clientId,
			});
			return jwtUnauthorizedResponse("missing token issue time");
		}

		/* Per-grant revocation lock. Without this read, a token whose
		 * grant was revoked from `/settings` would keep authenticating
		 * until expiry — `hasActiveConsent` compares `iat` against the
		 * per-grant revocation watermark, so a stale token fails
		 * immediately. A lookup failure returns 401 with the same
		 * reasoning as the missing-claim paths: fail-closed posture. */
		let consentActive: boolean;
		try {
			consentActive = await hasActiveConsent(jwt.sub, clientId, jwt.iat);
		} catch (err) {
			log.error("[mcp] consent lookup failed", err);
			return jwtUnauthorizedResponse("auth check failed");
		}
		if (!consentActive) {
			return jwtUnauthorizedResponse("consent revoked");
		}

		/* Live revocation lock on the USER, not just the grant. `hasActiveConsent`
		 * above catches a revoked GRANT, but a banned/deleted user whose grant is
		 * still live would keep authenticating until the access token's TTL
		 * lapsed — and could even mint a fresh grant inside the 5-min cookie
		 * cache window (the consent page reads the cached session). This makes the
		 * JWT path enforce the SAME `isUserActive` gate the API-key path runs, so
		 * revocation is universal across both MCP bearers. Fail CLOSED on a lookup
		 * error (the consent check above is fail-closed too): a transient datastore
		 * outage rejects rather than authenticates a possibly-banned user. (The
		 * web-session choke points fail OPEN instead, to avoid mass sign-out;
		 * rejecting a narrow MCP call is the safer trade here.) */
		let userActive: boolean;
		try {
			userActive = await isUserActive(jwt.sub);
		} catch (err) {
			log.error("[mcp] user-status lookup failed", err);
			return jwtUnauthorizedResponse("auth check failed");
		}
		if (!userActive) {
			log.warn("[mcp] user disabled or deleted", { sub: jwt.sub, clientId });
			return jwtUnauthorizedResponse("account disabled");
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

		const ctx: ToolContext = {
			userId: claims.sub,
			scopes: parseScopes(claims.scope),
			authKind: "oauth",
		};
		return dispatchMcpTools(req, ctx);
	},
);
