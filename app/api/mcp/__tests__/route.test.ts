/**
 * Tests for the MCP plugin endpoint's two auth paths and shared
 * dispatch.
 *
 * The route is mounted as a Better Auth plugin endpoint (see
 * `app/api/mcp/auth-plugin.ts`), and the Next.js entry shim at
 * `app/api/mcp/route.ts` synthesizes a Request with URL
 * `/api/auth/mcp` before forwarding to `auth.handler`. Tests target
 * `dispatchMcpAuthRequest` directly with the post-shim URL shape —
 * that is the request `mcp-handler` always sees in production, and
 * the synthesizing shim itself is a 5-line URL rewrite that doesn't
 * carry the kind of branching logic worth unit-testing.
 *
 * **JWT-path regression** — guards against the `mcp-handler` basePath
 * bug. `mcp-handler` does its own pathname check
 * (`new URL(req.url).pathname === ${basePath}/mcp`). With the
 * synthesized URL `/api/auth/mcp` and `dispatch.ts`'s hardcoded
 * basePath `/api/auth`, the equality must hold. A regression that
 * drifts either side trips the 9-byte `Not found` body
 * (`node_modules/mcp-handler/dist/index.js` — `res.statusCode = 404;
 * res.end("Not found")`) — past auth, hidden from proxy.test.ts.
 *
 * **API-key-path coverage** — the dispatcher forks on the bearer
 * prefix. Tests below assert the fork picks the right path
 * (prefix-match → API key, else → JWT), the API-key 401s carry the
 * right `WWW-Authenticate` shape (Bearer challenge, no
 * `resource_metadata` parameter), and a successful verify reaches the
 * shared dispatch with the verified key's `referenceId` + scopes.
 *
 * The OAuth verify layer + plugin verify endpoint + tool registration
 * + consent lookup are mocked so the tests don't reach into Firestore
 * or KMS. The real `mcp-handler` is left unmocked precisely so its
 * pathname check actually runs in the JWT regression test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyApiKeyMock = vi.fn();
const registerNovaToolsMock = vi.fn();
const isUserActiveMock = vi.fn(async (_userId: string) => true);

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
 * Tool registration is mocked so the test doesn't drag Firestore and
 * KMS clients into the unit suite, but the mock is a real `vi.fn()`
 * (not a no-op) so tests can assert on the `ToolContext` shape that
 * reaches it. Both auth paths produce a `ToolContext`; the right
 * regression is "the verified credential's userId + scopes propagate
 * unchanged into tool dispatch."
 */
vi.mock("@/lib/mcp/server", () => ({
	registerNovaTools: registerNovaToolsMock,
}));

/**
 * `isUserActive` is mocked separately from the `verifyApiKey` boundary
 * so tests can drive the banned/deleted-user branch of the API-key
 * path without faking out the whole `lib/db/api-keys` surface.
 */
vi.mock("@/lib/db/api-keys", () => ({
	isUserActive: isUserActiveMock,
}));

/**
 * Stub `getAuth().api.verifyApiKey`. The route only ever uses
 * `auth.api.verifyApiKey`, so we can ignore the rest of the surface.
 * Per-test mock implementations control the verify outcome.
 */
vi.mock("@/lib/auth", () => ({
	getAuth: () => ({
		api: { verifyApiKey: verifyApiKeyMock },
	}),
}));

beforeEach(() => {
	verifyApiKeyMock.mockReset();
	registerNovaToolsMock.mockReset();
	isUserActiveMock.mockReset();
	isUserActiveMock.mockResolvedValue(true);
});

/* ── Helpers ────────────────────────────────────────────────────── */

/**
 * Build a Request shaped exactly like the one the plugin endpoint
 * receives in production. The route shim in `app/api/mcp/route.ts`
 * synthesizes a Request with URL `/api/auth/mcp` before handing off
 * to `auth.handler`; `mcp-handler` then matches `req.url.pathname`
 * against `${basePath}/mcp` where basePath is `/api/auth`. Tests
 * feed `dispatchMcpAuthRequest` the post-shim URL because that is
 * the shape the dispatcher always sees in production — anything else
 * 404s inside `mcp-handler` for reasons that are an artifact of the
 * test setup rather than a real bug.
 */
