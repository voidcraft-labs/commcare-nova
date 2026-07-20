/**
 * Tests for the Next.js 16 proxy. The proxy layers three concerns:
 *
 *   1. hostname routing (per-host path allowlists, MCP /mcp → /api/mcp rewrite, off-allowlist 404s),
 *   2. /api/* + /.well-known/* short-circuit (no CSP, no auth redirect on JSON / discovery routes),
 *   3. page handling (CSP nonce + optimistic auth redirect).
 *
 * Every assertion is affirmative: 404 responses are checked for the no-store
 * Cache-Control header (so a security boundary can't be silently cached);
 * rewrites are checked for `x-middleware-rewrite` containing the internal
 * target plus any expected query string; passthroughs are checked for the
 * absence of both, and — where the branch is supposed to bypass page
 * machinery — for the absence of CSP / x-nonce headers.
 *
 * `NextResponse.rewrite` encodes the destination on the response in the
 * `x-middleware-rewrite` header — that's the contract Next inspects when it
 * routes the rewritten request internally, so it's the authoritative signal
 * that a rewrite happened.
 */

import { NextRequest, type NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "../proxy";

/**
 * Build a `NextRequest` with the wire `Host` header set explicitly. The
 * URL gets a placeholder origin (`example.test`) because the proxy reads
 * the Host header — not the URL host — exactly the way Next will deliver
 * it in production behind Cloud Run's load balancer.
 */
function req(host: string, path: string): NextRequest {
	const url = new URL(`http://example.test${path}`);
	return new NextRequest(url, { headers: { host } });
}

/**
 * Build a `NextRequest` carrying a Better-Auth-shaped session cookie. The
 * proxy's `getSessionCookie` only checks for cookie *presence* (full
 * validation lives on the server), so a fake value is sufficient to drive
 * the authenticated-page branch and exercise CSP assembly.
 *
 * The cookie name `better-auth.session_token` is Better Auth's runtime
 * default (`<cookiePrefix>.<cookieName>`); its getter accepts both the
 * unprefixed and `__Secure-`-prefixed variants, so this form works in
 * tests regardless of `NODE_ENV`. If a Better Auth upgrade renames the
 * default cookie, this literal must move in lockstep — the regression is
 * loud (the auth-redirect branch fires and the CSP-attach test below
 * stops finding a CSP header) but the fix is here.
 */
function reqWithSession(host: string, path: string): NextRequest {
	const url = new URL(`http://example.test${path}`);
	return new NextRequest(url, {
		headers: {
			host,
			cookie: "better-auth.session_token=fake-cookie-presence-only",
		},
	});
}

/**
 * Assert that a response is a passthrough: not a 404, and no rewrite
 * header. Use `expectBypassPassthrough` for branches that must also skip
 * CSP / nonce assembly.
 */
function expectPassthrough(res: NextResponse): void {
	expect(res.status).not.toBe(404);
	expect(res.headers.get("x-middleware-rewrite")).toBeNull();
}

/**
 * Assert a passthrough that explicitly bypasses the page-handling branch:
 * no rewrite, no 404, and no CSP / x-nonce headers attached. Used for the
 * mcp / docs allowlist passes and the /api/* and /.well-known/* short-
 * circuits — branches whose contract is "Next sees this exactly as the
 * client sent it".
 */
function expectBypassPassthrough(res: NextResponse): void {
	expectPassthrough(res);
	expect(res.headers.get("content-security-policy")).toBeNull();
	expect(res.headers.get("x-nonce")).toBeNull();
}

/**
 * Assert that a response is a rewrite to `target`. The check uses
 * `toContain` because Next stores the rewrite as a fully-qualified URL,
 * and we don't want to encode the test request's origin into the
 * expectation.
 */
function expectRewrite(res: NextResponse, target: string): void {
	expect(res.status).not.toBe(404);
	const rewrite = res.headers.get("x-middleware-rewrite");
	expect(rewrite).not.toBeNull();
	expect(rewrite).toContain(target);
}

/**
 * Assert that a response is the canonical 404: status 404 plus
 * `Cache-Control: no-store`. The header is the security-relevant part —
 * the hostname allowlist is a security boundary and a cached "yes" from
 * an earlier permissive state would defeat the gate.
 */
function expectNotFound(res: NextResponse): void {
	expect(res.status).toBe(404);
	expect(res.headers.get("cache-control")).toBe("no-store");
}

/**
 * Assert that a response is an auth redirect to `/`. The proxy uses
 * `NextResponse.redirect`, which sets HTTP 307 and a `Location` header.
 */
function expectAuthRedirect(res: NextResponse): void {
	expect(res.status).toBe(307);
	const location = res.headers.get("location");
	expect(location).not.toBeNull();
	/* Location is absolute; we only assert the path component. */
	expect(new URL(location ?? "", "http://example.test").pathname).toBe("/");
}

/**
 * Parse a CSP string into a directive→value map so Maps-relaxation
 * assertions read against whole directives (e.g. `img-src`) instead of
 * brittle substring matches across the joined policy. Splitting on `;`
 * mirrors how the proxy assembles it (`.join("; ")`).
 */
function directives(csp: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const part of csp
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean)) {
		const sp = part.indexOf(" ");
		if (sp === -1) map.set(part, "");
		else map.set(part.slice(0, sp), part.slice(sp + 1));
	}
	return map;
}

