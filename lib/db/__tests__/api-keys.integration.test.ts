/**
 * Integration tests for the api-key auth path against a real Postgres (the
 * testcontainer). The unit suite mocks `auth.api.{createApiKey, verifyApiKey,
 * deleteApiKey, updateApiKey}` at the boundary; the test author controls both
 * sides of those mocks, so a schema-boundary bug (a field rename in the plugin,
 * a Zod-validation rule we forgot, the `SERVER_ONLY_PROPERTY` rejection of
 * `permissions` when headers are passed) can't fail it. This file runs the
 * actual `@better-auth/api-key` plugin and reads back through our helpers, so
 * plugin-API drift fails loudly here instead of silently in production.
 *
 * What this proves that the unit tests can't:
 *   - The full mint → verify → revoke round-trip works end-to-end against the
 *     plugin's actual schema. A plugin version that renames `userId` to
 *     `principalId` or adds a required field would trip mint here.
 *   - `permissions` is accepted in server-only mode (no `headers` arg to
 *     `auth.api.createApiKey`) — the regression risk this defends against is a
 *     Server Action refactor that adds back the `headers` arg and silently
 *     fails with `SERVER_ONLY_PROPERTY`.
 *   - The `verifyApiKey` response shape carries `referenceId` and decoded
 *     `permissions.scope` exactly as the route's `handleApiKeyMcp` consumes them.
 *   - `lib/db/api-keys.ts::listUserApiKeys` reads what the plugin writes — pins
 *     the plugin's storage column names (`referenceId`, `permissions` as a JSON
 *     string, `start`) against our decoder.
 *
 * Runs on the per-test-database harness booted by the case-store testcontainer
 * `globalSetup`. The module functions reach the DB through the `getAuthDb`
 * singleton, pointed at the per-test pool via the `__setAuthDbForTests` seam.
 */

import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setAuthDbForTests, type AuthDatabase } from "@/lib/auth/db";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { NOVA_API_KEY_PREFIX } from "@/lib/auth-public";
import { AUTH_TABLE_NAMES } from "@/lib/auth-schema-shared";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";

const TEST_SECRET = "x".repeat(32);
const TEST_USER_ID = "user-integration-test";

const dbHandle = setupPerTestDatabase({ databaseNamePrefix: "auth_apikey_" });

