/**
 * OAuth 2.0 protected-resource metadata (RFC 9728).
 *
 * Served ONLY on `mcp.commcare.app` — `lib/hostnames.ts` allowlists the path
 * on the MCP host and `proxy.ts` enforces the split, so the main host 404s
 * this route. Claude Code (and any other MCP client) fetches this URL on its
 * first tool call attempt; the response points it at `commcare.app` as the
 * authorization server, which it then discovers via the main-host
 * `/.well-known/oauth-authorization-server` document.
 *
 * Why this is hand-rolled instead of using a Better Auth helper:
 * `@better-auth/oauth-provider` exposes helpers for the AS-metadata and
 * OIDC-discovery documents (used by the sibling routes in this directory),
 * but does NOT ship a protected-resource equivalent and does NOT auto-register
 * a `/.well-known/oauth-protected-resource` route. The `better-auth/plugins`
 * package has `oAuthProtectedResourceMetadata`, but it proxies to the `mcp()`
 * plugin's `auth.api.getMCPProtectedResource` endpoint — the MCP plugin is
 * not registered in `lib/auth.ts`, so that helper would 404 at runtime. The
 * `oauthProviderResourceClient` + `createAuthClient` pattern from the docs is
 * intended for out-of-process resource servers; we're in-process in Next.js,
 * so the network hop is gratuitous. Publishing a static JSON document here —
 * the values are constants driven by `HOSTNAMES` — is the minimum that
 * satisfies RFC 9728 and MCP clients.
 *
 * No lazy-bind needed: unlike the sibling AS/OIDC routes, this handler never
 * touches `getAuth()`, Firestore, or runtime env. The module is safe to
 * import during `next build` page collection.
 *
 * The `resource` value is intentionally identical to the `validAudiences`
 * entry in `lib/auth.ts` (line ~269) — that pin is the security tie between
 * tokens the AS mints and this resource's accepted `aud` claim. Changing one
 * without the other breaks token verification on the MCP handler.
 */

import type { ResourceServerMetadata } from "@better-auth/oauth-provider";
import { HOSTNAMES } from "@/lib/hostnames";

/**
 * RFC 9728 document. Minimal on purpose — only the fields MCP clients read
 * during discovery are populated. `scopes_supported` / `jwks_uri` are omitted
 * to avoid duplicating `lib/auth.ts`'s scope list here; a future task can
 * plumb those through without touching this module's shape.
 */
const METADATA: ResourceServerMetadata = {
	resource: `https://${HOSTNAMES.mcp}`,
	authorization_servers: [`https://${HOSTNAMES.main}`],
	bearer_methods_supported: ["header"],
};

/**
 * Precomputed body + headers so every response is identical (no per-request
 * serialization work). The `Cache-Control` matches the pattern Better Auth's
 * own metadata helpers use — the document changes only on deploy, so CDN +
 * client caching for 15s with stale-while-revalidate is safe.
 */
const BODY = JSON.stringify(METADATA);
const HEADERS: HeadersInit = {
	"Content-Type": "application/json",
	"Cache-Control":
		"public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
};

export const GET = (): Response => new Response(BODY, { headers: HEADERS });
