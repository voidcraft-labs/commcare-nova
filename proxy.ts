/**
 * Next.js 16 proxy — hostname routing + CSP + optimistic auth redirect.
 *
 * The "proxy" file convention is the one place every request flows through
 * before reaching a route handler or page. This file owns three concerns
 * layered in order:
 *
 *   1. **Hostname routing.** A single Cloud Run service serves three
 *      virtual hosts (`commcare.app`, `mcp.commcare.app`,
 *      `docs.commcare.app`). Per-host path allowlists in `lib/hostnames.ts`
 *      enforce that the MCP subdomain only exposes MCP routes, the docs
 *      subdomain only exposes docs, and everything off-allowlist 404s
 *      with `Cache-Control: no-store` so the security boundary cannot be
 *      cached. The MCP subdomain rewrites `/mcp` → `/api/mcp` so the
 *      externally visible URL stays clean while the file-system route
 *      lives at the Next conventional path.
 *
 *   2. **API + well-known short-circuit.** `/api/*` paths skip CSP + auth
 *      entirely on every host that reaches this stage — those concerns
 *      apply to pages, not JSON endpoints, and an HTML auth redirect
 *      would silently break every API client. `/.well-known/*` joins the
 *      same short-circuit because OAuth/OIDC discovery documents are
 *      static metadata that must be reachable unauthenticated, with no
 *      page-shaped CSP/nonce assembly. The matcher includes `/api` so
 *      the MCP host can intercept `/api/mcp` in step 1.
 *
 *   3. **Pages: nonce-based CSP + optimistic auth.** Every page request
 *      gets a per-request nonce on `Content-Security-Policy` (response)
 *      and `x-nonce` (request, for RSC). Unauthenticated requests on
 *      protected pages are redirected to `/`. The redirect only goes
 *      TO `/`, never FROM it — the landing page does the reverse with
 *      full session validation, so a stale cookie cannot loop.
 */

import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import {
	classifyHost,
	HOSTNAME_ALLOWLIST,
	HOSTNAMES,
	isPathAllowedOnHost,
	normalizeHost,
} from "@/lib/hostnames";

/**
 * Build a 404 with `Cache-Control: no-store`. Off-allowlist requests share
 * this response so the hostname security boundary cannot be cached by an
 * intermediate (CDN, browser disk cache) and then served back as a
 * positive answer if the allowlist later changes.
 *
 * The body is `null` rather than a courtesy "Not Found" string. With a
 * non-null body the underlying `Response` carries an internal body
 * promise that never settles unless the body is read — irrelevant in
 * production (the response goes straight to the wire) but a leak under
 * vitest's async-leak detection. Browsers and CLI tools render their own
 * default 404 surface against an empty body, so there is no UX cost.
 */
function notFound(): NextResponse {
	return new NextResponse(null, {
		status: 404,
		headers: {
			"Cache-Control": "no-store",
		},
	});
}

/**
 * Build a CSP string with a fresh per-request nonce, plus the matching
 * `x-nonce` header. Both halves are needed: the request-side `CSP`
 * header lets Next.js parse out the nonce during SSR and auto-stamp it
 * onto every framework-generated `<script>` (the `_next/static/*`
 * bundles), and the response-side header enforces the policy in the
 * browser. Without the request side, `'strict-dynamic'` blocks every
 * framework bundle and the page renders blank in production.
 */
function buildCsp(isDev: boolean): { csp: string; nonce: string } {
	/* 16 raw random bytes encoded as base64. `randomUUID()` would yield
	 * an ASCII string with structurally fixed dashes and version nibbles —
	 * base64-encoding that wastes entropy the CSP nonce relies on to
	 * resist guessing. */
	const nonceBytes = new Uint8Array(16);
	crypto.getRandomValues(nonceBytes);
	const nonce = Buffer.from(nonceBytes).toString("base64");
	const csp = [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' blob: data: *.googleusercontent.com",
		"font-src 'self'",
		"connect-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		...(!isDev ? ["upgrade-insecure-requests"] : []),
	].join("; ");
	return { csp, nonce };
}