describe("proxy: mcp.commcare.app routing", () => {
	it("rewrites /mcp → /api/mcp", () => {
		const res = proxy(req("mcp.commcare.app", "/mcp"));
		expectRewrite(res, "/api/mcp");
	});

	it("rewrites /mcp/ (trailing slash) → /api/mcp", () => {
		/* Trailing-slash variants of the canonical MCP path are treated
		 * identically — the route surface is exactly two paths. */
		const res = proxy(req("mcp.commcare.app", "/mcp/"));
		expectRewrite(res, "/api/mcp");
	});

	it("preserves the query string when rewriting /mcp", () => {
		const res = proxy(req("mcp.commcare.app", "/mcp?session=abc&foo=bar"));
		expectRewrite(res, "/api/mcp");
		const rewrite = res.headers.get("x-middleware-rewrite") ?? "";
		expect(rewrite).toContain("session=abc");
		expect(rewrite).toContain("foo=bar");
	});

	it("preserves the query string when rewriting /mcp/ (trailing slash)", () => {
		/* Both `/mcp` and `/mcp/` normalize to the same internal target;
		 * verify the trailing-slash variant does not regress query
		 * preservation independently of the bare-path variant. */
		const res = proxy(req("mcp.commcare.app", "/mcp/?session=abc"));
		expectRewrite(res, "/api/mcp");
		expect(res.headers.get("x-middleware-rewrite") ?? "").toContain(
			"session=abc",
		);
	});

	it("404s /mcp/foo (subpath; allowlist-prefix matching would let this leak)", () => {
		/* `isPathAllowedOnHost(HOSTNAMES.mcp, "/mcp/foo")` returns true
		 * because the allowlist matcher is segment-anchored and `/mcp` is
		 * a prefix. The mcp branch deliberately bypasses the helper and
		 * lists routes inline so this does not leak. */
		const res = proxy(req("mcp.commcare.app", "/mcp/foo"));
		expectNotFound(res);
	});

	it("404s the internal /api/mcp path (not externally reachable)", () => {
		const res = proxy(req("mcp.commcare.app", "/api/mcp"));
		expectNotFound(res);
	});

	it("passes through /.well-known/oauth-protected-resource (OAuth discovery, no CSP)", () => {
		const res = proxy(
			req("mcp.commcare.app", "/.well-known/oauth-protected-resource"),
		);
		expectBypassPassthrough(res);
	});

	it("passes through path-inserted protected-resource metadata for /mcp", () => {
		const res = proxy(
			req("mcp.commcare.app", "/.well-known/oauth-protected-resource/mcp"),
		);
		expectBypassPassthrough(res);
	});

	it("404s /admin (not in MCP allowlist)", () => {
		const res = proxy(req("mcp.commcare.app", "/admin"));
		expectNotFound(res);
	});

	it("404s /.well-known/oauth-authorization-server (AS metadata belongs to main host)", () => {
		const res = proxy(
			req("mcp.commcare.app", "/.well-known/oauth-authorization-server"),
		);
		expectNotFound(res);
	});

	it("normalizes a trailing-dot host", () => {
		const res = proxy(req("mcp.commcare.app.", "/mcp"));
		expectRewrite(res, "/api/mcp");
	});

	it("normalizes an explicit :443 port", () => {
		const res = proxy(req("mcp.commcare.app:443", "/mcp"));
		expectRewrite(res, "/api/mcp");
	});
});

