/**
 * OAuth 2.1 authorization server metadata (RFC 8414).
 *
 * Served only on commcare.app — `proxy.ts` allowlists this path on the main
 * host and rejects it on the MCP host (see `lib/hostnames.ts`). Claude Code
 * and other MCP clients read this endpoint to discover the token,
 * authorization, and dynamic-registration endpoints for the OAuth flow.
 *
 * Why this route exists alongside the plugin's auto-registered endpoint:
 * `@better-auth/oauth-provider` performs RFC 8414 "path insertion" — because
 * our issuer is `/api/auth`, the plugin's built-in metadata is actually
 * exposed at `/.well-known/oauth-authorization-server/api/auth`. Some
 * RFC 8414 clients — Claude Code among them — only probe the bare
 * `/.well-known/oauth-authorization-server` path and don't attempt the
 * issuer-inserted variant the plugin auto-registers. Mounting the same
 * `oauthProviderAuthServerMetadata` helper here gives us the canonical
 * discovery URL without duplicating logic — the helper generates the correct
 * document regardless of which path it lives at.
 *
 * Lazy-bind rationale: the handler awaits `getAuth()` on first request, not at
 * module-load. `next build` imports this route during page collection, and the
 * auth singleton opens the Postgres pool and reads OAuth secrets from env at
 * construction time — eager evaluation would fail the build on any machine
 * without a full runtime env (CI, Docker build, local clones). Mirrors
 * `app/api/auth/[...all]/route.ts`.
 */

import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

export const GET = async (req: Request) =>
	oauthProviderAuthServerMetadata(await getAuth())(req);
