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

import { isValidIP, normalizeIP } from "@better-auth/core/utils/ip";
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import {
	classifyHost,
	HOSTNAMES,
	isPathAllowedExactOnHost,
	isPathAllowedOnHost,
	normalizeHost,
} from "@/lib/hostnames";

/**
 * Header name the proxy populates with the trusted client IP. Read by
 * `lib/auth-utils.ts::callerIpFromHeaders` and Better Auth's rate
 * limiter (`lib/auth.ts::ipAddressHeaders`). NOT a wire header — the
 * proxy strips any client-supplied value before deriving its own,
 * so anything reaching downstream code under this name is
 * guaranteed proxy-derived.
 */
const TRUSTED_CLIENT_IP_HEADER = "x-nova-client-ip";

/**
 * Number of XFF entries the proxy treats as trusted (counted from the
 * right). The deployment is Cloud Run with domain mappings — no
 * Application Load Balancer in front, no Cloud Armor — so the only
 * trusted hop is Google Front End's own appendage. Per Cloud
 * Functions / Cloud Run header documentation the GFE places the real
 * client IP in `X-Forwarded-For`; if a client supplied additional
 * values, GFE may preserve them on the left (the spoofable region).
 * Trim down to the rightmost entry to keep only what GFE wrote.
 *
 * If the deployment ever fronts the service with an external
 * Application Load Balancer, this constant moves to 2 — ALB appends
 * `<client-ip>, <lb-ip>` (per Google's load-balancer documentation),
 * making the rightmost two entries the trusted suffix. Anything
 * deeper (CDN, transparent proxy) shifts the count further. Update
 * here whenever the deployment topology changes; the comment is the
 * source of truth for "how many hops do we trust."
 */
const TRUSTED_XFF_HOPS = 1;

/**
 * Pull the trusted client IP from `X-Forwarded-For`. Takes the value
 * `TRUSTED_XFF_HOPS` positions from the right and validates it as a
 * real IP via Better Auth's `isValidIP`. Returns `null` when the
 * header is absent, malformed, or the chosen position is not a valid
 * IP — callers fall through to "no IP attribution available" rather
 * than guessing.
 *
 * The leftmost (untrusted) region of XFF is what makes the raw header
 * spoofable: a client can send any list it likes, and GFE preserves
 * those values before its own appendage. Taking the rightmost
 * trusted entry strips the spoofable prefix. Documented assumption:
 * the deployment trusts exactly `TRUSTED_XFF_HOPS` entries from the
 * right; see that constant's docblock.
 */
function deriveTrustedClientIp(xff: string | null): string | null {
	if (!xff) return null;
	const parts = xff
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;
	const candidate = parts[parts.length - TRUSTED_XFF_HOPS];
	if (!candidate || !isValidIP(candidate)) return null;
	return normalizeIP(candidate);
}

/**
 * Build a Headers object the rest of the proxy threads through every
 * downstream-bound `NextResponse`. Two responsibilities:
 *
 *   1. Strip any client-supplied `TRUSTED_CLIENT_IP_HEADER`. A request
 *      arriving with this header set by the client would forge IP
 *      attribution downstream — every reader treats this header as
 *      proxy-stamped, so a client setting it themselves bypasses the
 *      sanitization. Always delete first.
 *   2. Set the header to the proxy-derived trusted IP when XFF is
 *      present and parseable. When no trusted IP can be derived the
 *      header stays absent — readers handle that as "no attribution"
 *      (return `"unknown"` for audit logs, skip per-IP rate-limit
 *      attribution).
 */
