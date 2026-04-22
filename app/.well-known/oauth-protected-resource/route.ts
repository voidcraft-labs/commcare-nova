/**
 * RFC 9728 protected-resource metadata.
 *
 * Served only on `mcp.commcare.app` — `proxy.ts` enforces the hostname
 * allowlist so the main host 404s this path. Points MCP clients at
 * `commcare.app` as the authorization server and pins `mcp.commcare.app`
 * as the expected audience on every access token the AS mints.
 *
 * Both `resource` and `authorization_servers` are passed as overrides
 * because they live on different subdomains than the AS's baseURL —
 * defaults the helper derives from the wired `auth` would point at the
 * main host for both, which isn't what this resource advertises. Every
 * other field in the document — `scopes_supported`, `jwks_uri`,
 * `resource_signing_alg_values_supported` — is filled in from the wired
 * `oauthProvider` plugin via the auth bound on `getServerClient()`.
 *
 * The `resource` value is the security tie to `validAudiences` in
 * `lib/auth.ts`: the AS mints tokens with an `aud` claim matching this
 * URL, the MCP handler rejects tokens whose `aud` doesn't match. Both
 * references resolve to `HOSTNAMES.mcp` so the link is enforced by
 * construction — no hand-kept duplication.
 */

import { HOSTNAMES } from "@/lib/hostnames";
import { getServerClient } from "@/lib/server-client";

export const GET = async (): Promise<Response> => {
	const metadata = await getServerClient().getProtectedResourceMetadata({
		resource: `https://${HOSTNAMES.mcp}`,
		authorization_servers: [`https://${HOSTNAMES.main}`],
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
