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
import { apiKeyRowExists, isUserActive } from "@/lib/db/api-keys";
import { log } from "@/lib/logger";
import type { ToolContext } from "@/lib/mcp/types";
import { dispatchMcpTools } from "./dispatch";
import { mcpUnavailableResponse } from "./unavailable";

/**
 * Closed set of reasons mapped from the api-key plugin's error codes.
 * Same injection-safety rationale as `JwtUnauthorizedReason`:
 * `WWW-Authenticate` quotes the value but doesn't escape, so the set
 * has to stay closed.
 *
 * The plugin emits its own error codes (`KEY_NOT_FOUND`,
 * `KEY_DISABLED`, etc.); `mapApiKeyErrorCode` translates them into
 * this vocabulary. New plugin error codes that we want to surface
 * differently get a new entry here, never a widening of the type.
 * An outage is never a reason: a judgment the route could NOT make
 * answers `mcpUnavailableResponse` (503) instead, so the client keeps
 * its key and retries rather than discarding a working credential.
 */
type ApiKeyUnauthorizedReason =
	| "api key invalid"
	| "api key expired"
	| "api key disabled"
	| "user disabled";

/**
 * Build a 401 for the API-key path. Same RFC 6750 Bearer challenge as
 * the JWT path, but no `resource_metadata` parameter: the client
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
 * higher privileges than provided by the access token": distinct
 * from the 401 + `invalid_token` we use for failed authentication.
 * Aligns the API-key path with the JWT path: the protected-request handler
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
 * Map the plugin error codes the route has positively judged to the closed
 * `ApiKeyUnauthorizedReason` set. A code this route does not know maps to
 * `null`, and `handleApiKeyMcp` answers it as an outage: only a verdict the
 * plugin documents may tell a client its key is bad, so a plugin upgrade
 * that reports its collapsed database error under a new code degrades to a
 * 503 (and a logged code to map), never to a discarded key.
 *
 * `KEY_NOT_FOUND` (the plugin's stored-key-has-no-permissions code,
 * which surfaces only when the route calls `verifyApiKey` with a
 * `permissions` argument: Nova's route doesn't) reads as `"api key
 * invalid"`: the client gets no key-existence side channel, and the
 * diagnostic difference is preserved on the server side via the
 * `pluginCode` field of the verify-failed `log.warn`.
 *
 * `INVALID_API_KEY` never reaches this mapper: a bearer with no stored
 * row is refused before the plugin runs, so that code can only mean the
 * plugin's lookup failed, and `handleApiKeyMcp` answers it as an outage
 * (see `apiKeyRowExists`).
 *
 * `INSUFFICIENT_API_KEY_PERMISSIONS` is reserved by the plugin for
 * the org-keys path (`checkOrgApiKeyPermission`); not reachable on a
 * `references: "user"` mount.
 */
function mapApiKeyErrorCode(
	code: string | undefined,
): ApiKeyUnauthorizedReason | null {
	switch (code) {
		case "KEY_NOT_FOUND":
			return "api key invalid";
		case "KEY_EXPIRED":
			return "api key expired";
		case "KEY_DISABLED":
			return "api key disabled";
		default:
			return null;
	}
}

/**
 * Number of leading characters of any Nova bearer logged on a verify
 * failure for audit correlation. Aligned with the settings UI's
 * masked-display length (`startingCharactersConfig.charactersLength`
 * in `lib/auth.ts`, which is `NOVA_API_KEY_PREFIX.length + 6`), so a
 * sysadmin reading 401 bursts in logs can map them back to the named
 * key in the user's settings list: both surfaces show the prefix
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
 * scope mismatch throws `KEY_NOT_FOUND`: `mapApiKeyErrorCode`
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
 *
 * An outage is a 503, never a 401. The stored-row read
 * (`apiKeyRowExists`) runs FIRST: a bearer with no row is refused without
 * the plugin, a database failure answers 503 after one pool acquire rather
 * than after the plugin's own attempt and then ours, and once the row is
 * known to exist the plugin's `INVALID_API_KEY` can only mean its lookup
 * failed (it substitutes that code for a database error). The verifier
 * throwing and the user-status read throwing are outages too. Each rejects
 * the request (fail-closed: nothing authenticates during an outage) with
 * `mcpUnavailableResponse`, because a `401 invalid_token` would tell a
 * client holding a working key to discard it.
 */
