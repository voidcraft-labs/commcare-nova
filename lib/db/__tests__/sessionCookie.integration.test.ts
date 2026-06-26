/**
 * Session-cookie contract test, against a real Postgres (the testcontainer).
 *
 * This is the auth-boundary guard. Every production login outage we've shipped
 * lived at the dependency seam between Better Auth, its storage adapter, and
 * `better-call`'s cookie signing. None of those are covered by the unit suite,
 * which mocks `auth.api.*` at the boundary.
 *
 * It pins the exact thing the Playwright smoke suite (and the documented
 * "mint a cookie from a session row" recipe) depends on: a cookie forged by
 * `e2e/lib/session.ts::signSessionCookie` is accepted by `auth.api.getSession`
 * running on the SAME adapter stack production uses — Better Auth's built-in
 * Kysely adapter over the shared Postgres pool, with the SAME schema config
 * (`authMigrateOptions`, the table-name map shared with `lib/auth.ts`). If a
 * better-auth / better-call / adapter bump changes session lookup or cookie
 * signing, this fails loudly here — not silently in prod, not deep inside a
 * Playwright timeout.
 *
 * Runs on the per-test-database harness (a fresh Postgres database per test, the
 * `db.transaction()`-safe path) booted by the case-store testcontainer
 * `globalSetup`, so it needs no emulator and no ADC.
 */
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { beforeEach, describe, expect, it } from "vitest";
import { signSessionCookie } from "@/e2e/lib/session";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";

const TEST_SECRET = "x".repeat(32);
const TEST_USER_ID = "session-contract-user";
const TEST_EMAIL = "session-contract@dimagi.com";
const SESSION_COOKIE = "better-auth.session_token";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "auth_session_contract_",
});

/**
 * A Better Auth instance over the SAME adapter + schema stack production wires
 * up — the built-in Kysely adapter on the per-test pool, with the shared
 * `authMigrateOptions` config — so the session read path under test is the real
 * one. Only `secret` (to match the cookie signer) and `baseURL` are overridden.
 */
function createTestAuth(pool: typeof dbHandle.pool) {
	return betterAuth({
		...authMigrateOptions(pool),
		secret: TEST_SECRET,
		baseURL: "http://localhost:3000",
	});
}

function cookieHeader(value: string): Headers {
	return new Headers({ cookie: `${SESSION_COOKIE}=${value}` });
}

async function seedUser(): Promise<void> {
	await dbHandle.pool.query(
		`INSERT INTO auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3, true, now(), now())`,
		[TEST_USER_ID, "Session contract user", TEST_EMAIL],
	);
}

/** Write a live session row and return its (random) token. */
async function seedSession(expiresAt: Date): Promise<string> {
	const token = `tok-${TEST_USER_ID}-${expiresAt.getTime()}`;
	await dbHandle.pool.query(
		`INSERT INTO auth_session (id, token, "userId", "expiresAt", "createdAt", "updatedAt", "userAgent")
		 VALUES ($1, $2, $3, $4, now(), now(), 'contract-test')`,
		[`sess-${token}`, token, TEST_USER_ID, expiresAt],
	);
	return token;
}

describe("session-cookie contract", () => {
	beforeEach(async () => {
		const { runMigrations } = await getMigrations(
			authMigrateOptions(dbHandle.pool),
		);
		await runMigrations();
		await runAuthAppMigrations(dbHandle.db);
		await seedUser();
	});

	it("accepts a cookie forged by signSessionCookie() and returns the user", async () => {
		const auth = createTestAuth(dbHandle.pool);
		const token = await seedSession(
			new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
		);
		const cookie = signSessionCookie(token, TEST_SECRET);

		const session = await auth.api.getSession({
			headers: cookieHeader(cookie),
		});

		expect(session).not.toBeNull();
		expect(session?.user.id).toBe(TEST_USER_ID);
		expect(session?.user.email).toBe(TEST_EMAIL);
	});

	it("rejects a cookie signed with the wrong secret (signature is verified)", async () => {
		const auth = createTestAuth(dbHandle.pool);
		const token = await seedSession(
			new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
		);
		const forged = signSessionCookie(token, "not-the-server-secret");

		const session = await auth.api.getSession({
			headers: cookieHeader(forged),
		});

		expect(session).toBeNull();
	});

	it("rejects an expired session row", async () => {
		const auth = createTestAuth(dbHandle.pool);
		const token = await seedSession(new Date(Date.now() - 60_000));

		const session = await auth.api.getSession({
			headers: cookieHeader(signSessionCookie(token, TEST_SECRET)),
		});

		expect(session).toBeNull();
	});
});
