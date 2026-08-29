import { getMigrations } from "better-auth/db/migration";
import { beforeEach, describe, expect, it } from "vitest";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	migrateBetterAuthOauthClients,
	scanBetterAuthOauthClients,
} from "@/scripts/lib/betterAuthOauthClientMigration";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "better_auth_oauth_client_",
});

beforeEach(async () => {
	const { runMigrations } = await getMigrations(
		authMigrateOptions(dbHandle.pool),
	);
	await runMigrations();
});

async function seedClient(
	id: string,
	redirectUri: string,
	applicationType: "native" | "web" | null = null,
): Promise<void> {
	await dbHandle.pool.query(
		`INSERT INTO public.auth_oauth_client
			(id, "clientId", "redirectUris", "applicationType", "tokenEndpointAuthMethod", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3::jsonb, $4, 'none', now(), now())`,
		[id, `client-${id}`, JSON.stringify([redirectUri]), applicationType],
	);
}

describe("Better Auth OAuth client scan-then-migrate", () => {
	it("backfills native and web clients and bridges legacy inserts", async () => {
		await seedClient("native-a", "http://127.0.0.1:8123/callback");
		await seedClient("web-a", "https://example.com/callback");

		expect(await scanBetterAuthOauthClients(dbHandle.pool)).toMatchObject({
			state: "legacy-ready",
			clientCount: 2,
			pendingClients: 2,
		});
		const migrated = await migrateBetterAuthOauthClients(dbHandle.pool);
		expect(migrated).toMatchObject({
			state: "current",
			nativeClients: 1,
			webClients: 1,
			pendingClients: 0,
		});

		// A still-serving 1.6 revision omits applicationType. The trigger
		// supplies it until every request is on the 1.7 image.
		await seedClient("native-b", "http://localhost:9456/callback");
		const inserted = await dbHandle.pool.query<{ applicationType: string }>(
			`SELECT "applicationType" FROM public.auth_oauth_client WHERE id = $1`,
			["native-b"],
		);
		expect(inserted.rows[0]?.applicationType).toBe("native");
	});

	it("fails closed when redirect URIs do not establish a safe client type", async () => {
		await seedClient("invalid", "com.example.app:/callback");

		const report = await scanBetterAuthOauthClients(dbHandle.pool);
		expect(report).toMatchObject({
			state: "blocked",
			unclassifiableClients: 1,
		});
		await expect(migrateBetterAuthOauthClients(dbHandle.pool)).rejects.toThrow(
			/cannot be classified safely/,
		);
	});

	it("accepts an already-current schema without rewriting it", async () => {
		await seedClient("native-current", "com.example.app:/callback", "native");
		expect((await migrateBetterAuthOauthClients(dbHandle.pool)).state).toBe(
			"current",
		);
	});
});
