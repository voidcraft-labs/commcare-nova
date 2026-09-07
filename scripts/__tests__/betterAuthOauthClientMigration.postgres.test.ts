import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	finalizeBetterAuth17OauthClients,
	migrateBetterAuthOauthClients,
	scanBetterAuthOauthClients,
} from "@/scripts/lib/betterAuthOauthClientMigration";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "better_auth_oauth_client_",
	prepareTemplate: async (_db, pool) => {
		const { runMigrations } = await getMigrations(authMigrateOptions(pool));
		await runMigrations();
	},
});

async function seedClient(
	id: string,
	redirectUri: string | string[],
	applicationType: "native" | "web" | null = null,
): Promise<void> {
	await dbHandle.pool.query(
		`INSERT INTO public.auth_oauth_client
			(id, "clientId", "redirectUris", "applicationType", "tokenEndpointAuthMethod", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3::jsonb, $4, 'none', now(), now())`,
		[
			id,
			`client-${id}`,
			JSON.stringify(
				typeof redirectUri === "string" ? [redirectUri] : redirectUri,
			),
			applicationType,
		],
	);
}

describe("Better Auth OAuth client scan-then-migrate", () => {
	it("backfills native and web clients, links resources, and protects rolling inserts", async () => {
		await dbHandle.pool.query(
			`ALTER TABLE public.auth_oauth_client
			 ADD COLUMN "public" boolean,
			 ADD COLUMN "type" text`,
		);
		await seedClient("native-a", [
			"http://127.0.0.1:8123/callback",
			"http://[::1]:8123/callback",
		]);
		await seedClient("web-a", "https://example.com/callback");

		expect(await scanBetterAuthOauthClients(dbHandle.pool)).toMatchObject({
			state: "legacy-ready",
			clientCount: 2,
			pendingClients: 2,
			pendingClientCredentialsScopes: 2,
		});
		const migrated = await migrateBetterAuthOauthClients(dbHandle.pool);
		expect(migrated).toMatchObject({
			state: "current",
			nativeClients: 1,
			webClients: 1,
			pendingClients: 0,
			pendingClientCredentialsScopes: 0,
			resourceRegistered: true,
			linkedClients: 2,
			unlinkedClients: 0,
			rollingDeployTriggerCount: 2,
		});

		// A still-serving 1.6 revision omits applicationType. The trigger
		// supplies it until every request is on the 1.7 image.
		await seedClient("native-b", "http://localhost:9456/callback");
		const inserted = await dbHandle.pool.query<{
			applicationType: string;
			clientCredentialsScopes: string[];
		}>(
			`SELECT "applicationType", "clientCredentialsScopes"
			 FROM public.auth_oauth_client WHERE id = $1`,
			["native-b"],
		);
		expect(inserted.rows[0]?.applicationType).toBe("native");
		expect(inserted.rows[0]?.clientCredentialsScopes).toEqual([]);
		const rollingLink = await dbHandle.pool.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count
			 FROM public.auth_oauth_client_resource
			 WHERE "clientId" = $1 AND "resourceId" = $2`,
			["client-native-b", "https://mcp.commcare.app/mcp"],
		);
		expect(rollingLink.rows[0]?.count).toBe(1);

		const finalized = await finalizeBetterAuth17OauthClients(dbHandle.pool);
		expect(finalized).toMatchObject({
			state: "current",
			legacyPublicColumnPresent: false,
			legacyTypeColumnPresent: false,
			rollingDeployTriggerCount: 0,
		});
		expect(await finalizeBetterAuth17OauthClients(dbHandle.pool)).toEqual(
			finalized,
		);
	});

	it.each([
		{
			label: "an unclassified custom scheme",
			redirects: ["com.example.app:/callback"],
		},
		{ label: "an empty redirect list", redirects: [] },
		{
			label: "mixed native and web redirects",
			redirects: [
				"http://localhost:8123/callback",
				"https://example.com/callback",
			],
		},
		{
			label: "a lookalike loopback host",
			redirects: ["http://localhost.example.com/callback"],
		},
	])(
		"refuses $label before changing clients or registering resources",
		async ({ redirects }) => {
			await seedClient("invalid", redirects);
			const before = await dbHandle.pool.query(
				`SELECT * FROM auth_oauth_client`,
			);
			expect(await scanBetterAuthOauthClients(dbHandle.pool)).toMatchObject({
				state: "blocked",
				unclassifiableClients: 1,
			});
			await expect(
				migrateBetterAuthOauthClients(dbHandle.pool),
			).rejects.toThrow(/cannot be classified safely/);
			expect(
				(await dbHandle.pool.query(`SELECT * FROM auth_oauth_client`)).rows,
			).toEqual(before.rows);
			expect(
				(await dbHandle.pool.query(`SELECT * FROM auth_oauth_resource`)).rows,
			).toEqual([]);
			expect(
				(await dbHandle.pool.query(`SELECT * FROM auth_oauth_client_resource`))
					.rows,
			).toEqual([]);
		},
	);

	it("preserves an explicit native type, nonempty scopes and all rows on a current retry", async () => {
		await seedClient("native-current", "com.example.app:/callback", "native");
		await dbHandle.pool.query(
			`UPDATE auth_oauth_client SET "clientCredentialsScopes" = '["app:read"]'::jsonb`,
		);
		await migrateBetterAuthOauthClients(dbHandle.pool);
		const clients = await dbHandle.pool.query(
			`SELECT * FROM auth_oauth_client`,
		);
		const resources = await dbHandle.pool.query(
			`SELECT * FROM auth_oauth_resource`,
		);
		const links = await dbHandle.pool.query(
			`SELECT * FROM auth_oauth_client_resource`,
		);
		expect(clients.rows).toMatchObject([
			{ applicationType: "native", clientCredentialsScopes: ["app:read"] },
		]);
		expect(resources.rows).toHaveLength(1);
		expect(links.rows).toHaveLength(1);
		expect((await migrateBetterAuthOauthClients(dbHandle.pool)).state).toBe(
			"current",
		);
		expect(
			(await dbHandle.pool.query(`SELECT * FROM auth_oauth_client`)).rows,
		).toEqual(clients.rows);
		expect(
			(await dbHandle.pool.query(`SELECT * FROM auth_oauth_resource`)).rows,
		).toEqual(resources.rows);
		expect(
			(await dbHandle.pool.query(`SELECT * FROM auth_oauth_client_resource`))
				.rows,
		).toEqual(links.rows);
	});

	it("rolls resource registration, links and bridge installation back when client backfill fails", async () => {
		await dbHandle.pool.query(
			`ALTER TABLE auth_oauth_client ADD COLUMN "public" boolean, ADD COLUMN "type" text`,
		);
		await seedClient("native", "http://localhost:8123/callback");
		const before = await dbHandle.pool.query(`SELECT * FROM auth_oauth_client`);
		await dbHandle.pool.query(`CREATE FUNCTION refuse_client_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'refused client backfill'; END $$;
			CREATE TRIGGER refuse_client_backfill BEFORE UPDATE ON auth_oauth_client
			FOR EACH ROW EXECUTE FUNCTION refuse_client_backfill()`);
		await expect(migrateBetterAuthOauthClients(dbHandle.pool)).rejects.toThrow(
			"refused client backfill",
		);
		expect(
			(await dbHandle.pool.query(`SELECT * FROM auth_oauth_client`)).rows,
		).toEqual(before.rows);
		expect(
			(await dbHandle.pool.query(`SELECT * FROM auth_oauth_resource`)).rows,
		).toEqual([]);
		expect(
			(await dbHandle.pool.query(`SELECT * FROM auth_oauth_client_resource`))
				.rows,
		).toEqual([]);
		expect(await scanBetterAuthOauthClients(dbHandle.pool)).toMatchObject({
			state: "legacy-ready",
			rollingDeployTriggerCount: 0,
		});
		await dbHandle.pool.query(
			`DROP TRIGGER refuse_client_backfill ON auth_oauth_client`,
		);
		expect(await migrateBetterAuthOauthClients(dbHandle.pool)).toMatchObject({
			state: "current",
			linkedClients: 1,
			rollingDeployTriggerCount: 2,
		});
	});
});