/**
 * Mirrors the api-key plugin config in `lib/auth.ts` (the production-shape mount
 * the route actually exercises), plus the shared table-name map so the plugin
 * writes to the migrated `auth_apikey` table. Factored out so the inferred
 * return type carries the `auth.api.createApiKey` augmentation.
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
			apiKey({
				defaultPrefix: NOVA_API_KEY_PREFIX,
				defaultKeyLength: 32,
				startingCharactersConfig: {
					shouldStore: true,
					charactersLength: NOVA_API_KEY_PREFIX.length + 6,
				},
				requireName: true,
				enableMetadata: false,
				enableSessionForAPIKeys: false,
				storage: "database",
				rateLimit: { enabled: false },
				keyExpiration: {
					defaultExpiresIn: 365 * 24 * 60 * 60,
					minExpiresIn: 1,
					maxExpiresIn: 36500,
				},
				references: "user",
				schema: { apikey: { modelName: AUTH_TABLE_NAMES.apikey } },
			}),
		],
	});
}

async function seedUser(banned = false): Promise<void> {
	await dbHandle.pool.query(
		`INSERT INTO auth_user (id, name, email, "emailVerified", banned, "createdAt", "updatedAt")
		 VALUES ($1, 'Integration test user', 'user@dimagi.com', true, $2, now(), now())`,
		[TEST_USER_ID, banned],
	);
}

describe("api-key integration", () => {
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
		auth = createTestAuth(dbHandle.pool);
	});

	afterEach(() => {
		__setAuthDbForTests(null);
	});

	it("mint + verify round-trip works against the real plugin (server-only mode)", async () => {
		await seedUser();

		/* Mint in server-only mode (no headers, explicit userId) — the exact
		 * shape `mintApiKey` Server Action uses. */
		const created = await auth.api.createApiKey({
			body: {
				name: "integration test key",
				expiresIn: 365 * 24 * 60 * 60,
				permissions: { scope: ["nova.read", "nova.write"] },
				userId: TEST_USER_ID,
			},
		});

		expect(created.id).toBeTruthy();
		expect(created.key).toMatch(new RegExp(`^${NOVA_API_KEY_PREFIX}`));
		expect(created.start).toMatch(new RegExp(`^${NOVA_API_KEY_PREFIX}`));
		/* The Server Actions' `BETTER_AUTH_ID_PATTERN = /^[a-zA-Z0-9]{32}$/`
		 * regex accepts the adapter-generated id, so revoke/edit on a real key
		 * must pass validation. A plugin/adapter version that emits a different
		 * id shape trips here BEFORE the regex rejects real keys in production. */
		expect(created.id).toMatch(/^[a-zA-Z0-9]{32}$/);

		/* Permissions round-trip: what we sent should be what the verify
		 * response surfaces (decoded back from the plugin's manual JSON.stringify
		 * on write + safeJSONParse on read). */
		const verified = await auth.api.verifyApiKey({
			body: { key: created.key },
		});
		expect(verified.valid).toBe(true);
		expect(verified.error).toBeNull();
		expect(verified.key?.referenceId).toBe(TEST_USER_ID);
		expect(verified.key?.permissions).toEqual({
			scope: ["nova.read", "nova.write"],
		});

		/* Read via the public helper — pins our decoder against the plugin's
		 * actual storage shape. */
		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys(TEST_USER_ID);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			keyId: created.id,
			name: "integration test key",
			scopes: ["nova.read", "nova.write"],
		});
		expect(rows[0]?.displayPrefix).toBe(created.start);

		/* Delete the row directly (sidestepping `auth.api.deleteApiKey`'s
		 * `sessionMiddleware`, which expects a cookie-bearing request) then
		 * re-verify to confirm it's gone. The plugin emits `INVALID_API_KEY`
		 * (not `KEY_NOT_FOUND`) for "no row matches the hashed bearer"; the
		 * route's `mapApiKeyErrorCode` collapses both into "api key invalid". */
		await dbHandle.pool.query(`DELETE FROM auth_apikey WHERE id = $1`, [
			created.id,
		]);
		const afterDelete = await auth.api.verifyApiKey({
			body: { key: created.key },
		});
		expect(afterDelete.valid).toBe(false);
		expect(afterDelete.error?.code).toBe("INVALID_API_KEY");
	});

	it("mintApiKey rejects `permissions` with SERVER_ONLY_PROPERTY when `headers` is passed", async () => {
		await seedUser();
		/* Passing both `headers` and `permissions` makes the plugin's
		 * `isClientRequest` check fire and reject `permissions` as a server-only
		 * property. If the plugin softens this rule (or our config disables it),
		 * the production "no headers, explicit userId" pattern needs re-eval. */
		await expect(
			auth.api.createApiKey({
				body: {
					name: "should-fail",
					expiresIn: 365 * 24 * 60 * 60,
					permissions: { scope: ["nova.read", "nova.write"] },
					userId: TEST_USER_ID,
				},
				headers: new Headers(),
			}),
		).rejects.toMatchObject({ body: { code: "SERVER_ONLY_PROPERTY" } });
	});

	it("verifyApiKey returns `valid: false` for a stale / non-existent key", async () => {
		const result = await auth.api.verifyApiKey({
			body: { key: `${NOVA_API_KEY_PREFIX}nonexistent-key-value-here` },
		});

		expect(result.valid).toBe(false);
		expect(result.key).toBeNull();
		expect(result.error?.code).toBe("INVALID_API_KEY");
	});

	it("isUserActive returns true for an existing non-banned user, false for a banned user", async () => {
		await seedUser();
		const { isUserActive } = await import("../api-keys");

		expect(await isUserActive(TEST_USER_ID)).toBe(true);

		await dbHandle.pool.query(
			`UPDATE auth_user SET banned = true WHERE id = $1`,
			[TEST_USER_ID],
		);
		expect(await isUserActive(TEST_USER_ID)).toBe(false);
	});

	it("isUserActive returns false for a missing user (deleted-account case)", async () => {
		const { isUserActive } = await import("../api-keys");
		expect(await isUserActive("user-that-was-deleted")).toBe(false);
	});

	it("isUserActive treats an expired temp ban as active and a future ban as inactive", async () => {
		await seedUser();
		const { isUserActive } = await import("../api-keys");

		await dbHandle.pool.query(
			`UPDATE auth_user SET banned = true, "banExpires" = now() - interval '1 hour' WHERE id = $1`,
			[TEST_USER_ID],
		);
		expect(await isUserActive(TEST_USER_ID)).toBe(true);

		await dbHandle.pool.query(
			`UPDATE auth_user SET "banExpires" = now() + interval '1 hour' WHERE id = $1`,
			[TEST_USER_ID],
		);
		expect(await isUserActive(TEST_USER_ID)).toBe(false);
	});

	it("listUserApiKeys falls back to empty scopes on malformed permissions", async () => {
		await seedUser();
		const created = await auth.api.createApiKey({
			body: { name: "malformed", userId: TEST_USER_ID },
		});
		await dbHandle.pool.query(
			`UPDATE auth_apikey SET permissions = 'not-json' WHERE id = $1`,
			[created.id],
		);

		const { listUserApiKeys } = await import("../api-keys");
		const rows = await listUserApiKeys(TEST_USER_ID);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.scopes).toEqual([]);
	});

	it("countUserApiKeys counts all of a user's keys", async () => {
		await seedUser();
		const { countUserApiKeys } = await import("../api-keys");
		expect(await countUserApiKeys(TEST_USER_ID)).toBe(0);

		await auth.api.createApiKey({ body: { name: "k1", userId: TEST_USER_ID } });
		await auth.api.createApiKey({ body: { name: "k2", userId: TEST_USER_ID } });
		expect(await countUserApiKeys(TEST_USER_ID)).toBe(2);
	});
});
