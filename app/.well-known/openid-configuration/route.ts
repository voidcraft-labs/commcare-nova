/**
 * OpenID Connect discovery document.
 *
 * Lazy-bound for the same build-time reason as the AS-metadata route next
 * door — `getAuth()` must not run during `next build`'s page collection. See
 * app/.well-known/oauth-authorization-server/route.ts for the full rationale.
 *
 * Published on commcare.app only; proxy.ts + lib/hostnames.ts gate the path
 * to the main host.
 */

import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = (req: Request) =>
	oauthProviderOpenIdConfigMetadata(getAuth())(req);