describe("proxy: docs.commcare.app routing", () => {
	it("rewrites the bare root to the internal /docs route", () => {
		const res = proxy(req("docs.commcare.app", "/"));
		expectRewrite(res, "/docs");
	});

	it("rewrites a section path to its /docs/<section> internal target", () => {
		const res = proxy(req("docs.commcare.app", "/claude-code"));
		expectRewrite(res, "/docs/claude-code");
	});

	it("rewrites a deep section page to its /docs/<section>/<page> target", () => {
		const res = proxy(req("docs.commcare.app", "/claude-code/commands"));
		expectRewrite(res, "/docs/claude-code/commands");
	});

	it("passes through the docs search API", () => {
		const res = proxy(req("docs.commcare.app", "/api/search"));
		expectBypassPassthrough(res);
	});

	it("passes through /_next/* asset paths", () => {
		/* The matcher excludes `/_next/static` and `/_next/image`, but
		 * other `/_next` paths still hit the proxy and need to fall
		 * within the docs allowlist. */
		const res = proxy(req("docs.commcare.app", "/_next/data/foo.json"));
		expectPassthrough(res);
	});

	it("404s /api/chat (not in docs allowlist)", () => {
		const res = proxy(req("docs.commcare.app", "/api/chat"));
		expectNotFound(res);
	});

	it("404s direct /docs access from the wire (internal-only path)", () => {
		/* `/docs` is the internal Next route. Externally the docs site
		 * lives at the root, so a request that names the internal path
		 * directly would shadow the public URL with a duplicate. Block
		 * it so each page has exactly one canonical URL. */
		const res = proxy(req("docs.commcare.app", "/docs"));
		expectNotFound(res);
	});

	it("404s nested /docs/<...> access from the wire", () => {
		const res = proxy(req("docs.commcare.app", "/docs/claude-code"));
		expectNotFound(res);
	});
});