function deriveProxyHeaders(request: NextRequest): Headers {
	const requestHeaders = new Headers(request.headers);
	requestHeaders.delete(TRUSTED_CLIENT_IP_HEADER);
	const trustedIp = deriveTrustedClientIp(
		request.headers.get("x-forwarded-for"),
	);
	if (trustedIp) {
		requestHeaders.set(TRUSTED_CLIENT_IP_HEADER, trustedIp);
	}
	return requestHeaders;
}

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
function buildCsp(
	isDev: boolean,
	allowGoogleMaps: boolean,
): { csp: string; nonce: string } {
	/* 16 raw random bytes encoded as base64. `randomUUID()` would yield
	 * an ASCII string with structurally fixed dashes and version nibbles —
	 * base64-encoding that wastes entropy the CSP nonce relies on to
	 * resist guessing. */
	const nonceBytes = new Uint8Array(16);
	crypto.getRandomValues(nonceBytes);
	const nonce = Buffer.from(nonceBytes).toString("base64");

	/* The GPS location picker (in the builder) loads the Google Maps JS API,
	 * which REQUIRES `'unsafe-eval'` and fetches map tiles, Places, Geocoding,
	 * fonts, and frames from Google hosts. CSP is fixed per DOCUMENT, and the
	 * main host is one App-Router SPA: a document first loaded at `/` (or any
	 * page) can client-navigate into `/build`, where Maps then loads under
	 * that original document's policy. So the relaxation must cover every
	 * main-host page document, not just `/build` — `allowGoogleMaps` is true
	 * for all main-host pages and false for the separate docs subdomain (which
	 * never reaches the builder), keeping docs strict. Under `'strict-dynamic'`
	 * the Maps loader script is trusted transitively from the bundled code, so
	 * no script HOST needs allow-listing — only `'unsafe-eval'`. */
	const gmapsHosts =
		"https://*.googleapis.com https://*.gstatic.com https://*.google.com";
	const gImg = allowGoogleMaps ? ` ${gmapsHosts}` : "";
	const gConnect = allowGoogleMaps ? ` ${gmapsHosts}` : "";
	const gFont = allowGoogleMaps ? " https://fonts.gstatic.com" : "";
	const gStyle = allowGoogleMaps ? " https://fonts.googleapis.com" : "";

	const csp = [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev || allowGoogleMaps ? " 'unsafe-eval'" : ""}`,
		`style-src 'self' 'unsafe-inline'${gStyle}`,
		`img-src 'self' blob: data: *.googleusercontent.com${gImg}`,
		`font-src 'self'${gFont}`,
		/* Sentry Session Replay compresses its payload in a Web Worker created
		 * from a blob: URL; without an explicit worker-src the directive falls
		 * back to default-src 'self', which blocks blob: workers. */
		"worker-src 'self' blob:",
		/* A media upload PUTs its bytes straight to a V4 signed GCS URL from the
		 * browser — a cross-origin request the default `'self'` would block. Reads
		 * stay same-origin (the `/api/media/[assetId]` route proxies them), so only
		 * the upload PUT needs this. In local dev the upload target is the
		 * same-origin `/api/media/upload/dev-put` route, so it only matters in
		 * prod. The Google hosts (main-host pages) carry the Maps tile,
		 * Places, and Geocoding XHRs. */
		`connect-src 'self' https://storage.googleapis.com${gConnect}`,
		/* Google Maps embeds a few same-purpose iframes (main-host pages). */
		...(allowGoogleMaps ? ["frame-src https://*.google.com"] : []),
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
	requestHeaders: Headers,
	target: { type: "next" } | { type: "rewrite"; url: URL },
	isDev: boolean,
	allowGoogleMaps = false,
): NextResponse {
	const { csp, nonce } = buildCsp(isDev, allowGoogleMaps);
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
	/* Build the sanitized request-header set ONCE at the top — every
	 * downstream `NextResponse.next/rewrite` threads this through via
	 * `{ request: { headers: requestHeaders } }` so the
	 * `TRUSTED_CLIENT_IP_HEADER` is set (or absent) consistently for
	 * route handlers, server components, and the auth router. Without
	 * threading via the response option, Next does NOT propagate
	 * mutations on `request.headers` to downstream handlers. */
	const requestHeaders = deriveProxyHeaders(request);
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
		/* The MCP host uses exact-match (`isPathAllowedExactOnHost`)
		 * rather than the prefix matcher used elsewhere: `/mcp/foo`
		 * would match a `/mcp` prefix and fall through to a non-existent
		 * page, leaking past the security-boundary 404 contract. */
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
			return NextResponse.rewrite(target, {
				request: { headers: requestHeaders },
			});
		}
		if (isPathAllowedExactOnHost(HOSTNAMES.mcp, pathname)) {
			return NextResponse.next({ request: { headers: requestHeaders } });
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
			return NextResponse.next({ request: { headers: requestHeaders } });
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
		return attachCsp(requestHeaders, { type: "rewrite", url: target }, isDev);
	}

	if (classified === HOSTNAMES.main) {
		/* Off-allowlist on the main host 404s before CSP/auth ever runs;
		 * an off-allowlist path is by definition not a real route. */
		if (!isPathAllowedOnHost(HOSTNAMES.main, pathname)) {
			return notFound();
		}
		/* MCP is mounted as a Better Auth plugin endpoint at
		 * `/api/auth/mcp` (so it inherits the auth router's
		 * `onRequestRateLimit` middleware). The main host's allowlist
		 * admits `/api/auth` as a prefix — needed for sign-in,
		 * session, OAuth-provider endpoints — which would otherwise
		 * also admit `/api/auth/mcp`, giving clients a back-door
		 * route to MCP that bypasses the intended `mcp.commcare.app/mcp`
		 * host boundary. Deny it explicitly. The plugin endpoint
		 * stays reachable on its sanctioned path: `mcp.commcare.app/mcp`
		 * rewrites internally to `/api/mcp`, the route shim
		 * synthesizes `/api/auth/mcp` with the original wire host
		 * preserved on the request, and Better Auth's router
		 * dispatches it to the plugin endpoint. */
		if (pathname === "/api/auth/mcp" || pathname === "/api/auth/mcp/") {
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
		return attachCsp(requestHeaders, { type: "next" }, isDev);
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
		return NextResponse.next({ request: { headers: requestHeaders } });
	}

	/* ── 3. Pages: nonce-based CSP + optimistic auth ─────────────────── */

	/* Cloud Run's startup probe targets `/warmup` so a new instance loads
	 * the heavy page-module graph BEFORE it is marked ready for traffic.
	 * The probe arrives with the instance's own Host header — never a
	 * custom domain — so it lands in the unknown-host fall-through with
	 * no session cookie. It must bypass the auth redirect below: probes
	 * count a 307 as success, which would mark the instance ready without
	 * warming anything. This is not a public surface — on the custom
	 * domains the hostname allowlist 404s `/warmup` before this runs. */
	if (pathname === "/warmup") {
		return attachCsp(requestHeaders, { type: "next" }, isDev);
	}

	/* Optimistic auth — cookie presence only, server does full validation.
	 * The root path is exempt so the unauthenticated landing page is
	 * reachable. `/.well-known/*` requests cannot reach this branch — the
	 * short-circuit above intercepts them. */
	if (pathname !== "/" && !getSessionCookie(request)) {
		return NextResponse.redirect(new URL("/", request.url));
	}

	/* Every main-host page document gets the Google-Maps-relaxed CSP: this is
	 * one App-Router SPA, so any page can client-navigate into the builder
	 * where the GPS picker's Google Map loads under the original document's
	 * policy. (The docs subdomain — handled in its own branch above — stays
	 * strict; it never reaches the builder.) */
	return attachCsp(requestHeaders, { type: "next" }, isDev, true);
}

export const config = {
	/* `_next/static`, `_next/image`, `favicon.ico`, and `nova-icons` (the
	 * shipped built-in menu-tile icon set under `public/nova-icons/`) are
	 * static assets that need none of the three concerns above (no hostname
	 * allowlist check, no CSP, no auth) — exclude them from the matcher to
	 * skip the proxy entirely. Without excluding `nova-icons`, the optimistic
	 * auth redirect 307s every `<img src="/nova-icons/…">` and, on the main
	 * host, the off-allowlist guard 404s it (localhost's unknown-host branch
	 * skips the allowlist, masking the prod 404). They're non-sensitive
	 * (MIT Tabler-derived glyphs), so serving them unauthenticated +
	 * CDN-cacheable like the other static assets is correct. `/api` is
	 * intentionally NOT excluded so that the MCP host can intercept
	 * `/api/mcp` in step 1; the API short-circuit in step 2 handles the
	 * matched main-host API requests. */
	matcher: ["/((?!_next/static|_next/image|favicon.ico|nova-icons/).*)"],
};
