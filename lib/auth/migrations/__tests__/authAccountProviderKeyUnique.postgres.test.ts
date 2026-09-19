import { getMigrations } from "better-auth/db/migration";
import { expect, it } from "vitest";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { up } from "../20260919010000_auth_account_provider_key_unique";

const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_account_key_",
	establishLocalMigrationAuthority: true,
	// Every schema owner that runs before Nova's own auth migrations.
	prepareTemplate: async (db, pool) => {
		await runCaseStoreMigrations(db);
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
	},
});

async function insertAccount(
	id: string,
	providerId: string,
	accountId: string,
): Promise<void> {
	await database.pool.query(
		`INSERT INTO public.auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ($1, $1, $1 || '@dimagi.com', true, now(), now())
		 ON CONFLICT (id) DO NOTHING`,
		[`user-${id}`],
	);
	await database.pool.query(
		`INSERT INTO public.auth_account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3, $4, now(), now())`,
		[id, accountId, providerId, `user-${id}`],
	);
}

it("lets one sign-in identity hold one account row, and the same id at another provider its own", async () => {
	await runAuthAppMigrations(database.db);
	await insertAccount("first", "google", "sub-1");
	await insertAccount("other-provider", "credential", "sub-1");

	await expect(insertAccount("second", "google", "sub-1")).rejects.toThrow(
		/auth_account_provider_account_unique/,
	);
	const rows = await database.pool.query<{ id: string }>(
		"SELECT id FROM public.auth_account ORDER BY id",
	);
	expect(rows.rows.map((row) => row.id)).toEqual(["first", "other-provider"]);
});

it("names the people already duplicated instead of failing on the index build", async () => {
	await insertAccount("first", "google", "sub-1");
	await insertAccount("second", "google", "sub-1");

	await expect(up(database.db)).rejects.toThrow(
		/more than one row for the same sign-in identity: google \/ sub-1 \(2 rows\)/,
	);
	const index = await database.pool.query(
		"SELECT 1 FROM pg_indexes WHERE indexname = 'auth_account_provider_account_unique'",
	);
	expect(index.rows).toEqual([]);
});