describe("proxy: commcare.app (main) routing", () => {
	it("passes through /.well-known/oauth-authorization-server (short-circuit, no CSP)", () => {
		/* The /.well-known/* short-circuit is critical: an OAuth client
		 * must be able to read AS metadata before it has a session, and
		 * the document is JSON — no page-shaped CSP nonce should attach. */
		const res = proxy(
			req("commcare.app", "/.well-known/oauth-authorization-server"),
		);
		expectBypassPassthrough(res);
	});

	it("404s /api/mcp on the main host (MCP belongs to its own subdomain)", () => {
		const res = proxy(req("commcare.app", "/api/mcp"));
		expectNotFound(res);
	});

	it("redirects unauthenticated /admin to / (CSP+auth path)", () => {
		/* /admin is on the main allowlist, so it passes the hostname
		 * gate; it isn't /api/* or /.well-known/*, so the short-circuit
		 * doesn't apply; it has no session cookie, so the auth-redirect
		 * branch fires. */
		const res = proxy(req("commcare.app", "/admin"));
		expectAuthRedirect(res);
	});

	it("attaches CSP + x-nonce on allowlisted page requests with a session cookie", () => {
		/* Authenticated, allowlisted, non-API, non-well-known path —
		 * exercises the entire CSP construction block. The `x-nonce`
		 * request header is forwarded to RSC so the layout can echo the
		 * nonce onto inline <script> tags; we assert it was set on the
		 * outgoing request via `request.headers`. */
		const res = proxy(reqWithSession("commcare.app", "/build"));
		expect(res.status).not.toBe(404);
		expect(res.status).not.toBe(307);
		const csp = res.headers.get("content-security-policy");
		expect(csp).not.toBeNull();
		/* The CSP must include a nonce-bearing script-src directive. */
		expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);
	});

	it("forwards CSP and x-nonce on the request so Next.js can auto-nonce framework scripts", () => {
		/* Load-bearing regression test for SSR framework-script nonce
		 * propagation. `NextResponse.next({ request: { headers } })`
		 * communicates the new request headers to the runtime via two
		 * channels:
		 *
		 *   - `x-middleware-override-headers`: a comma-joined list of
		 *     header names (lowercase) that the runtime should overwrite.
		 *   - `x-middleware-request-<name>`: per-header values keyed by
		 *     lowercase header name.
		 *
		 * Without `Content-Security-Policy` on the request, Next.js
		 * cannot extract the nonce during SSR, `'strict-dynamic'` blocks
		 * every `_next/static/*` framework bundle, and the page renders
		 * blank. The `x-nonce` half is asserted in lockstep so a future
		 * edit cannot drop the nonce while leaving CSP intact (or vice
		 * versa) without the test going red. */
		const res = proxy(reqWithSession("commcare.app", "/build"));
		const overrides = res.headers.get("x-middleware-override-headers") ?? "";
		const overrideNames = overrides.toLowerCase().split(",");
		expect(overrideNames).toContain("content-security-policy");
		expect(overrideNames).toContain("x-nonce");
		/* And the per-header values landed where the runtime will look. */
		const forwardedCsp = res.headers.get(
			"x-middleware-request-content-security-policy",
		);
		expect(forwardedCsp).toMatch(/script-src[^;]*'nonce-[^']+'/);
		expect(res.headers.get("x-middleware-request-x-nonce")).not.toBeNull();
	});

	it("passes through /api/chat (short-circuit, no CSP)", () => {
		const res = proxy(req("commcare.app", "/api/chat"));
		expectBypassPassthrough(res);
	});

	it("passes through /api/media/library (regression: was 404'd off-allowlist)", () => {
		/* The media routes are on the main allowlist, so they reach the
		 * API short-circuit instead of the off-allowlist 404. Direct guard
		 * against the prod regression where every `/api/media/*` request
		 * 404'd before reaching its handler. */
		const res = proxy(req("commcare.app", "/api/media/library"));
		expectBypassPassthrough(res);
	});

	it("passes through /api/auth/sign-in (short-circuit, no CSP, no auth redirect)", () => {
		/* Better Auth's own endpoints must not be redirected to / when
		 * the user is unauthenticated — that would loop sign-in itself. */
		const res = proxy(req("commcare.app", "/api/auth/sign-in"));
		expectBypassPassthrough(res);
		expect(res.status).not.toBe(307);
	});
});

/**
 * The geopoint GPS picker loads the Google Maps JS API, which needs CSP
 * relaxations (`'unsafe-eval'` + Google hosts on img/connect/frame/font/
 * style). CSP is fixed per DOCUMENT and the main host is one App-Router SPA,
 * so the relaxation rides EVERY main-host page — a document first loaded at
 * `/` can client-navigate into `/build` where Maps then loads under that
 * original document's policy. These specs pin both halves of that contract:
 * every main-host page (including the unauthenticated landing `/`) carries the
 * relaxation, and the separate docs host — which never reaches the builder —
 * stays strict. NODE_ENV is `test` here (so `isDev` is false), matching the
 * production posture where `'unsafe-eval'` appears ONLY via the Maps opt-in.
 */