/**
 * Attach CSP + nonce to a page response and return the updated headers.
 * Sets the policy on both the inbound request (so Next can read the
 * nonce during SSR) and the outbound response (so the browser enforces
 * it). Used by every branch that returns HTML — main-host pages, docs
 * rewrites, and the dev-mode docs bypass.
 */
function attachCsp(
	request: NextRequest,
	target: { type: "next" } | { type: "rewrite"; url: URL },
	isDev: boolean,
): NextResponse {
	const { csp, nonce } = buildCsp(isDev);
	const requestHeaders = new Headers(request.headers);
	requestHeaders.set("x-nonce", nonce);
	requestHeaders.set("Content-Security-Policy", csp);

	const response =
		target.type === "rewrite"
			? NextResponse.rewrite(target.url, {
					request: { headers: requestHeaders },
				})
			: NextResponse.next({ request: { headers: requestHeaders } });
	response.headers.set("Content-Security-Policy", csp);
	return response;
}

export function proxy(request: NextRequest): NextResponse {
	const host = normalizeHost(request.headers.get("host"));
	const classified = classifyHost(host);
	const { pathname } = request.nextUrl;
	/* `nextUrl.pathname` is the router's view — the resolved page path.
	 * Next-internal requests against that page (data fetches, RSC payloads,
	 * route prefetches, server actions) all surface here as the underlying
	 * page path (e.g. `/` for the root page), not the URL the wire saw.
	 * `rawPathname` is the wire's view — the literal path the client sent.
	 *
	 * The docs branch needs the wire path to tell a real `GET /` apart
	 * from any normalized-to-`/` internal request, and to match `/_next/...`
	 * asset requests against the host allowlist. The two views must remain
	 * separate; collapsing them defeats the security-boundary contract for
	 * every Next-normalized URL class. */
	const rawPathname = new URL(request.url).pathname;
	const isDev = process.env.NODE_ENV === "development";

	/* ── 1. Hostname routing ─────────────────────────────────────────── */

	if (classified === HOSTNAMES.mcp) {
		/* The MCP host's externally-reachable surface is enumerated by
		 * `HOSTNAME_ALLOWLIST[HOSTNAMES.mcp]` — that array is the single
		 * source of truth. The matcher is exact-equality rather than
		 * prefix-equality (which `isPathAllowedOnHost` does for the
		 * other hosts) because `/mcp/foo` would match a `/mcp` prefix
		 * and fall through to a non-existent page, leaking past the
		 * security-boundary 404 contract. */
		if (pathname === "/mcp" || pathname === "/mcp/") {
			/* Both `/mcp` and `/mcp/` rewrite to the same internal target
			 * `/api/mcp` (no trailing slash) — Next's route handler lives
			 * at `app/api/mcp/route.ts`, so the canonical internal path
			 * is dash-free. Use `nextUrl.clone()` and mutate `pathname`
			 * so the search string (e.g. `?session=…`, `?code=…`) survives
			 * the rewrite — `new URL("/api/mcp", request.url)` would
			 * discard it. The MCP endpoint is JSON-RPC; return immediately
			 * so it never picks up CSP headers or the auth redirect. */
			const target = request.nextUrl.clone();
			target.pathname = "/api/mcp";
			return NextResponse.rewrite(target);
		}
		/* Remaining mcp-host allowlist entries (currently just the
		 * OAuth-protected-resource discovery doc) pass through to their
		 * page route untouched — exact match only, never prefix. */
		const mcpAllowed = HOSTNAME_ALLOWLIST[HOSTNAMES.mcp];
		if (mcpAllowed.some((p) => p !== "/mcp" && p === pathname)) {
			return NextResponse.next();
		}
		return notFound();
	}

	if (classified === HOSTNAMES.docs) {
		/* The docs host serves docs content at the subdomain root, so
		 * `docs.commcare.app/claude-code/commands` is the user-facing URL
		 * for the page that lives at the internal Next route
		 * `/docs/claude-code/commands`. The proxy rewrites every wire
		 * path to its `/docs/...` counterpart so the file-system route
		 * stays conventional while the URL bar stays clean. The wire
		 * path (`rawPathname`) is the matching key — see the `pathname`
		 * vs `rawPathname` note at the top of `proxy()`.
		 *
		 * Bypass paths (fumadocs search API, framework assets, favicon)
		 * sit on the docs allowlist. Any other `/api/*` 404s — no Nova
		 * APIs belong on this host. `/docs` and `/docs/<...>` on the
		 * wire also 404 because exposing the internal path externally
		 * would mean two URLs for the same page. */

		if (isPathAllowedOnHost(HOSTNAMES.docs, rawPathname)) {
			return NextResponse.next();
		}
		if (rawPathname === "/api" || rawPathname.startsWith("/api/")) {
			return notFound();
		}
		if (rawPathname === "/docs" || rawPathname.startsWith("/docs/")) {
			return notFound();
		}

		const target = request.nextUrl.clone();
		target.pathname = rawPathname === "/" ? "/docs" : `/docs${rawPathname}`;
		/* Docs pages ship as HTML, so they need the same nonce-based CSP
		 * as every other HTML response on the service. */
		return attachCsp(request, { type: "rewrite", url: target }, isDev);
	}

	if (classified === HOSTNAMES.main) {
		/* Off-allowlist on the main host 404s before CSP/auth ever runs;
		 * an off-allowlist path is by definition not a real route. */
		if (!isPathAllowedOnHost(HOSTNAMES.main, pathname)) {
			return notFound();
		}
		/* Fall through to the short-circuit + page handling below. */
	}

	/* Unknown classification (Cloud Run health checks on `*-uc.a.run.app`,
	 * dev `localhost:3000`, preview deployments, an empty/missing Host
	 * header) skips the allowlist gate but still flows through the API
	 * short-circuit and page handling. We do not want platform-level
	 * requests to 404, but we also do not want them to bypass auth.
	 *
	 * Dev affordance: when working locally without setting up the docs
	 * subdomain, let `/docs` paths render the docs without an auth
	 * redirect. Production never reaches this branch for `/docs` because
	 * the main host's allowlist excludes `/docs` (it is docs-host only). */
	if (isDev && (pathname === "/docs" || pathname.startsWith("/docs/"))) {
		/* Same HTML shape as the production docs response, so attach CSP
		 * here too — keeps dev preview faithful to prod headers. */
		return attachCsp(request, { type: "next" }, isDev);
	}

	/* ── 2. API + well-known short-circuit ───────────────────────────── */

	/* `/api` is checked exactly because `startsWith("/api/")` would miss
	 * a request to the bare `/api` path (which has no trailing slash).
	 * `/.well-known/*` rides the same short-circuit because discovery
	 * metadata is JSON, not a page — page-shaped CSP nonces and the
	 * auth redirect would both be wrong for it. */
	if (
		pathname === "/api" ||
		pathname.startsWith("/api/") ||
		pathname.startsWith("/.well-known/")
	) {
		return NextResponse.next();
	}

	/* ── 3. Pages: nonce-based CSP + optimistic auth ─────────────────── */

	/* Optimistic auth — cookie presence only, server does full validation.
	 * The root path is exempt so the unauthenticated landing page is
	 * reachable. `/.well-known/*` requests cannot reach this branch — the
	 * short-circuit above intercepts them. */
	if (pathname !== "/" && !getSessionCookie(request)) {
		return NextResponse.redirect(new URL("/", request.url));
	}

	return attachCsp(request, { type: "next" }, isDev);
}

export const config = {
	/* `_next/static`, `_next/image`, and `favicon.ico` are static assets
	 * that need none of the three concerns above (no hostname allowlist
	 * check, no CSP, no auth) — exclude them from the matcher to skip the
	 * proxy entirely. `/api` is intentionally NOT excluded so that the
	 * MCP host can intercept `/api/mcp` in step 1; the API short-circuit
	 * in step 2 handles the matched main-host API requests. */
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