function buildRequest(authHeader?: string): Request {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (authHeader) headers.Authorization = authHeader;
	return new Request("https://mcp.commcare.app/api/auth/mcp", {
		method: "POST",
		headers,
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
}

/* ── JWT path regression ────────────────────────────────────────── */

describe("POST /api/mcp basePath (JWT path)", () => {
	it("does not 404 when reached via the production wire path /mcp", async () => {
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(buildRequest());

		/* The exact failure signature: mcp-handler's else branch returns
		 * 404 with a 9-byte literal `Not found` body
		 * (node_modules/mcp-handler/dist/index.js — `res.statusCode = 404;
		 * res.end("Not found")`). Anything else means the pathname check
		 * matched and the request reached transport handling. */
		expect(res.status).not.toBe(404);
		const body = await res.text();
		expect(body).not.toBe("Not found");
	});

	it("falls through to the JWT path when the bearer doesn't carry the Nova prefix", async () => {
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		await dispatchMcpAuthRequest(buildRequest("Bearer some.opaque.jwt.token"));

		/* If the prefix peek wrongly routed this bearer to the API-key
		 * handler, `verifyApiKeyMock` would have been called instead. */
		expect(verifyApiKeyMock).not.toHaveBeenCalled();
		/* The JWT-path inner handler is what builds the ToolContext
		 * from the verified JWT claims. Asserting on the
		 * `registerNovaTools` argument proves the JWT path actually ran
		 * end-to-end, not just that the API-key path didn't. The
		 * `mcpHandler` mock at the top of this file injects synthetic
		 * `sub` / `azp` / `iat` / `scope` claims; the route translates
		 * those into `{ userId: "test-user", scopes: [...] }`. */
		expect(registerNovaToolsMock).toHaveBeenCalledTimes(1);
		const ctxArg = registerNovaToolsMock.mock.calls[0]?.[1];
		expect(ctxArg).toEqual({
			userId: "test-user",
			scopes: ["nova.read", "nova.write"],
			authKind: "oauth",
		});
	});
});

/* ── Host gate ─────────────────────────────────────────────────── */

describe("MCP plugin host gate", () => {
	it("rejects requests on hosts other than mcp.commcare.app / localhost", async () => {
		/* Defense-in-depth check inside `dispatchMcpAuthRequest`. The
		 * proxy's main-host branch already 404s `/api/auth/mcp` before
		 * the route is reached, but the in-endpoint check covers paths
		 * a request can take that bypass the proxy (direct Cloud Run
		 * service URLs, container-local requests). The wire surface
		 * is `mcp.commcare.app/mcp`; everything else returns 404
		 * without surfacing a `WWW-Authenticate` header — this isn't
		 * an auth failure, it's the wrong wire endpoint. */
		const req = new Request("https://commcare.app/api/auth/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "initialize",
				id: 1,
			}),
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(req);

		expect(res.status).toBe(404);
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
		expect(verifyApiKeyMock).not.toHaveBeenCalled();
		expect(registerNovaToolsMock).not.toHaveBeenCalled();
	});

	it("accepts localhost as a wire host so the dev flow keeps working", async () => {
		/* Local-dev requests carry `Host: localhost:3000`. The
		 * normalize-and-split-port step in `readWireHost` reduces
		 * that to `localhost`, which is in the allowed set. A
		 * regression that drops the port-strip would block every
		 * dev request to the route. Pinned here so a future tightening
		 * of the host gate can't silently break local dev. */
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-1",
				referenceId: "user-7",
				permissions: { scope: ["nova.read", "nova.write"] },
			},
		});
		const req = new Request("http://localhost:3000/api/auth/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: "Bearer sk-nova-v1-aBcDeFg12345",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "initialize",
				id: 1,
			}),
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(req);

		expect(res.status).not.toBe(404);
		expect(verifyApiKeyMock).toHaveBeenCalledTimes(1);
	});
});

/* ── API-key path ───────────────────────────────────────────────── */

