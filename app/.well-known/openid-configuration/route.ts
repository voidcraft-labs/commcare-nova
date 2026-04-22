/**
 * OpenID Connect discovery document.
 *
 * OpenID Connect Discovery 1.0 §4 specifies the canonical path as
 * `{Issuer}/.well-known/openid-configuration`. With issuer
 * `https://commcare.app/api/auth` (Better Auth's default `basePath`) the
 * canonical URL is `/api/auth/.well-known/openid-configuration`, which
 * the `oauth-provider` plugin auto-registers. This wrapper publishes the
 * same document at the bare root path too, because a number of OIDC and
 * MCP clients probe the bare `/.well-known/openid-configuration` path
 * directly (stripping any issuer suffix). Serving at both eliminates the
 * compatibility gap without teaching every client our basePath.
 *
 * Lazy-bound for the same `next build` page-collection reason as the AS
 * metadata route next door — see
 * `app/.well-known/oauth-authorization-server/route.ts` for the full
 * rationale (`getAuth()` must not run at module load).
 *
 * Published on `commcare.app` only; `proxy.ts` + `lib/hostnames.ts` gate
 * the path to the main host.
 */

import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = (req: Request) =>
	oauthProviderOpenIdConfigMetadata(getAuth())(req);
