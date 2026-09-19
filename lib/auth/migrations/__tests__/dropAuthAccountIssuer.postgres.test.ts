import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";

const GOOGLE_ISSUER = "https://accounts.google.com";

const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_account_issuer_drop_",
	establishLocalMigrationAuthority: true,
	// The shape production holds once the 1.7 bridge is retired: every schema
	// owner ahead of Nova's auth migrations has run, and `issuer` is a nullable
	// column holding a value for accounts Better Auth 1.7.0 to 1.7.2 created.
	prepareTemplate: async (db, pool) => {
		await runCaseStoreMigrations(db);
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
		await sql`ALTER TABLE public.auth_account ADD COLUMN issuer text`.execute(
			db,
		);
	},
});

async function insertGoogleAccount(id: string, issuer?: string): Promise<void> {
	await database.pool.query(
		`INSERT INTO public.auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ($1, $1, $1 || '@dimagi.com', true, now(), now())`,
		[`user-${id}`],
	);
	await database.pool.query(
		`INSERT INTO public.auth_account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
		 VALUES ($1, $2, 'google', $3, now(), now())`,
		[id, `google-sub-${id}`, `user-${id}`],
	);
	if (issuer !== undefined)
		await database.pool.query(
			"UPDATE public.auth_account SET issuer = $1 WHERE id = $2",
			[issuer, id],
		);
}

async function accountColumns(): Promise<string[]> {
	const columns = await database.pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = 'auth_account'`,
	);
	return columns.rows.map((row) => row.column_name);
}

it("removes the column and keeps every account, and Better Auth still serves and stores", async () => {
	await insertGoogleAccount("before", GOOGLE_ISSUER);
	expect(await accountColumns()).toContain("issuer");

	await runAuthAppMigrations(database.db);

	expect(await accountColumns()).not.toContain("issuer");
	const auth = betterAuth(authMigrateOptions(database.pool));
	await expect(
		auth.api.getSession({ headers: new Headers() }),
	).resolves.toBeNull();
	await insertGoogleAccount("after");
	const accounts = await database.pool.query<{ id: string }>(
		"SELECT id FROM public.auth_account ORDER BY id",
	);
	expect(accounts.rows.map((row) => row.id)).toEqual(["after", "before"]);
});