describe("POST /api/mcp (API-key path)", () => {
	it("dispatches to the API-key verifier when the bearer carries the Nova prefix", async () => {
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-1",
				referenceId: "user-7",
				permissions: { scope: ["nova.read", "nova.write"] },
			},
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-aBcDeFg12345"),
		);

		expect(verifyApiKeyMock).toHaveBeenCalledTimes(1);
		const callArg = verifyApiKeyMock.mock.calls[0]?.[0];
		expect(callArg.body.key).toBe("sk-nova-v1-aBcDeFg12345");
		/* On a successful verify, dispatch reaches `mcp-handler` and we
		 * see a transport-level response (not a 401). Floor-scope check
		 * is local (not delegated to verifyApiKey) — see the dedicated
		 * test below for that behavior. */
		expect(res.status).not.toBe(401);
		/* Tool registration must receive the verified credential's
		 * identity unchanged. A regression in `ToolContext` construction
		 * (lost userId, swapped fields, dropped scopes) trips here even
		 * if the response shape stays right. */
		expect(registerNovaToolsMock).toHaveBeenCalledTimes(1);
		const ctxArg = registerNovaToolsMock.mock.calls[0]?.[1];
		expect(ctxArg).toEqual({
			userId: "user-7",
			scopes: ["nova.read", "nova.write"],
			authKind: "api-key",
		});
	});

	it("returns 401 'user disabled' when the verified key's owner is banned or deleted", async () => {
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-banned-owner",
				referenceId: "user-banned",
				permissions: { scope: ["nova.read", "nova.write"] },
			},
		});
		isUserActiveMock.mockResolvedValue(false);
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-bannedUser"),
		);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="user disabled"',
		);
		/* Tool dispatch must not run for a disabled user — defends
		 * against a regression that fails to short-circuit on the
		 * banned branch. */
		expect(registerNovaToolsMock).not.toHaveBeenCalled();
	});

	it("fails closed with 401 'api key verify failed' when the user-status lookup throws", async () => {
		/* The route wraps `isUserActive` in try/catch and converts a
		 * Firestore failure into a 401, deliberately rejecting rather
		 * than authenticating during a transient outage. A regression
		 * that drops the catch (or wraps the call in a helper that
		 * swallows the throw) would silently invert that posture and
		 * authenticate any verified-key holder while Firestore is
		 * unreachable — including banned users. This test pins the
		 * fail-closed contract. */
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-fs-down",
				referenceId: "user-fs-down",
				permissions: { scope: ["nova.read", "nova.write"] },
			},
		});
		isUserActiveMock.mockRejectedValue(new Error("firestore unavailable"));
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-fsdown"),
		);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="api key verify failed"',
		);
		expect(registerNovaToolsMock).not.toHaveBeenCalled();
	});

	it("returns 401 with a Bearer challenge (no resource_metadata) on INVALID_API_KEY (no such key)", async () => {
		/* `INVALID_API_KEY` is the plugin's lookup-miss code — what
		 * fires when the bearer's hash doesn't match any stored row
		 * (key never existed, was deleted, or was forged). Pin the
		 * production behavior; a regression that drops the
		 * `INVALID_API_KEY` case from `mapApiKeyErrorCode` would
		 * silently change every "no such key" 401 to a fallback
		 * description. */
		verifyApiKeyMock.mockResolvedValue({
			valid: false,
			error: { code: "INVALID_API_KEY", message: "Invalid API key." },
			key: null,
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-doesnotexist"),
		);

		expect(res.status).toBe(401);
		const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
		expect(wwwAuth).toMatch(/^Bearer /);
		expect(wwwAuth).toContain('error="invalid_token"');
		expect(wwwAuth).toContain('error_description="api key invalid"');
		/* No OAuth fallback hint on this branch — the client explicitly
		 * sent an API key; pointing them at OAuth metadata would mislead. */
		expect(wwwAuth).not.toContain("resource_metadata");
	});

	it("also maps KEY_NOT_FOUND to 'api key invalid' (plugin's internal scope-mismatch / no-permissions code path)", async () => {
		/* `KEY_NOT_FOUND` is the plugin's code for a row that was
		 * located but whose `permissions` field is missing or whose
		 * scope check failed when `permissions` was passed to
		 * `verifyApiKey`. Nova's route doesn't pass `permissions` to
		 * verify (see `handleApiKeyMcp`'s docblock), so this code only
		 * surfaces if the plugin's behavior changes — but the
		 * collapsing-to-"api key invalid" mapping must still hold so
		 * the wire shape stays consistent. */
		verifyApiKeyMock.mockResolvedValue({
			valid: false,
			error: { code: "KEY_NOT_FOUND", message: "API Key not found" },
			key: null,
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-noperms"),
		);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="api key invalid"',
		);
	});

	it("maps KEY_EXPIRED → 'api key expired'", async () => {
		verifyApiKeyMock.mockResolvedValue({
			valid: false,
			error: { code: "KEY_EXPIRED", message: "API Key has expired" },
			key: null,
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-expired"),
		);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="api key expired"',
		);
	});

	it("maps KEY_DISABLED → 'api key disabled'", async () => {
		verifyApiKeyMock.mockResolvedValue({
			valid: false,
			error: { code: "KEY_DISABLED", message: "API Key is disabled" },
			key: null,
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-disabled"),
		);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="api key disabled"',
		);
	});

	it("returns 403 + insufficient_scope when the key is valid but lacks a floor scope (RFC 6750 §3)", async () => {
		/* Floor-scope enforcement is local in `handleApiKeyMcp`, NOT
		 * delegated to `verifyApiKey({ permissions })` — the plugin's
		 * built-in permission check throws `KEY_NOT_FOUND`, which
		 * `mapApiKeyErrorCode` maps to `"api key invalid"`, collapsing
		 * scope-failure into authentication-failure on the wire.
		 *
		 * RFC 6750 §3 says missing-scope is a 403 with
		 * `error="insufficient_scope"`, not a 401 — and the JWT path
		 * already emits 403 implicitly via `mcpHandler`'s scope check.
		 * Pin both: the wire status AND the error code. */
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-readonly",
				referenceId: "user-7",
				permissions: { scope: ["nova.read"] },
			},
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-readonly"),
		);

		expect(res.status).toBe(403);
		const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
		expect(wwwAuth).toContain('error="insufficient_scope"');
		expect(wwwAuth).toContain('error_description="api key missing scope"');
	});

	it("does NOT pass `permissions` to verifyApiKey (would collapse scope-missing into KEY_NOT_FOUND)", async () => {
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-1",
				referenceId: "user-7",
				permissions: { scope: ["nova.read", "nova.write"] },
			},
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-aBcDeFg12345"),
		);

		const callArg = verifyApiKeyMock.mock.calls[0]?.[0];
		expect(callArg.body).toEqual({ key: "sk-nova-v1-aBcDeFg12345" });
		expect(callArg.body.permissions).toBeUndefined();
	});

	it("returns 401 'api key verify failed' when the plugin verify throws", async () => {
		verifyApiKeyMock.mockRejectedValue(new Error("downstream blew up"));
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-broken"),
		);

		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="api key verify failed"',
		);
	});

	it("rejects a valid response with no referenceId as 'api key invalid'", async () => {
		/* Defense in depth: the plugin's `ApiKey` type pins `referenceId`
		 * as a string, but if a future verify regression returned a
		 * blank value, downstream tools would otherwise see `userId: ""`
		 * and run Firestore queries against the empty user. The 401
		 * path is the right failure mode. */
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-2",
				referenceId: "",
				permissions: { scope: ["nova.read", "nova.write"] },
			},
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		const res = await dispatchMcpAuthRequest(
			buildRequest("Bearer sk-nova-v1-noref"),
		);

		expect(res.status).toBe(401);
	});

	it("does not call the api-key verifier when no Authorization header is sent", async () => {
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");
		await dispatchMcpAuthRequest(buildRequest());
		expect(verifyApiKeyMock).not.toHaveBeenCalled();
	});

	it("matches the Bearer scheme case-insensitively per RFC 6750 §2.1", async () => {
		verifyApiKeyMock.mockResolvedValue({
			valid: true,
			error: null,
			key: {
				id: "key-1",
				referenceId: "user-7",
				permissions: { scope: ["nova.read", "nova.write"] },
			},
		});
		const { dispatchMcpAuthRequest } = await import("../auth-plugin");

		/* Lowercase scheme is RFC-compliant; route must route this to
		 * the API-key path. A regression that drops the regex's `i`
		 * flag (or replaces with `.startsWith("Bearer ")`) breaks
		 * less-common-but-compliant clients silently — this test
		 * catches that. */
		await dispatchMcpAuthRequest(
			buildRequest("bearer sk-nova-v1-aBcDeFg12345"),
		);
		expect(verifyApiKeyMock).toHaveBeenCalledTimes(1);

		verifyApiKeyMock.mockClear();
		await dispatchMcpAuthRequest(
			buildRequest("BEARER sk-nova-v1-aBcDeFg12345"),
		);
		expect(verifyApiKeyMock).toHaveBeenCalledTimes(1);
	});
});
