/**
 * Tests for the Next.js 16 proxy. The proxy layers three concerns:
 *
 *   1. hostname routing (per-host path allowlists, MCP /mcp → /api/mcp rewrite, off-allowlist 404s),
 *   2. main-host /api/* short-circuit (no CSP, no auth redirect on API routes),
 *   3. main-host page handling (CSP nonce + optimistic auth redirect).
 *
 * Every assertion is affirmative: 404 responses are checked for the no-store
 * Cache-Control header (so a security boundary can't be silently cached);
 * rewrites are checked for `x-middleware-rewrite` containing the internal
 * target plus any expected query string; passthroughs are checked for the
 * absence of both.
 *
 * `NextResponse.rewrite` encodes the destination on the response in the
 * `x-middleware-rewrite` header — that's the contract Next inspects when it
 * routes the rewritten request internally, so it's the authoritative signal
 * that a rewrite happened.
 */

import { NextRequest, type NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../proxy";

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
 * Assert that a response is a passthrough: not a 404, and no rewrite
 * header. The proxy may still attach CSP / nonce headers (that's the
 * point of the page branch); we only care here that nothing else
 * intercepted the request.
 */
function expectPassthrough(res: NextResponse): void {
	expect(res.status).not.toBe(404);
	expect(res.headers.get("x-middleware-rewrite")).toBeNull();
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

describe("proxy: mcp.commcare.app routing", () => {
	it("rewrites /mcp → /api/mcp", () => {
		const res = proxy(req("mcp.commcare.app", "/mcp"));
		expectRewrite(res, "/api/mcp");
	});

	it("preserves the query string when rewriting /mcp", () => {
		const res = proxy(req("mcp.commcare.app", "/mcp?session=abc&foo=bar"));
		expectRewrite(res, "/api/mcp");
		const rewrite = res.headers.get("x-middleware-rewrite") ?? "";
		expect(rewrite).toContain("session=abc");
		expect(rewrite).toContain("foo=bar");
	});

	it("404s the internal /api/mcp path (not externally reachable)", () => {
		const res = proxy(req("mcp.commcare.app", "/api/mcp"));
		expectNotFound(res);
	});

	it("passes through /.well-known/oauth-protected-resource (OAuth discovery)", () => {
		const res = proxy(
			req("mcp.commcare.app", "/.well-known/oauth-protected-resource"),
		);
		expectPassthrough(res);
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
	it("passes through the root path", () => {
		const res = proxy(req("docs.commcare.app", "/"));
		expectPassthrough(res);
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
});

describe("proxy: commcare.app (main) routing", () => {
	it("passes through /.well-known/oauth-authorization-server (OAuth discovery, no auth gate)", () => {
		/* The /.well-known/* exemption is critical: an OAuth client must
		 * be able to read AS metadata before it has a session, so the
		 * auth-redirect branch must skip these paths. */
		const res = proxy(
			req("commcare.app", "/.well-known/oauth-authorization-server"),
		);
		expectPassthrough(res);
	});

	it("404s /api/mcp on the main host (MCP belongs to its own subdomain)", () => {
		const res = proxy(req("commcare.app", "/api/mcp"));
		expectNotFound(res);
	});

	it("redirects unauthenticated /admin to / (CSP+auth path)", () => {
		/* /admin is on the main allowlist, so it passes the hostname
		 * gate; it isn't /api/*, so the API short-circuit doesn't apply;
		 * it has no session cookie, so the auth-redirect branch fires. */
		const res = proxy(req("commcare.app", "/admin"));
		expectAuthRedirect(res);
	});

	it("passes through /api/chat (API short-circuit, no CSP/auth)", () => {
		const res = proxy(req("commcare.app", "/api/chat"));
		expectPassthrough(res);
		/* CSP must NOT have been applied — that branch is skipped for
		 * API routes. */
		expect(res.headers.get("content-security-policy")).toBeNull();
	});
});

describe("proxy: unknown hosts (Cloud Run health checks, dev localhost)", () => {
	it("passes /api/* through without auth redirect", () => {
		/* Unknown classification skips the allowlist entirely but still
		 * runs through the API short-circuit. The previous round of
		 * tests asserted "not 404"; we additionally assert no auth
		 * redirect, since redirecting Cloud Run's health probe to / would
		 * mark the instance unhealthy. */
		const res = proxy(req("nova-abc-uc.a.run.app", "/api/chat"));
		expectPassthrough(res);
		expect(res.status).not.toBe(307);
	});
});