export async function handleApiKeyMcp(
	req: Request,
	key: string,
): Promise<Response> {
	const auth = await getAuth();
	const audit = {
		prefixSeen: key.slice(0, PREFIX_LOG_LENGTH),
		ip: callerIpFromHeaders(req.headers),
	};

	let stored: boolean;
	try {
		stored = await apiKeyRowExists(key);
	} catch (err) {
		log.error("[mcp/api-key] key lookup unavailable", err, audit);
		return mcpUnavailableResponse();
	}
	if (!stored) {
		log.warn("[mcp/api-key] verify failed", {
			...audit,
			reason: "api key invalid",
			pluginCode: "none",
		});
		return apiKeyUnauthorizedResponse("api key invalid");
	}

	let result: Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
	try {
		result = await auth.api.verifyApiKey({ body: { key } });
	} catch (err) {
		/* The plugin swallows its own database errors (see
		 * `apiKeyRowExists`), so a throw here is a novel failure, not the
		 * outage signal, and earns Sentry like the sibling reads below. */
		log.error("[mcp/api-key] verify threw", err, audit);
		return mcpUnavailableResponse();
	}

	if (!result.valid || !result.key) {
		const code = result.error?.code ?? undefined;
		if (code === "INVALID_API_KEY") {
			/* The row was stored a moment ago, so the plugin's lookup failed
			 * on the database (or the key was revoked between the two reads,
			 * which the client's retry answers exactly). Cloud Logging only:
			 * the plugin already reported the underlying error through the
			 * auth-logger bridge, and one Sentry event per request during an
			 * outage says nothing new. */
			log.warn("[mcp/api-key] verify could not read a stored key", {
				...audit,
				pluginCode: code,
			});
			return mcpUnavailableResponse();
		}
		const reason = mapApiKeyErrorCode(code);
		if (reason === null) {
			log.error(
				"[mcp/api-key] verify answered a code this route does not map",
				undefined,
				{
					...audit,
					pluginCode: code ?? "unknown",
				},
			);
			return mcpUnavailableResponse();
		}
		log.warn("[mcp/api-key] verify failed", {
			...audit,
			reason,
			pluginCode: code,
		});
		return apiKeyUnauthorizedResponse(reason);
	}

	const verifiedKey = result.key;
	/* `referenceId` carries the userId for our `references: "user"`
	 * configuration. For `"organization"` configs it would be an org
	 * id, but Nova doesn't enable that mode: see the api-key plugin
	 * mount in `lib/auth.ts`. The plugin's `ApiKey` type pins this
	 * field to a string, but we still defend against an empty value
	 * because a regression in the verify endpoint that returned a
	 * blank reference would otherwise hand tools a userId-shaped empty
	 * string (a `WHERE userId = ''` lookup would just match nothing and
	 * leak nothing, but the cleaner failure is a 401). */
	const userId = verifiedKey.referenceId;
	if (typeof userId !== "string" || !userId) {
		log.error("[mcp/api-key] verified key has no referenceId", undefined, {
			keyId: verifiedKey.id,
		});
		return apiKeyUnauthorizedResponse("api key invalid");
	}
	const scopes =
		verifiedKey.permissions && Array.isArray(verifiedKey.permissions.scope)
			? verifiedKey.permissions.scope
			: [];

	/* Floor-scope check, locally: see the function docblock for why
	 * this isn't delegated to `verifyApiKey({ permissions })`. 403 +
	 * `insufficient_scope` per RFC 6750 §3, matching the JWT path's
	 * implicit 403 from the protected handler's scope verification. */
	for (const required of NOVA_MCP_FLOOR_SCOPES) {
		if (!scopes.includes(required)) {
			log.warn("[mcp/api-key] missing floor scope", {
				keyId: verifiedKey.id,
				ip: audit.ip,
				missing: required,
				granted: scopes,
			});
			return apiKeyForbiddenResponse("api key missing scope");
		}
	}

	/* Live revocation lock: the api-key plugin's `validateApiKey`
	 * does not cross-reference `auth_user`, so a banned or deleted
	 * user's pre-minted keys would otherwise authenticate forever.
	 * The JWT path runs this SAME `isUserActive` gate (alongside its
	 * access-token TTL + `hasActiveConsent`), so revocation is universal
	 * across both MCP bearers; this read is its equivalent. The local catch
	 * answers a database outage with 503, matching the verifier-throw
	 * branch: fail-closed, a transient outage rejects rather than
	 * authenticates a possibly-banned user, and as an outage the client
	 * retries rather than a bad key it discards. */
	let active: boolean;
	try {
		active = await isUserActive(userId);
	} catch (err) {
		log.error("[mcp/api-key] user-status lookup failed", err, {
			keyId: verifiedKey.id,
			userId,
			...audit,
		});
		return mcpUnavailableResponse();
	}
	if (!active) {
		log.warn("[mcp/api-key] user disabled or deleted", {
			keyId: verifiedKey.id,
			userId,
			...audit,
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
