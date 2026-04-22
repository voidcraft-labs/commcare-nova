/**
 * OpenID Connect discovery document.
 *
 * OIDC's convention (OpenID Connect Discovery 1.0 §4) places this document at
 * the bare `/.well-known/openid-configuration` path, but the plugin's
 * auto-registered route lives under our issuer's basePath
 * (`/api/auth/.well-known/openid-configuration`). Publishing it here gives
 * OIDC-aware clients — many MCP clients included — a working discovery URL
 * without forcing them to learn the basePath-prefixed variant.
 *
 * Lazy-bound for the same build-time reason as the AS-metadata route next
 * door — `getAuth()` must not run during `next build`'s page collection. See
 * `app/.well-known/oauth-authorization-server/route.ts` for the full
 * rationale.
 *
 * Published on commcare.app only; `proxy.ts` + `lib/hostnames.ts` gate the
 * path to the main host.
 */

import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = (req: Request) =>
	oauthProviderOpenIdConfigMetadata(getAuth())(req);