describe("proxy: Google Maps CSP relaxation", () => {
	it("relaxes CSP for the Maps JS API on an authenticated main-host page", () => {
		const res = proxy(reqWithSession("commcare.app", "/build"));
		const csp = res.headers.get("content-security-policy");
		expect(csp).not.toBeNull();
		const d = directives(csp ?? "");
		expect(d.get("script-src")).toContain("'unsafe-eval'");
		expect(d.get("img-src")).toContain("https://*.googleapis.com");
		expect(d.get("connect-src")).toContain("https://*.googleapis.com");
		expect(d.get("style-src")).toContain("https://fonts.googleapis.com");
		expect(d.get("font-src")).toContain("https://fonts.gstatic.com");
		expect(d.get("frame-src")).toBe("https://*.google.com");
	});

	it("relaxes CSP on the unauthenticated landing page too (SPA can client-nav into the builder)", () => {
		/* The landing page intentionally is NOT kept strict: `/` is one
		 * route of the main-host SPA and links into `/build`, where Maps
		 * would otherwise load under `/`'s policy and be blocked. Root is
		 * auth-exempt, so no session cookie is needed to reach page handling. */
		const res = proxy(req("commcare.app", "/"));
		const csp = res.headers.get("content-security-policy");
		expect(csp).not.toBeNull();
		const d = directives(csp ?? "");
		expect(d.get("script-src")).toContain("'unsafe-eval'");
		expect(d.get("img-src")).toContain("https://*.googleapis.com");
		expect(d.has("frame-src")).toBe(true);
	});

	it("keeps the docs host strict — no Maps relaxation leaks onto it", () => {
		/* Docs rewrites carry CSP on the response (HTML, same as any page),
		 * but with `allowGoogleMaps` false. `storage.googleapis.com` stays in
		 * connect-src (media uploads, unrelated), so assert against the Maps-
		 * specific tokens — wildcard host, fonts hosts, frame-src, unsafe-eval. */
		const res = proxy(req("docs.commcare.app", "/"));
		const csp = res.headers.get("content-security-policy");
		expect(csp).not.toBeNull();
		const d = directives(csp ?? "");
		expect(d.get("script-src")).not.toContain("'unsafe-eval'");
		expect(d.get("img-src")).not.toContain("googleapis.com");
		expect(d.get("connect-src")).not.toContain("https://*.googleapis.com");
		expect(d.get("style-src")).not.toContain("fonts.googleapis.com");
		expect(d.get("font-src")).toBe("'self'");
		expect(d.has("frame-src")).toBe(false);
	});
});

describe("proxy: unknown hosts (Cloud Run health checks, dev localhost, missing Host)", () => {
	it("passes /api/* through without auth redirect", () => {
		/* Unknown classification skips the allowlist entirely but still
		 * runs through the API short-circuit. The previous round of
		 * tests asserted "not 404"; we additionally assert no auth
		 * redirect, since redirecting Cloud Run's health probe to / would
		 * mark the instance unhealthy. */
		const res = proxy(req("nova-abc-uc.a.run.app", "/api/chat"));
		expectBypassPassthrough(res);
		expect(res.status).not.toBe(307);
	});

	it("treats an empty Host header as unknown and runs page handling", () => {
		/* `normalizeHost("")` → `""`, `classifyHost("")` → `null`. The
		 * request falls through hostname routing into page handling;
		 * /build is not on the short-circuit, has no session cookie, so
		 * it must land at the auth redirect — proving page-route
		 * treatment, not a 404. */
		const res = proxy(req("", "/build"));
		expectAuthRedirect(res);
	});

	it("renders /warmup for the startup probe — no auth redirect, CSP attached", () => {
		/* The startup probe carries the instance's own Host and no session
		 * cookie. A 307 here would count as probe success WITHOUT loading
		 * the page graph — the whole point of the probe — so /warmup must
		 * skip the auth redirect and take the normal page path. */
		const res = proxy(req("nova-abc-uc.a.run.app", "/warmup"));
		expectPassthrough(res);
		expect(res.status).not.toBe(307);
		expect(res.headers.get("content-security-policy")).not.toBeNull();
	});
});

describe("proxy: /warmup stays probe-only on the custom domains", () => {
	it.each(["commcare.app", "mcp.commcare.app"])(
		"404s /warmup on %s (hostname allowlist)",
		(host) => {
			expectNotFound(proxy(req(host, "/warmup")));
		},
	);

	it("rewrites /warmup on docs.commcare.app into docs space like any unknown docs path", () => {
		/* The docs host never proxy-404s: every off-allowlist path rewrites
		 * to `/docs/<path>` and fumadocs' own not-found page answers. The
		 * warmup page is unreachable through it either way. */
		expectRewrite(proxy(req("docs.commcare.app", "/warmup")), "/docs/warmup");
	});
});

