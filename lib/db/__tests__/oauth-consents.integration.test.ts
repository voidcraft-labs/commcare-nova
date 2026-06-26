/**
 * Integration tests for `lib/db/oauth-consents.ts` against a real Postgres (the
 * testcontainer). The unit suite mocks the SDK; the test author controls both
 * sides of the comparison there, so a schema-boundary bug (e.g. querying the
 * wrong column name) can't fail it. This file runs the actual
 * `@better-auth/oauth-provider` plugin — writing through its OWN adapter + DCR
 * endpoint — and reads back through our Kysely helpers, so column-name / type
 * drift between the plugin's generated schema and our queries fails loudly.
 *
 * Runs on the per-test-database harness (a fresh Postgres database per test, the
 * `db.transaction()`-safe path `revokeAuthorizedClient` needs) booted by the
 * case-store testcontainer `globalSetup`. The module functions reach the DB
 * through the `getAuthDb` singleton, pointed at the per-test pool via the
 * `__setAuthDbForTests` seam.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAuthDbForTests, type AuthDatabase } from "@/lib/auth/db";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { AUTH_TABLE_NAMES } from "@/lib/auth-schema-shared";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";

const TEST_SECRET = "x".repeat(32);

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "auth_oauth_" });

/**
 * Mirror of `lib/auth.ts`'s oauth stack — same table names (so writes land in
 * the auth tables) and DCR enabled (so `registerOAuthClient` works). Built here
 * rather than from `authMigrateOptions` because that config is schema-only (no
 * DCR flags); the table names come from the shared `AUTH_TABLE_NAMES`.
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
			jwt({
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

describe("oauth-consents integration", () => {
	let auth: ReturnType<typeof createTestAuth>;

	beforeEach(async () => {
		const { runMigrations } = await getMigrations(
			authMigrateOptions(dbHandle.pool),
		);
		await runMigrations();
		await runAuthAppMigrations(dbHandle.db);
		// Consent + refresh-token rows FK to auth_user, so seed the users the
		// tests reference.
		for (const userId of ["user-test-1", "user-other"]) {
			await dbHandle.pool.query(
				`INSERT INTO auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
				 VALUES ($1, $1, $2, true, now(), now())`,
				[userId, `${userId}@dimagi.com`],
			);
		}
		// Point the module's getAuthDb at this test's Postgres.
		__setAuthDbForTests(
			new Kysely<AuthDatabase>({
				dialect: new PostgresDialect({
					pool: dbHandle.pool as unknown as PostgresPool,
				}),
			}),
		);
		auth = createTestAuth(dbHandle.pool);
	});

	afterEach(() => {
		__setAuthDbForTests(null);
	});

	// ── listAuthorizedClients ──────────────────────────────────────

	it("returns the real client_name written by the plugin (the bug-catching test)", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});
		expect(created.client_id).toBeTruthy();
		const clientId = created.client_id;

		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId,
				userId: "user-test-1",
				scopes: ["nova.read", "nova.write"],
				createdAt: new Date("2026-04-20T12:00:00.000Z"),
				updatedAt: new Date("2026-04-20T12:00:00.000Z"),
			},
		});

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-test-1");

		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row.clientId).toBe(clientId);
		/* Pins the plugin's storage column names (`clientId`, `name`) +
		 * jsonb `scopes` decode against our reads. */
		expect(row.clientName).toBe("Claude Code");
		expect(row.scopes).toEqual(["nova.read", "nova.write"]);
		expect(row.authorizedAt).toBe("2026-04-20T12:00:00.000Z");
	});

	it("falls back to 'An application' when the registered client has no client_name", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-test-1",
				scopes: ["nova.read"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-test-1");

		expect(rows).toHaveLength(1);
		expect(rows[0].clientName).toBe("An application");
	});

	it("does not leak other users' consents", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		for (const userId of ["user-test-1", "user-other"]) {
			await ctx.adapter.create({
				model: "oauthConsent",
				data: {
					clientId: created.client_id,
					userId,
					scopes: ["nova.read"],
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
		}

		const { listAuthorizedClients } = await import("../oauth-consents");
		const rows = await listAuthorizedClients("user-test-1");

		expect(rows).toHaveLength(1);
	});

	// ── hasActiveConsent ───────────────────────────────────────────

	it("returns false when no consent exists", async () => {
		const { hasActiveConsent } = await import("../oauth-consents");
		expect(await hasActiveConsent("user-test-1", "client-not-here")).toBe(
			false,
		);
	});

	it("returns true when (userId, clientId) matches", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-test-1",
				scopes: ["nova.read", "nova.write"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const { hasActiveConsent } = await import("../oauth-consents");
		expect(await hasActiveConsent("user-test-1", created.client_id)).toBe(true);
	});

	// ── revokeAuthorizedClient ─────────────────────────────────────

	it("deletes the consent and revokes refresh tokens atomically", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		const consent = (await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-test-1",
				scopes: ["nova.read", "nova.write"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		})) as { id: string };

		/* Two refresh tokens: a live one (should be marked revoked) and one
		 * already revoked (should be left alone, no redundant write). */
		await ctx.adapter.create({
			model: "oauthRefreshToken",
			data: {
				token: "live-token",
				clientId: created.client_id,
				userId: "user-test-1",
				expiresAt: new Date(Date.now() + 86400_000),
				createdAt: new Date(),
				scopes: ["nova.read"],
			},
		});
		const alreadyRevokedAt = new Date("2026-04-01T00:00:00.000Z");
		await ctx.adapter.create({
			model: "oauthRefreshToken",
			data: {
				token: "stale-token",
				clientId: created.client_id,
				userId: "user-test-1",
				expiresAt: new Date(Date.now() + 86400_000),
				createdAt: new Date(),
				revoked: alreadyRevokedAt,
				scopes: ["nova.read"],
			},
		});

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await revokeAuthorizedClient("user-test-1", consent.id);

		/* Consent row gone. */
		const consentRows = await dbHandle.pool.query(
			`SELECT id FROM auth_oauth_consent WHERE id = $1`,
			[consent.id],
		);
		expect(consentRows.rowCount).toBe(0);

		const tokens = await dbHandle.pool.query<{
			token: string;
			revoked: Date | null;
		}>(
			`SELECT token, revoked FROM auth_oauth_refresh_token WHERE "userId" = $1 AND "clientId" = $2`,
			["user-test-1", created.client_id],
		);
		const byName = new Map(tokens.rows.map((r) => [r.token, r.revoked]));

		expect(byName.get("live-token")).not.toBeNull();
		/* Already-revoked stays at its original timestamp — a rewrite would
		 * replace it with a fresh revoke instant. */
		const stale = byName.get("stale-token");
		expect(stale).toBeInstanceOf(Date);
		expect((stale as Date).getTime()).toBe(alreadyRevokedAt.getTime());
	});

	it("rejects when the consent belongs to a different user", async () => {
		const created = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Claude Code",
				token_endpoint_auth_method: "none",
			},
		});

		const ctx = await auth.$context;
		const consent = (await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: created.client_id,
				userId: "user-other",
				scopes: ["nova.read"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		})) as { id: string };

		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await expect(
			revokeAuthorizedClient("user-test-1", consent.id),
		).rejects.toThrow(/does not belong to this user/);
	});

	it("is idempotent for an already-revoked (missing) consent", async () => {
		const { revokeAuthorizedClient } = await import("../oauth-consents");
		await expect(
			revokeAuthorizedClient("user-test-1", "no-such-consent-id"),
		).resolves.toBeUndefined();
	});

	// ── cleanupStalePublicOAuthClients ─────────────────────────────

	it("deletes stale public clients with no grants, keeps those with a consent", async () => {
		const orphan = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "Orphan",
				token_endpoint_auth_method: "none",
			},
		});
		const inUse = await auth.api.registerOAuthClient({
			body: {
				redirect_uris: ["http://localhost:9999/cb"],
				client_name: "In use",
				token_endpoint_auth_method: "none",
			},
		});
		const ctx = await auth.$context;
		await ctx.adapter.create({
			model: "oauthConsent",
			data: {
				clientId: inUse.client_id,
				userId: "user-test-1",
				scopes: ["nova.read"],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});

		const { cleanupStalePublicOAuthClients } = await import(
			"../oauth-consents"
		);
		/* `now` far in the future makes the just-registered clients older than the
		 * cutoff without manipulating their `createdAt`. */
		const deleted = await cleanupStalePublicOAuthClients({
			now: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000),
			olderThanDays: 30,
		});

		expect(deleted).toBe(1);
		const remaining = await dbHandle.pool.query<{ clientId: string }>(
			`SELECT "clientId" FROM auth_oauth_client`,
		);
		const ids = remaining.rows.map((r) => r.clientId);
		expect(ids).toContain(inUse.client_id);
		expect(ids).not.toContain(orphan.client_id);
	});
});
