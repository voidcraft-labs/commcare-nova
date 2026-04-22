import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../middleware";

function req(host: string, path: string): NextRequest {
	const url = new URL(`https://${host}${path}`);
	return new NextRequest(url, { headers: { host } });
}

describe("middleware hostname routing", () => {
	it("rewrites /mcp → /api/mcp on mcp.commcare.app", () => {
		const res = middleware(req("mcp.commcare.app", "/mcp"));
		expect(res.status).not.toBe(404);
		/* NextResponse.rewrite puts the internal destination in the
		 * `x-middleware-rewrite` response header. */
		expect(res.headers.get("x-middleware-rewrite")).toContain("/api/mcp");
	});
	it("does NOT rewrite /api/mcp on mcp.commcare.app (internal path not externally reachable)", () => {
		const res = middleware(req("mcp.commcare.app", "/api/mcp"));
		expect(res.status).toBe(404);
	});
	it("404s /admin on mcp.commcare.app", () => {
		const res = middleware(req("mcp.commcare.app", "/admin"));
		expect(res.status).toBe(404);
	});
	it("404s /mcp on commcare.app", () => {
		const res = middleware(req("commcare.app", "/mcp"));
		expect(res.status).toBe(404);
	});
	it("allows OAuth-AS metadata on commcare.app", () => {
		const res = middleware(
			req("commcare.app", "/.well-known/oauth-authorization-server"),
		);
		expect(res.status).not.toBe(404);
	});
	it("404s OAuth-AS metadata on mcp.commcare.app", () => {
		const res = middleware(
			req("mcp.commcare.app", "/.well-known/oauth-authorization-server"),
		);
		expect(res.status).toBe(404);
	});
	it("handles trailing-dot host", () => {
		const res = middleware(req("mcp.commcare.app.", "/mcp"));
		expect(res.status).not.toBe(404);
	});
	it("passes unknown Cloud Run host through as main app", () => {
		const res = middleware(req("nova-abc-uc.a.run.app", "/api/chat"));
		expect(res.status).not.toBe(404);
	});
});
