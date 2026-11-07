/**
 * OAuth 2.1 authorization server metadata (RFC 8414).
 *
 * Served only on commcare.app: `proxy.ts` allowlists this path on the main
 * host and rejects it on the MCP host (see `lib/hostnames.ts`). Claude Code
 * and other MCP clients read this endpoint to discover the token,
 * authorization, and dynamic-registration endpoints for the OAuth flow.
 *
 * The canonical issuer is `/api/auth`, so RFC 8414 discovery lives at
 * `/.well-known/oauth-authorization-server/api/auth`. Its explicit Next route
 * reuses this handler: the auth plugin cannot expose paths outside Next's
 * `/api/auth/[...all]` route by itself. This bare path remains an alias for
 * existing clients that probe the origin directly. Both documents retain the
 * canonical issuer; protected-resource metadata advertises that exact issuer.
 *
 * Lazy-bind rationale: the handler awaits `getAuth()` on first request, not at
 * module-load. `next build` imports this route during page collection, and the
 * auth singleton opens the Postgres pool and reads OAuth secrets from env at
 * construction time: eager evaluation would fail the build on any machine
 * without a full runtime env (CI, Docker build, local clones). Mirrors
 * `app/api/auth/[...all]/route.ts`.
 */

import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = async (req: Request) =>
	oauthProviderAuthServerMetadata(await getAuth())(req);
