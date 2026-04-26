/**
 * Integration test for the per-request consent lock at
 * `app/api/mcp/route.ts`. Mocks `mcpHandler` (to inject synthetic JWT
 * claims via an `x-test-jwt-claims` header — signature verification
 * is the plugin's job, not ours) and `createMcpHandler` (to return a
 * sentinel 200, bypassing the JSON-RPC dispatcher). Better Auth + the
 * emulator do everything else for real, so the route's contract —
 * happy path, revoke-then-fail, missing claims, Firestore failure —
 * is exercised against actual plugin writes.
 *
 * Auto-skipped when `FIRESTORE_EMULATOR_HOST` is unset.
 */

import type { JWTPayload } from "jose";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// ── Module mocks ────────────────────────────────────────────────────

/**
 * Capture the `verifyOptions` argument the route passes to `mcpHandler`
 * so a separate test can assert scope enforcement is wired up. The
 * route's docstring claims "every tool inherits the scope check" —
 * without capturing this, a regression that drops `scopes` from the
 * mcpHandler config wouldn't fail any test.
 */
const captured: { mcpHandlerVerifyOptions: unknown } = {
	mcpHandlerVerifyOptions: undefined,
};

vi.mock("@better-auth/oauth-provider", async () => {
	const actual = await vi.importActual<
		typeof import("@better-auth/oauth-provider")
	>("@better-auth/oauth-provider");
	return {
		...actual,
		mcpHandler:
			(
				verifyOptions: unknown,
				handler: (req: Request, jwt: JWTPayload) => Promise<Response>,
			) =>
			async (req: Request): Promise<Response> => {
				captured.mcpHandlerVerifyOptions = verifyOptions;
				const raw = req.headers.get("x-test-jwt-claims");
				if (!raw) {
					throw new Error(
						"test setup: every request to the mocked mcpHandler must carry `x-test-jwt-claims`",
					);
				}
				return handler(req, JSON.parse(raw) as JWTPayload);
			},
	};
});

/** Sentinel 200 — the test detects "got past the consent check" by status. */
vi.mock("mcp-handler", () => ({
	createMcpHandler:
		() =>
		(_req: Request): Response =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
}));

// ── Imports that depend on the mocks above ─────────────────────────

import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { jwt as jwtPlugin } from "better-auth/plugins";
import { firestoreAdapter } from "better-auth-firestore";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore } from "firebase-admin/firestore";
import { MCP_RESOURCE_METADATA_URL } from "@/lib/hostnames";

// ── Test scaffolding ────────────────────────────────────────────────

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const TEST_PROJECT_ID = "demo-test";
const PLUGIN_COLLECTIONS = [
	"oauthClient",
	"oauthConsent",
	"oauthRefreshToken",
] as const;

async function clearPluginCollections(db: Firestore): Promise<void> {
	for (const name of PLUGIN_COLLECTIONS) {
		const snap = await db.collection(name).get();
		await Promise.all(snap.docs.map((d) => d.ref.delete()));
	}
}

/**
 * Factored out so the inferred return type carries plugin endpoints
 * (declaring inline in `beforeAll` widens to default `BetterAuthOptions`).
 * Mirrors `lib/auth.ts` so what lands in Firestore matches production.
 */
function createTestAuth(db: Firestore) {
	return betterAuth({
		secret: "x".repeat(32),
		baseURL: "http://localhost:3000",
		database: firestoreAdapter({
			firestore: db,
			collections: {
				users: "auth_users",
				sessions: "auth_sessions",
				accounts: "auth_accounts",
				verificationTokens: "auth_verifications",
			},
		}),
		plugins: [
			jwtPlugin({ disableSettingJwtHeader: true }),
			oauthProvider({
				loginPage: "/",
				consentPage: "/consent",
				validAudiences: ["http://localhost:3000/api/mcp"],
				scopes: ["openid", "profile", "email", "nova.read", "nova.write"],
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: ["nova.read", "nova.write"],
			}),
		],
	});
}

