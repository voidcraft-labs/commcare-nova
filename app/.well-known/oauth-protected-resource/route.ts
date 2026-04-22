/**
 * RFC 9728 protected-resource metadata.
 *
 * Served only on `mcp.commcare.app` — `proxy.ts` enforces the hostname
 * allowlist so the main host 404s this path. Points MCP clients at
 * `commcare.app` as the authorization server and pins `mcp.commcare.app`
 * as the expected audience on every access token the AS mints.
 *
 * The `resource` value here is the security tie to `validAudiences` in
 * `lib/auth.ts`: the AS mints tokens with an `aud` claim matching this
 * URL, the MCP handler rejects tokens whose `aud` doesn't match. Changing
 * one without the other breaks token verification at the MCP boundary.
 *
 * Built via `@better-auth/oauth-provider`'s `oauthProviderResourceClient`
 * helper, which assembles the document from the AS's own config — scope
 * list, JWKS URL, and algorithms come from the wired plugin rather than
 * being duplicated here.
 */

import { HOSTNAMES } from "@/lib/hostnames";
import { serverClient } from "@/lib/server-client";

export const GET = async (): Promise<Response> => {
	const metadata = await serverClient.getProtectedResourceMetadata({
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
