import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { sql } from "kysely";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { up as installRollingDeployBridge } from "../20260829000000_better_auth_17_rolling_deploy_bridge";
import { up } from "../20260919000000_retire_better_auth_17_bridge";

const GOOGLE_ISSUER = "https://accounts.google.com";

/** Better Auth awaits its startup schema check inside every endpoint, so one
 * session read answers whether it accepts this database. */
async function readSessionThroughBetterAuth(pool: Pool): Promise<unknown> {
	const auth = betterAuth(authMigrateOptions(pool));
	return auth.api.getSession({ headers: new Headers() });
}

async function insertGoogleAccount(pool: Pool, id: string): Promise<void> {
	await pool.query(
		`INSERT INTO public.auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt")
		 VALUES ($1, $1, $1 || '@dimagi.com', true, now(), now())`,
		[`user-${id}`],
	);
	await pool.query(
		`INSERT INTO public.auth_account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
		 VALUES ($1, $2, 'google', $3, now(), now())`,
		[id, `google-sub-${id}`, `user-${id}`],
	);
}

/** Every Nova-owned object the 1.6 → 1.7 bridge ever placed in a database. */
async function bridgeObjects(pool: Pool): Promise<string[]> {
	const found = await pool.query<{ name: string }>(
		`SELECT 'trigger ' || tgname AS name FROM pg_catalog.pg_trigger WHERE tgname LIKE 'nova\\_%\\_v17'
		 UNION ALL SELECT 'function ' || proname FROM pg_catalog.pg_proc WHERE proname LIKE 'nova\\_%\\_v17'
		 UNION ALL SELECT 'index ' || indexname FROM pg_catalog.pg_indexes WHERE indexname = 'auth_account_issuer_accountId_uidx'
		 UNION ALL SELECT 'column ' || column_name FROM information_schema.columns
		   WHERE table_schema = 'public' AND table_name = 'auth_oauth_client' AND column_name IN ('public', 'type')
		 ORDER BY name`,
	);
	return found.rows.map((row) => row.name);
}

describe("a database the Better Auth 1.6 → 1.7 upgrade migrated", () => {
	const h = setupPerTestDatabase({
		databaseNamePrefix: "retire_auth_bridge_",
		// The shape a database holds after that upgrade and before its finalizer:
		// Better Auth's tables, the required issuer column with its unique index,
		// the two retired OAuth client columns, and all three bridge triggers.
		prepareTemplate: async (db, pool) => {
			const { runMigrations } = await getMigrations(authMigrateOptions(pool));
			await runMigrations();
			await installRollingDeployBridge(db);
			await insertGoogleAccount(pool, "before");
			await sql`ALTER TABLE public.auth_account ADD COLUMN issuer text`.execute(
				db,
			);
			await sql`UPDATE public.auth_account SET issuer = ${GOOGLE_ISSUER}`.execute(
				db,
			);
			await sql`ALTER TABLE public.auth_account ALTER COLUMN issuer SET NOT NULL`.execute(
				db,
			);
			await sql`CREATE UNIQUE INDEX "auth_account_issuer_accountId_uidx" ON public.auth_account (issuer, "accountId")`.execute(
				db,
			);
			await sql`
				CREATE TRIGGER nova_auth_account_issuer_v17
				BEFORE INSERT ON public.auth_account
				FOR EACH ROW EXECUTE FUNCTION public.nova_fill_auth_account_issuer_v17()
			`.execute(db);
			await sql`
				ALTER TABLE public.auth_oauth_client
					ADD COLUMN "public" boolean,
					ADD COLUMN "type" text
			`.execute(db);
			await sql`
				CREATE TRIGGER nova_oauth_client_application_type_v17
				BEFORE INSERT ON public.auth_oauth_client
				FOR EACH ROW EXECUTE FUNCTION public.nova_fill_oauth_client_application_type_v17()
			`.execute(db);
			await sql`
				CREATE TRIGGER nova_oauth_client_resource_v17
				AFTER INSERT ON public.auth_oauth_client
				FOR EACH ROW EXECUTE FUNCTION public.nova_link_oauth_client_resource_v17()
			`.execute(db);
		},
	});

	it("is refused by Better Auth until the migration runs, then serves and stores accounts without an issuer", async () => {
		await expect(readSessionThroughBetterAuth(h.pool)).rejects.toThrow(
			/Database schema mismatch[\s\S]*auth_account\.issuer/,
		);

		await up(h.db);
		// The deploy runs Better Auth's own migrator next, against this same shape.
		const { runMigrations } = await getMigrations(authMigrateOptions(h.pool));
		await runMigrations();

		await expect(readSessionThroughBetterAuth(h.pool)).resolves.toBeNull();
		await insertGoogleAccount(h.pool, "after");
		const accounts = await h.pool.query<{ id: string; issuer: string | null }>(
			"SELECT id, issuer FROM public.auth_account ORDER BY id",
		);
		expect(accounts.rows).toEqual([
			{ id: "after", issuer: null },
			{ id: "before", issuer: GOOGLE_ISSUER },
		]);
		expect(await bridgeObjects(h.pool)).toEqual([]);
	});

	it("leaves an OAuth client exactly as its writer stored it", async () => {
		await up(h.db);

		// No application type and no resource link: the bridge would have filled
		// one and inserted the other.
		await h.pool.query(
			`INSERT INTO public.auth_oauth_client (id, "clientId", "redirectUris", "createdAt", "updatedAt")
			 VALUES ('client-row', 'client-after', '["http://localhost:8123/callback"]', now(), now())`,
		);
		const client = await h.pool.query<{ applicationType: string | null }>(
			`SELECT "applicationType" FROM public.auth_oauth_client WHERE "clientId" = 'client-after'`,
		);
		expect(client.rows).toEqual([{ applicationType: null }]);
		const links = await h.pool.query(
			`SELECT 1 FROM public.auth_oauth_client_resource WHERE "clientId" = 'client-after'`,
		);
		expect(links.rows).toEqual([]);
	});

	it("changes nothing when it runs a second time", async () => {
		await up(h.db);
		await up(h.db);
		await expect(readSessionThroughBetterAuth(h.pool)).resolves.toBeNull();
		expect(await bridgeObjects(h.pool)).toEqual([]);
	});
});

describe("a database that never held the bridge", () => {
	const h = setupPerTestDatabase({ databaseNamePrefix: "retire_auth_fresh_" });

	it("migrates before Better Auth has created its tables, and Better Auth accepts the result", async () => {
		await installRollingDeployBridge(h.db);
		await up(h.db);

		const { runMigrations } = await getMigrations(authMigrateOptions(h.pool));
		await runMigrations();
		await expect(readSessionThroughBetterAuth(h.pool)).resolves.toBeNull();
		expect(await bridgeObjects(h.pool)).toEqual([]);
	});
});
