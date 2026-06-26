/**
 * Integration test for the per-request consent lock at
 * `app/api/mcp/jwt-auth.ts::handleJwtMcp`. Mocks `mcpHandler` (to inject
 * synthetic JWT claims via an `x-test-jwt-claims` header — signature
 * verification is the plugin's job, not ours) and `createMcpHandler` (to return
 * a sentinel 200, bypassing the JSON-RPC dispatcher). Better Auth + Postgres do
 * everything else for real, so the JWT path's contract — happy path,
 * revoke-then-fail, missing claims, lookup failure — is exercised against actual
 * plugin writes.
 *
 * Runs on the per-test-database harness booted by the case-store testcontainer
 * `globalSetup`. The route's consent/user reads reach the DB through the
 * `getAuthDb` singleton, pointed at the per-test pool via `__setAuthDbForTests`.
 */

import type { JWTPayload } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────

/**
 * Capture the `verifyOptions` argument the route passes to `mcpHandler` so a
 * separate test can assert scope enforcement is wired up. The route's docstring
 * claims "every tool inherits the scope check" — without capturing this, a
 * regression that drops `scopes` from the mcpHandler config wouldn't fail.
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
import { getMigrations } from "better-auth/db/migration";
import { jwt as jwtPlugin } from "better-auth/plugins";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { dispatchMcpAuthRequest } from "@/app/api/mcp/auth-plugin";
import { __setAuthDbForTests, type AuthDatabase } from "@/lib/auth/db";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { AUTH_TABLE_NAMES } from "@/lib/auth-schema-shared";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { MCP_RESOURCE_METADATA_URL } from "@/lib/hostnames";

// ── Test scaffolding ────────────────────────────────────────────────

const TEST_SECRET = "x".repeat(32);
const TEST_USER_ID = "user-test-1";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "auth_mcp_revoke_",
});

/**
 * Mirrors `lib/auth.ts`'s oauth stack — same table names (so plugin writes land
 * in the auth tables the route reads) and DCR enabled. Factored out so the
 * inferred return type carries the plugin endpoints.
 */
function createTestAuth(pool: typeof dbHandle.pool) {
	return betterAuth({
		secret: TEST_SECRET,
		baseURL: "http://localhost:3000",
		database: pool,
		user: { modelName: AUTH_TABLE_NAMES.user },
		session: { modelName: AUTH_TABLE_NAMES.session },
		account: { modelName: AUTH_TABLE_NAMES.account },
		verification: { modelName: AUTH_TABLE_NAMES.verification },
		plugins: [
			jwtPlugin({
				disableSettingJwtHeader: true,
				schema: { jwks: { modelName: AUTH_TABLE_NAMES.jwks } },
			}),
			oauthProvider({
				loginPage: "/",
				consentPage: "/consent",
				validAudiences: ["http://localhost:3000/api/mcp"],
				scopes: ["openid", "profile", "email", "nova.read", "nova.write"],
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: ["nova.read", "nova.write"],
				schema: {
					oauthClient: { modelName: AUTH_TABLE_NAMES.oauthClient },
					oauthConsent: { modelName: AUTH_TABLE_NAMES.oauthConsent },
					oauthRefreshToken: {
						modelName: AUTH_TABLE_NAMES.oauthRefreshToken,
					},
					oauthAccessToken: { modelName: AUTH_TABLE_NAMES.oauthAccessToken },
				},
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

describe("MCP route consent lock", () => {
	let auth: ReturnType<typeof createTestAuth>;

	beforeEach(async () => {
		const { runMigrations } = await getMigrations(
			authMigrateOptions(dbHandle.pool),
		);
		await runMigrations();
		await runAuthAppMigrations(dbHandle.db);
		__setAuthDbForTests(
			new Kysely<AuthDatabase>({
				dialect: new PostgresDialect({
					pool: dbHandle.pool as unknown as PostgresPool,
				}),
			}),
		);
		// The route's user-revocation lock (isUserActive) + consent FKs need the
		// caller's auth_user row.
		await dbHandle.pool.query(
			`INSERT INTO auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
			 VALUES ($1, 'MCP test user', 'mcp@dimagi.com', true, now(), now())`,
			[TEST_USER_ID],
		);
		auth = createTestAuth(dbHandle.pool);
	});

	afterEach(() => {
		__setAuthDbForTests(null);
	});

	// ── Configuration assertion ────────────────────────────────────

	it("registers `mcpHandler` with both Nova scopes required", async () => {
		await dispatchMcpAuthRequest(mcpRequest({ sub: "x", azp: "y" }));

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
		await seedConsent(auth, TEST_USER_ID, created.client_id);

		const res = await dispatchMcpAuthRequest(
			mcpRequest({
				sub: TEST_USER_ID,
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
		const consent = await seedConsent(auth, TEST_USER_ID, created.client_id);

		const claims: Partial<JWTPayload> = {
			sub: TEST_USER_ID,
			azp: created.client_id,
			iat: Math.floor(Date.now() / 1000),
			scope: "nova.read nova.write",
		};

		const before = await dispatchMcpAuthRequest(mcpRequest(claims));
		expect(before.status).toBe(200);

		const { revokeAuthorizedClient } = await import("@/lib/db/oauth-consents");
		await revokeAuthorizedClient(TEST_USER_ID, consent.id);

		const after = await dispatchMcpAuthRequest(mcpRequest(claims));
		expect(after.status).toBe(401);
		const wwwAuth = after.headers.get("WWW-Authenticate");
		expect(wwwAuth).toContain('error="invalid_token"');
		expect(wwwAuth).toContain('error_description="consent revoked"');
		/* `resource_metadata` URL drives Claude Code's auto-discovery — without
		 * it the 401 is a dead end. */
		expect(wwwAuth).toContain(
			`resource_metadata="${MCP_RESOURCE_METADATA_URL}"`,
		);
	});

	// ── Structural-token-failure paths ─────────────────────────────

	it("rejects with 401 when the JWT is missing the `sub` claim", async () => {
		const res = await dispatchMcpAuthRequest(
			mcpRequest({ azp: "client-x", scope: "nova.read nova.write" }),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="missing subject claim"',
		);
	});

	it("rejects with 401 when the JWT is missing the `azp` claim", async () => {
		const res = await dispatchMcpAuthRequest(
			mcpRequest({
				sub: TEST_USER_ID,
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
		const res = await dispatchMcpAuthRequest(
			mcpRequest({
				sub: TEST_USER_ID,
				azp: "client-x",
				scope: "nova.read nova.write",
			}),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain(
			'error_description="missing token issue time"',
		);
	});

	// ── Lookup-failure path ─────────────────────────────────────────

	it("fails closed with 401 when the consent lookup throws", async () => {
		const consentsModule = await import("@/lib/db/oauth-consents");
		const spy = vi
			.spyOn(consentsModule, "hasActiveConsent")
			.mockRejectedValueOnce(new Error("database unavailable"));

		try {
			const res = await dispatchMcpAuthRequest(
				mcpRequest({
					sub: TEST_USER_ID,
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
