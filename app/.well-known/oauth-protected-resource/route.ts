/**
 * RFC 9728 protected-resource metadata.
 *
 * Served on the MCP host in prod (`proxy.ts` enforces the allowlist so
 * the main host 404s this path there). Points MCP clients at the AS
 * origin and pins the MCP endpoint URL as the expected audience on every
 * access token the AS mints.
 *
 * Both `resource` and `authorization_servers` are passed as overrides
 * because in prod they live on different subdomains — defaults the
 * helper derives from the wired `auth` would point at the main host for
 * both, which isn't what this resource advertises. In dev, the two
 * collapse to `BETTER_AUTH_URL` for origins, while the resource path
 * follows the local/prod MCP endpoint (see `AS_ORIGIN` and
 * `MCP_RESOURCE_URL` in `lib/hostnames.ts`). Every other field in the
 * document — `scopes_supported`, `jwks_uri`,
 * `resource_signing_alg_values_supported` — is filled in from the wired
 * `oauthProvider` plugin via the auth bound on `getServerClient()`.
 *
 * The `resource` value is the security tie to `validAudiences` in
 * `lib/auth.ts`: the AS mints tokens with an `aud` claim matching this
 * URL, the MCP handler rejects tokens whose `aud` doesn't match. Both
 * references read from `MCP_RESOURCE_URL` so the link is enforced by
 * construction — no hand-kept duplication.
 */

import { AS_ORIGIN, MCP_RESOURCE_URL } from "@/lib/hostnames";
import { getServerClient } from "@/lib/server-client";

export const GET = async (): Promise<Response> => {
	const metadata = await getServerClient().getProtectedResourceMetadata({
		resource: MCP_RESOURCE_URL,
		authorization_servers: [AS_ORIGIN],
	});
	/* 15s fresh + 15s stale-while-revalidate keeps MCP-client cold-start
	 * traffic from hammering this route without sacrificing deploy-time
	 * coherence; `stale-if-error` keeps a stale doc serving for a day if
	 * the AS is transiently unreachable. Matches the Cache-Control pattern
	 * in Better Auth's own docs example for this endpoint. */
	return Response.json(metadata, {
		headers: {
			"Cache-Control":
				"public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
		},
	});
};
