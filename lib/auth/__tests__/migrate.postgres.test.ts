import { getMigrations } from "better-auth/db/migration";
import { beforeEach, expect, test } from "vitest";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import { MCP_RESOURCE_URL } from "@/lib/hostnames";

const database = setupPerTestDatabase({
	databaseNamePrefix: "auth_resource_init_",
	establishLocalMigrationAuthority: true,
});
beforeEach(async () => {
	await runCaseStoreMigrations(database.db);
	const { runMigrations } = await getMigrations(
		authMigrateOptions(database.pool),
	);
	await runMigrations();
});

test("fresh auth setup registers MCP without historical client repairs", async () => {
	await runAuthAppMigrations(database.db);
	const resource = await database.pool.query(
		"SELECT identifier, disabled FROM auth_oauth_resource",
	);
	expect(resource.rows).toEqual([
		{ identifier: MCP_RESOURCE_URL, disabled: false },
	]);
	const bridges = await database.pool.query(
		"SELECT tgname FROM pg_trigger WHERE tgname IN ('nova_oauth_client_resource_v17', 'nova_oauth_client_application_type_v17')",
	);
	expect(bridges.rows).toEqual([]);
});

test("repeated auth setup preserves the existing resource policy and creates no duplicates", async () => {
	await runAuthAppMigrations(database.db);
	await database.pool.query(
		'UPDATE auth_oauth_resource SET name = $1, "accessTokenTtl" = 123 WHERE identifier = $2',
		["Operator resource name", MCP_RESOURCE_URL],
	);
	await runAuthAppMigrations(database.db);
	const resource = await database.pool.query(
		'SELECT name, "accessTokenTtl" FROM auth_oauth_resource WHERE identifier = $1',
		[MCP_RESOURCE_URL],
	);
	expect(resource.rows).toEqual([
		{ name: "Operator resource name", accessTokenTtl: 123 },
	]);
});
