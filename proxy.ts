/**
 * Next.js 16 proxy — hostname routing + CSP + optimistic auth redirect.
 *
 * The "proxy" file convention replaces `middleware.ts` in Next.js 16 (the
 * runtime is Node.js and cannot be configured). A single proxy file is the
 * one place every request flows through before it reaches a route handler
 * or page, so this file owns three independent concerns layered in order:
 *
 *   1. **Hostname routing.** A single Cloud Run service serves three
 *      virtual hosts (`commcare.app`, `mcp.commcare.app`,
 *      `docs.commcare.app`). Per-host path allowlists in `lib/hostnames.ts`
 *      enforce that the MCP subdomain only exposes MCP routes, the docs
 *      subdomain only exposes docs, and everything off-allowlist 404s with
 *      `Cache-Control: no-store` so the security boundary can't be cached.
 *      The MCP subdomain rewrites `/mcp` → `/api/mcp` so the externally
 *      visible URL stays clean while the file-system route lives at the
 *      Next conventional path.
 *
 *   2. **API short-circuit.** Once routing has decided this is a main-host
 *      request, `/api/*` paths skip CSP + auth entirely — those concerns
 *      apply to pages, not JSON endpoints. The matcher had to widen to
 *      include `/api` so the MCP host could intercept `/api/mcp`; this
 *      short-circuit is what keeps the widened matcher from breaking the
 *      main host's API surface.
 *
 *   3. **Pages: nonce-based CSP + optimistic auth.** Every page request
 *      gets a per-request nonce on `Content-Security-Policy` (response)
 *      and `x-nonce` (request, for RSC). Unauthenticated requests on
 *      protected pages are redirected to `/`. We only redirect TO `/`,
 *      never FROM it — the landing page does the reverse with full session
 *      validation, so a stale cookie can't loop. `/.well-known/*` is
 *      exempt from the auth redirect: those endpoints are OAuth/OIDC
 *      discovery metadata and must be reachable unauthenticated, otherwise
 *      OAuth clients cannot bootstrap.
 */

import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import {
	classifyHost,
	HOSTNAMES,
	isPathAllowedOnHost,
	normalizeHost,
} from "@/lib/hostnames";

/**
 * Build a 404 with `Cache-Control: no-store` and a plain-text body. Off-
 * allowlist requests share this response so the hostname security boundary
 * cannot be cached by an intermediate (CDN, browser disk cache) and then
 * served back as a positive answer if the allowlist later changes.
 */
function notFound(): NextResponse {
	return new NextResponse("Not Found", {
		status: 404,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

export function proxy(request: NextRequest): NextResponse {
	const host = normalizeHost(request.headers.get("host"));
	const classified = classifyHost(host);
	const { pathname } = request.nextUrl;

	/* ── 1. Hostname routing ─────────────────────────────────────────── */

	if (classified === HOSTNAMES.mcp) {
		/* External `/mcp` rewrites to internal `/api/mcp`. Use
		 * `nextUrl.clone()` and mutate `pathname` so the search string
		 * (e.g. `?session=…`, `?code=…`) survives the rewrite — the
		 * `new URL("/api/mcp", request.url)` form would discard it. The
		 * MCP endpoint is JSON-RPC; return immediately so it never picks
		 * up CSP headers or the auth redirect. */
		if (pathname === "/mcp") {
			const target = request.nextUrl.clone();
			target.pathname = "/api/mcp";
			return NextResponse.rewrite(target);
		}
		/* OAuth-protected-resource metadata is the only other allowlist
		 * entry on this host; pass it through with no CSP / auth. */
		if (isPathAllowedOnHost(HOSTNAMES.mcp, pathname)) {
			return NextResponse.next();
		}
		return notFound();
	}

	if (classified === HOSTNAMES.docs) {
		if (isPathAllowedOnHost(HOSTNAMES.docs, pathname)) {
			return NextResponse.next();
		}
		return notFound();
	}

	if (classified === HOSTNAMES.main) {
		/* Off-allowlist on the main host 404s before CSP/auth ever runs;
		 * an off-allowlist path is by definition not a real route. */
		if (!isPathAllowedOnHost(HOSTNAMES.main, pathname)) {
			return notFound();
		}
		/* Fall through to CSP + auth below. */
	}

	/* Unknown classification (Cloud Run health checks on `*-uc.a.run.app`,
	 * dev `localhost:3000`, preview deployments) skips the allowlist gate
	 * but still gets the CSP + auth treatment. We don't want platform-
	 * level requests to 404, but we also don't want them to bypass auth. */

	/* ── 2. API short-circuit (main host + unknown hosts) ────────────── */

	/* The matcher widened to include `/api/*` so MCP-host `/api/mcp`
	 * could be intercepted above. CSP + auth do not apply to API routes —
	 * they would set CSP headers on JSON responses (harmless but wrong)
	 * and redirect unauthenticated API calls to `/` as HTML (which would
	 * silently break every API client). */
	if (pathname.startsWith("/api/")) {
		return NextResponse.next();
	}

	/* ── 3. Pages: nonce-based CSP + optimistic auth ─────────────────── */

	const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
	const isDev = process.env.NODE_ENV === "development";

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

	/* Optimistic auth — cookie presence only, server does full validation.
	 * `/.well-known/*` is exempt because it serves OAuth / OIDC discovery
	 * metadata that unauthenticated clients MUST be able to read; a
	 * redirect would break OAuth bootstrapping. The root path is exempt
	 * so the unauthenticated landing page is reachable. */
	const isWellKnown = pathname.startsWith("/.well-known/");
	if (pathname !== "/" && !isWellKnown && !getSessionCookie(request)) {
		return NextResponse.redirect(new URL("/", request.url));
	}

	/* Pass nonce to RSC via request header; set CSP on the response. */
	const requestHeaders = new Headers(request.headers);
	requestHeaders.set("x-nonce", nonce);
	requestHeaders.set("Content-Security-Policy", csp);

	const response = NextResponse.next({ request: { headers: requestHeaders } });
	response.headers.set("Content-Security-Policy", csp);

	return response;
}

export const config = {
	/* The matcher includes `/api` so the MCP host can intercept `/api/mcp`
	 * above. Without `/api` in the matcher, the MCP-host `/mcp` rewrite
	 * could not target it. The main-host `/api/*` short-circuit (step 2
	 * above) keeps CSP + auth from running on API routes that would
	 * previously have been excluded by the matcher entirely. */
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