function mcpRequest(claims: Partial<JWTPayload>): Request {
	return new Request("http://localhost:3000/api/mcp", {
		method: "POST",
		headers: {
			"x-test-jwt-claims": JSON.stringify(claims),
			"content-type": "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
	});
}

/** Insert a consent row through the plugin's adapter. */
async function seedConsent(
	auth: ReturnType<typeof createTestAuth>,
	userId: string,
	clientId: string,
): Promise<{ id: string }> {
	const ctx = await auth.$context;
	return (await ctx.adapter.create({
		model: "oauthConsent",
		data: {
			clientId,
			userId,
			scopes: ["nova.read", "nova.write"],
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	})) as { id: string };
}

// ── Suite ───────────────────────────────────────────────────────────

describe.skipIf(!emulatorAvailable)("MCP route consent lock", () => {
	let auth: ReturnType<typeof createTestAuth>;
	let db: Firestore;
	let POST: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		initializeApp({ projectId: TEST_PROJECT_ID });
		db = new Firestore({ projectId: TEST_PROJECT_ID, preferRest: true });
		auth = createTestAuth(db);
		/* Import the route AFTER the `vi.mock` calls. */
		const route = await import("@/app/api/mcp/route");
		POST = route.POST;
	});

	afterAll(async () => {
		for (const app of getApps()) {
			await deleteApp(app);
		}
	});

	beforeEach(async () => {
		await clearPluginCollections(db);
	});

	// ── Configuration assertion ────────────────────────────────────

	it("registers `mcpHandler` with both Nova scopes required", async () => {
		/* Trigger one request so the route's module-scope `mcpHandler`
		 * call has run and the captured options are populated. */
		await POST(mcpRequest({ sub: "x", azp: "y" }));

		expect(captured.mcpHandlerVerifyOptions).toEqual(
			expect.objectContaining({
				scopes: expect.arrayContaining(["nova.read", "nova.write"]),
			}),
		);
	});

	// ── Happy path ─────────────────────────────────────────────────

	it("accepts a request when the user has an active consent for the calling client", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});
		await seedConsent(auth, "user-test-1", created.client_id);

		const res = await POST(
			mcpRequest({
				sub: "user-test-1",
				azp: created.client_id,
				iat: Math.floor(Date.now() / 1000),
				scope: "nova.read nova.write",
			}),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
	});

	// ── Revoke-then-fail (the load-bearing test) ───────────────────

	it("succeeds before revoke, fails 401 after — the end-to-end revocation contract", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});
		const consent = await seedConsent(auth, "user-test-1", created.client_id);

		const claims: Partial<JWTPayload> = {
			sub: "user-test-1",
			azp: created.client_id,
			iat: Math.floor(Date.now() / 1000),
			scope: "nova.read nova.write",
		};

		const before = await POST(mcpRequest(claims));
		expect(before.status).toBe(200);

		const { revokeAuthorizedClient } = await import("@/lib/db/oauth-consents");
		await revokeAuthorizedClient("user-test-1", consent.id);

		const after = await POST(mcpRequest(claims));
		expect(after.status).toBe(401);
		const wwwAuth = after.headers.get("WWW-Authenticate");
		expect(wwwAuth).toContain('error="invalid_token"');
		expect(wwwAuth).toContain('error_description="consent revoked"');
		/* `resource_metadata` URL drives Claude Code's auto-discovery —
		 * without it the 401 is a dead end. */
		expect(wwwAuth).toContain(
			`resource_metadata="${MCP_RESOURCE_METADATA_URL}"`,
		);
	});

	// ── Structural-token-failure paths ─────────────────────────────

	it("rejects with 401 when the JWT is missing the `sub` claim", async () => {
		const res = await POST(
			mcpRequest({ azp: "client-x", scope: "nova.read nova.write" }),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="missing subject claim"',
		);
	});

	it("rejects with 401 when the JWT is missing the `azp` claim", async () => {
		const res = await POST(
			mcpRequest({
				sub: "user-test-1",
				iat: Math.floor(Date.now() / 1000),
				scope: "nova.read nova.write",
			}),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="missing client identity"',
		);
	});

	it("rejects with 401 when the JWT is missing the `iat` claim", async () => {
		const res = await POST(
			mcpRequest({
				sub: "user-test-1",
				azp: "client-x",
				scope: "nova.read nova.write",
			}),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="missing token issue time"',
		);
	});

	// ── Firestore-down ─────────────────────────────────────────────

	it("fails closed with 401 when the consent lookup throws", async () => {
		const consentsModule = await import("@/lib/db/oauth-consents");
		const spy = vi
			.spyOn(consentsModule, "hasActiveConsent")
			.mockRejectedValueOnce(new Error("Firestore unavailable"));

		try {
			const res = await POST(
				mcpRequest({
					sub: "user-test-1",
					azp: "client-x",
					iat: Math.floor(Date.now() / 1000),
					scope: "nova.read nova.write",
				}),
			);
			expect(res.status).toBe(401);
			expect(res.headers.get("WWW-Authenticate")).toContain(
				'error_description="auth check failed"',
			);
		} finally {
			spy.mockRestore();
		}
	});
});
