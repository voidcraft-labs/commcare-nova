/**
 * Regression test for the MCP route's basePath wiring.
 *
 * The bug this guards against: `mcp-handler` does its own pathname check —
 * `new URL(req.url).pathname === ${basePath}/mcp` — and Next.js middleware
 * rewrites do NOT mutate `Request.url`. In production, requests reach this
 * route via `mcp.commcare.app/mcp` (wire pathname `/mcp`), the proxy
 * rewrites the routing target to `/api/mcp` so Next dispatches the right
 * handler, but the inbound `Request.url` still says `/mcp`. With a
 * hardcoded `basePath: "/api"` mcp-handler computes its endpoint as
 * `/api/mcp`, the equality check fails, and every authenticated request
 * gets a 9-byte `Not found` body — past the OAuth verify, hidden from
 * proxy.test.ts. The fix derives basePath from `MCP_RESOURCE_PATH`, which
 * already encodes the per-environment wire path.
 *
 * In the test environment `NODE_ENV=test` (vitest's default), so
 * `lib/hostnames.ts` evaluates `isDev` as false and `MCP_RESOURCE_PATH`
 * resolves to `/mcp` — i.e., the production-shaped wire path. That's
 * exactly the case where the bug fired, so a single test against
 * `https://mcp.commcare.app/mcp` is the regression.
 *
 * The OAuth verify layer is mocked so the request reaches the inner
 * mcp-handler dispatch — which is the layer being tested. The tool
 * registration is also mocked to a no-op so the test doesn't reach into
 * Firestore or KMS. The real `mcp-handler` is left unmocked precisely so
 * its pathname check actually runs.
 */

import { describe, expect, it, vi } from "vitest";

/** Bypass JWT verification — invoke the inner handler with synthetic claims. */
vi.mock("@better-auth/oauth-provider", () => ({
	mcpHandler:
		(
			_opts: unknown,
			inner: (req: Request, jwt: Record<string, unknown>) => Promise<Response>,
		) =>
		(req: Request) =>
			inner(req, {
				sub: "test-user",
				azp: "test-client",
				iat: Math.floor(Date.now() / 1000),
				scope: "nova.read nova.write",
			}),
}));

/** Skip the consent revocation lookup (would otherwise hit Firestore). */
vi.mock("@/lib/db/oauth-consents", () => ({
	hasActiveConsent: async () => true,
}));

/**
 * No-op tool registration. The test asserts on transport-level routing,
 * not on any tool's behavior — registering the real tools would drag in
 * Firestore and KMS clients that have no place in a unit test.
 */
vi.mock("@/lib/mcp/server", () => ({
	registerNovaTools: () => {},
}));

describe("POST /api/mcp basePath", () => {
	it("does not 404 when reached via the production wire path /mcp", async () => {
		const { POST } = await import("../route");

		const req = new Request("https://mcp.commcare.app/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "initialize",
				id: 1,
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "regression-test", version: "0" },
				},
			}),
		});

		const res = await POST(req);

		/* The exact failure signature: mcp-handler's else branch returns
		 * 404 with a 9-byte literal `Not found` body
		 * (node_modules/mcp-handler/dist/index.js — `res.statusCode = 404;
		 * res.end("Not found")`). Anything else means the pathname check
		 * matched and the request reached transport handling. */
		expect(res.status).not.toBe(404);
		const body = await res.text();
		expect(body).not.toBe("Not found");
	});
});
