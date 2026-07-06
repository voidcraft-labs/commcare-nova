/**
 * API-key auth path for the MCP route.
 *
 * Sibling to the JWT path that lives in `route.ts`. The route's
 * top-level dispatcher peeks the `Authorization` header for
 * `NOVA_API_KEY_PREFIX` and forks here when it matches; both paths
 * converge on the shared `dispatchMcpTools` helper so downstream tools
 * see one identity shape (`ToolContext`) regardless of how the caller
 * authenticated. Extracted out of `route.ts` so that file stays focused
 * on routing + the JWT path; the API-key path's verifier, error-code
 * mapper, response builders, and reason union are this module's
 * concern.
 */

import { getAuth } from "@/lib/auth";
import { NOVA_API_KEY_PREFIX, NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { callerIpFromHeaders } from "@/lib/callerIp";
import { isUserActive } from "@/lib/db/api-keys";
import { log } from "@/lib/logger";
import type { ToolContext } from "@/lib/mcp/types";
import { dispatchMcpTools } from "./dispatch";

/**
 * Closed set of reasons mapped from the api-key plugin's error codes.
 * Same injection-safety rationale as `JwtUnauthorizedReason` —
 * `WWW-Authenticate` quotes the value but doesn't escape, so the set
 * has to stay closed.
 *
 * The plugin emits its own error codes (`KEY_NOT_FOUND`,
 * `KEY_DISABLED`, etc.); `mapApiKeyErrorCode` translates them into
 * this vocabulary. New plugin error codes that we want to surface
 * differently get a new entry here, never a widening of the type.
 */
type ApiKeyUnauthorizedReason =
	| "api key invalid"
	| "api key expired"
	| "api key disabled"
	| "api key verify failed"
	| "user disabled";

/**
 * Build a 401 for the API-key path. Same RFC 6750 Bearer challenge as
 * the JWT path, but no `resource_metadata` parameter — the client
 * explicitly chose API-key auth (the prefix proves it), so suggesting
 * OAuth fallback would mislead.
 *
 * Scope failures take a different path: `apiKeyForbiddenResponse`
 * returns 403 + `error="insufficient_scope"` per RFC 6750 §3. 401
 * means "credentials missing/invalid"; 403 means "credentials
 * accepted, scope not granted." Mixing them is a wire-contract bug a
 * compliant client trips on.
 */
function apiKeyUnauthorizedResponse(
	reason: ApiKeyUnauthorizedReason,
): Response {
	return new Response(null, {
		status: 401,
		headers: {
			"WWW-Authenticate": `Bearer error="invalid_token", error_description="${reason}"`,
		},
	});
}

/**
 * Build a 403 for the missing-scope branch. RFC 6750 §3 specifies
 * `error="insufficient_scope"` with HTTP 403 for "the request requires
 * higher privileges than provided by the access token" — distinct
 * from the 401 + `invalid_token` we use for failed authentication.
 * Aligns the API-key path with the JWT path: `mcpHandler` already
 * surfaces a 403 implicitly when the token is missing scope, via
 * `verifyAccessToken` throwing a `FORBIDDEN` `APIError`.
 */
function apiKeyForbiddenResponse(reason: "api key missing scope"): Response {
	return new Response(null, {
		status: 403,
		headers: {
			"WWW-Authenticate": `Bearer error="insufficient_scope", error_description="${reason}"`,
		},
	});
}

/**
 * Map plugin error codes to the closed `ApiKeyUnauthorizedReason` set.
 * Unknown codes fall through to `"api key invalid"`.
 *
 * Both `INVALID_API_KEY` (the plugin's hash-not-found code, verified
 * at `validateApiKey` in
 * `node_modules/@better-auth/api-key/dist/index.mjs`) and
 * `KEY_NOT_FOUND` (the plugin's stored-key-has-no-permissions code,
 * which surfaces only when the route calls `verifyApiKey` with a
 * `permissions` argument — Nova's route doesn't) collapse to the
 * same `"api key invalid"` reason. The collapse is deliberate: the
 * client gets no key-existence side channel, and the diagnostic
 * difference is preserved on the server side via the `pluginCode`
 * field of the verify-failed `log.warn`.
 *
 * `INSUFFICIENT_API_KEY_PERMISSIONS` is reserved by the plugin for
 * the org-keys path (`checkOrgApiKeyPermission`); not reachable on a
 * `references: "user"` mount.
 */
function mapApiKeyErrorCode(
	code: string | undefined,
): ApiKeyUnauthorizedReason {
	switch (code) {
		case "KEY_NOT_FOUND":
		case "INVALID_API_KEY":
			return "api key invalid";
		case "KEY_EXPIRED":
			return "api key expired";
		case "KEY_DISABLED":
			return "api key disabled";
		default:
			return "api key invalid";
	}
}

/**
 * Number of leading characters of any Nova bearer logged on a verify
 * failure for audit correlation. Aligned with the settings UI's
 * masked-display length (`startingCharactersConfig.charactersLength`
 * in `lib/auth.ts`, which is `NOVA_API_KEY_PREFIX.length + 6`), so a
 * sysadmin reading 401 bursts in logs can map them back to the named
 * key in the user's settings list — both surfaces show the prefix
 * plus the same six body chars, never more. The remaining body bytes
 * carry the key's entropy and stay out of logs.
 */
const PREFIX_LOG_LENGTH = NOVA_API_KEY_PREFIX.length + 6;

/**
 * Run the API-key auth path. Pre-condition: caller has already
 * verified the bearer starts with `NOVA_API_KEY_PREFIX`, so a 401
 * here is unambiguously an API-key auth failure (no chance the caller
 * meant OAuth).
 *
 * Floor-scope enforcement is local, not delegated to the plugin's
 * `verifyApiKey({ permissions })` arg. Reason: when the plugin runs
 * the permission check internally (with `permissions` passed in), a
 * scope mismatch throws `KEY_NOT_FOUND` — `mapApiKeyErrorCode`
 * collapses that to `"api key invalid"`, indistinguishable on the
 * wire from a stale or malformed key. Verifying the key shape
 * without the `permissions` arg and comparing the granted
 * `permissions.scope` against `NOVA_MCP_FLOOR_SCOPES` here lets
 * the route emit a distinct `"api key missing scope"` 403 the plugin
 * can't return.
 *
 * On success, build `ToolContext` from the verified key's
 * `referenceId` (the userId for our `references: "user"` config) and
 * its decoded `permissions.scope`. The context shape matches the JWT
 * path 1:1 so downstream tools see no difference.
 */
export async function handleApiKeyMcp(
	req: Request,
	key: string,
): Promise<Response> {
	const auth = await getAuth();

	let result: Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
	try {
		result = await auth.api.verifyApiKey({ body: { key } });
	} catch (err) {
		log.warn("[mcp/api-key] verify threw", {
			prefixSeen: key.slice(0, PREFIX_LOG_LENGTH),
			ip: callerIpFromHeaders(req.headers),
			err: err instanceof Error ? err.message : String(err),
		});
		return apiKeyUnauthorizedResponse("api key verify failed");
	}

	if (!result.valid || !result.key) {
		const code = result.error?.code ?? undefined;
		const reason = mapApiKeyErrorCode(code);
		log.warn("[mcp/api-key] verify failed", {
			prefixSeen: key.slice(0, PREFIX_LOG_LENGTH),
			ip: callerIpFromHeaders(req.headers),
			reason,
			pluginCode: code ?? "unknown",
		});
		return apiKeyUnauthorizedResponse(reason);
	}

	const verifiedKey = result.key;
	/* `referenceId` carries the userId for our `references: "user"`
	 * configuration. For `"organization"` configs it would be an org
	 * id, but Nova doesn't enable that mode — see the api-key plugin
	 * mount in `lib/auth.ts`. The plugin's `ApiKey` type pins this
	 * field to a string, but we still defend against an empty value
	 * because a regression in the verify endpoint that returned a
	 * blank reference would otherwise hand tools a userId-shaped empty
	 * string (a `WHERE userId = ''` lookup would just match nothing and
	 * leak nothing — but the cleaner failure is a 401). */
	const userId = verifiedKey.referenceId;
	if (typeof userId !== "string" || !userId) {
		log.error("[mcp/api-key] verified key has no referenceId", {
			keyId: verifiedKey.id,
		});
		return apiKeyUnauthorizedResponse("api key invalid");
	}
	const scopes =
		verifiedKey.permissions && Array.isArray(verifiedKey.permissions.scope)
			? verifiedKey.permissions.scope
			: [];

	/* Floor-scope check, locally — see the function docblock for why
	 * this isn't delegated to `verifyApiKey({ permissions })`. 403 +
	 * `insufficient_scope` per RFC 6750 §3, matching the JWT path's
	 * implicit 403 from `mcpHandler`'s scope verification. */
	for (const required of NOVA_MCP_FLOOR_SCOPES) {
		if (!scopes.includes(required)) {
			log.warn("[mcp/api-key] missing floor scope", {
				keyId: verifiedKey.id,
				ip: callerIpFromHeaders(req.headers),
				missing: required,
				granted: scopes,
			});
			return apiKeyForbiddenResponse("api key missing scope");
		}
	}

	/* Live revocation lock — the api-key plugin's `validateApiKey`
	 * does not cross-reference `auth_user`, so a banned or deleted
	 * user's pre-minted keys would otherwise authenticate forever.
	 * The JWT path runs this SAME `isUserActive` gate (alongside its
	 * access-token TTL + `hasActiveConsent`), so revocation is universal
	 * across both MCP bearers; this read is its equivalent. The local catch
	 * translates a database outage into 401, matching the verifier-throw
	 * branch — fail-closed posture: a transient outage rejects rather than
	 * authenticates a possibly-banned user. */
	let active: boolean;
	try {
		active = await isUserActive(userId);
	} catch (err) {
		log.error("[mcp/api-key] user-status lookup failed", {
			keyId: verifiedKey.id,
			userId,
			prefixSeen: key.slice(0, PREFIX_LOG_LENGTH),
			ip: callerIpFromHeaders(req.headers),
			err: err instanceof Error ? err.message : String(err),
		});
		return apiKeyUnauthorizedResponse("api key verify failed");
	}
	if (!active) {
		log.warn("[mcp/api-key] user disabled or deleted", {
			keyId: verifiedKey.id,
			userId,
			prefixSeen: key.slice(0, PREFIX_LOG_LENGTH),
			ip: callerIpFromHeaders(req.headers),
		});
		return apiKeyUnauthorizedResponse("user disabled");
	}

	const ctx: ToolContext = {
		userId,
		scopes,
		authKind: "api-key",
	};
	return dispatchMcpTools(req, ctx);
}