/**
 * The dev-mode internal-page bypasses on unknown hosts depend on `NODE_ENV`.
 * The test framework runs with `NODE_ENV === "test"`, so without `vi.stubEnv`
 * those branches are silently unreachable from the other tests — and a future
 * inverted environment check would not show up in CI. The specs below pin both
 * halves of the gate: development grants passthrough, production redirects.
 *
 * The bypass is needed locally because `localhost:3000` doesn't classify
 * as the docs hostname, so the docs-host rewrite branch never fires; the
 * affordance lets a developer preview docs by visiting the internal
 * `/docs/<...>` route directly without setting up `docs.commcare.app`
 * against their loopback.
 */
describe("proxy: dev-mode internal-page bypasses on unknown hosts", () => {
	beforeEach(() => {
		vi.stubEnv("NODE_ENV", "development");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("passes /docs through without auth on localhost", () => {
		const res = proxy(req("localhost:3000", "/docs"));
		expect(res.status).not.toBe(404);
		expect(res.status).not.toBe(307);
		expect(res.headers.get("x-middleware-rewrite")).toBeNull();
	});

	it("passes nested /docs/<section>/<page> through without auth on localhost", () => {
		const res = proxy(req("localhost:3000", "/docs/claude-code/commands"));
		expect(res.status).not.toBe(404);
		expect(res.status).not.toBe(307);
		expect(res.headers.get("x-middleware-rewrite")).toBeNull();
	});

	it("passes the progress preview through with CSP on localhost", () => {
		const res = proxy(req("localhost:3000", "/progress-test"));
		expectPassthrough(res);
		expect(res.status).not.toBe(307);
		expect(res.headers.get("content-security-policy")).not.toBeNull();
	});
});

describe("proxy: dev-mode internal-page bypasses do NOT fire in production", () => {
	beforeEach(() => {
		vi.stubEnv("NODE_ENV", "production");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("redirects unauthenticated /docs to / on an unknown host in prod", () => {
		/* Belt-and-suspenders for the security boundary: even on an unknown
		 * host (e.g. Cloud Run's internal `*-uc.a.run.app` probe address),
		 * unauthenticated `/docs` MUST land at the auth redirect in prod —
		 * not pass through. If this test breaks because the bypass fired,
		 * the dev-only condition has regressed and is now leaking into
		 * production. */
		const res = proxy(req("nova-abc-uc.a.run.app", "/docs"));
		expectAuthRedirect(res);
	});

	it("does not bypass auth for the progress preview in production", () => {
		const res = proxy(req("nova-abc-uc.a.run.app", "/progress-test"));
		expectAuthRedirect(res);
	});
});

describe("proxy: matcher excludes static asset paths", () => {
	/* The middleware never runs on excluded paths — Next applies `config.matcher`
	 * BEFORE invoking `proxy()`, so an excluded path is served as a plain static
	 * asset (no hostname allowlist, no CSP, no auth redirect). Reconstruct the
	 * negative-lookahead matcher and assert what it runs on. `nova-icons` is the
	 * regression guard: without the exclusion the optimistic auth redirect 307s
	 * every `<img src="/nova-icons/…">` and the main-host allowlist 404s it in
	 * prod (localhost's unknown-host branch skips the allowlist, masking it). */
	const matcher = new RegExp(`^${config.matcher[0]}$`);

	it("does NOT run on built-in icons or framework static assets", () => {
		expect(matcher.test("/nova-icons/household.png")).toBe(false);
		expect(matcher.test("/_next/static/chunk.js")).toBe(false);
		expect(matcher.test("/_next/image")).toBe(false);
		expect(matcher.test("/favicon.ico")).toBe(false);
	});

	it("DOES run on pages and API routes", () => {
		expect(matcher.test("/")).toBe(true);
		expect(matcher.test("/build/app123")).toBe(true);
		expect(matcher.test("/api/chat")).toBe(true);
		// A path that merely starts with the same letters as the icons dir is
		// NOT the excluded segment, so the proxy still runs on it.
		expect(matcher.test("/nova-icons-admin")).toBe(true);
	});
});
