import { type Kysely, sql, type Transaction } from "kysely";
import { describe, expect, test } from "vitest";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { AUTH_TABLE_NAMES } from "@/lib/auth-schema-shared";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	convergeDatabasePrivileges,
	type DatabasePrivilegeRoleConfig,
} from "../privilegeConvergence";

const h = setupPerTestDatabase({
	databaseNamePrefix: "privilege_convergence_",
});

async function createAuthSchema(db: Kysely<unknown>): Promise<void> {
	for (const table of Object.values(AUTH_TABLE_NAMES)) {
		await sql`
			CREATE TABLE public.${sql.id(table)} (id text PRIMARY KEY)
		`.execute(db);
	}
	await runAuthAppMigrations(db);
}

async function asRole<T>(
	db: Kysely<unknown>,
	role: string,
	body: (tx: Transaction<unknown>) => Promise<T>,
): Promise<T> {
	return db.transaction().execute(async (tx) => {
		await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(tx);
		return body(tx);
	});
}

async function createRoles(
	db: Kysely<unknown>,
): Promise<DatabasePrivilegeRoleConfig> {
	const suffix = Math.random().toString(36).slice(2, 10);
	const config = {
		migrationRole: `nova_migrate_${suffix}`,
		runtimeRole: `nova_runtime_${suffix}`,
		rolloutRole: `nova_rollout_${suffix}`,
	};
	for (const role of [
		config.migrationRole,
		config.runtimeRole,
		config.rolloutRole,
	]) {
		await sql`CREATE ROLE ${sql.id(role)} NOLOGIN`.execute(db);
	}
	await sql`
		GRANT ${sql.id(config.runtimeRole)} TO ${sql.id(config.migrationRole)}
	`.execute(db);
	return config;
}

async function dropRoles(
	db: Kysely<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	await sql`
		REASSIGN OWNED BY ${sql.id(config.migrationRole)},
			${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
		TO CURRENT_USER
	`.execute(db);
	for (const role of [
		config.migrationRole,
		config.runtimeRole,
		config.rolloutRole,
	]) {
		await sql`DROP OWNED BY ${sql.id(role)}`.execute(db);
	}
	await sql`
		REVOKE ${sql.id(config.runtimeRole)} FROM ${sql.id(config.migrationRole)}
	`.execute(db);
	for (const role of [
		config.rolloutRole,
		config.migrationRole,
		config.runtimeRole,
	]) {
		await sql`DROP ROLE ${sql.id(role)}`.execute(db);
	}
}

describe("database privilege convergence", () => {
	test("converges owners and enforces runtime/rollout capability boundaries", async () => {
		await runCaseStoreMigrations(h.db);
		await createAuthSchema(h.db);
		const config = await createRoles(h.db);
		try {
			await convergeDatabasePrivileges(h.db, config);

			const owners = await sql<{ table_name: string; owner: string }>`
				SELECT class.relname AS table_name,
					pg_catalog.pg_get_userbyid(class.relowner) AS owner
				FROM pg_catalog.pg_class AS class
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = class.relnamespace
				WHERE namespace.nspname = 'public'
					AND class.relname IN ('cases', 'apps', 'auth_member',
						'deployment_rollouts')
			`.execute(h.db);
			expect(
				Object.fromEntries(
					owners.rows.map((row) => [row.table_name, row.owner]),
				),
			).toEqual({
				apps: config.migrationRole,
				auth_member: config.migrationRole,
				cases: config.runtimeRole,
				deployment_rollouts: config.migrationRole,
			});

			await asRole(h.db, config.runtimeRole, async (tx) => {
				await sql`INSERT INTO public.auth_user (id) VALUES ('runtime-user')`.execute(
					tx,
				);
				await sql`ALTER TABLE public.cases ADD COLUMN privilege_probe boolean`.execute(
					tx,
				);
				await sql`ALTER TABLE public.cases DROP COLUMN privilege_probe`.execute(
					tx,
				);
			});
			await expect(
				asRole(h.db, config.runtimeRole, async (tx) => {
					await sql`ALTER TABLE public.apps ADD COLUMN forbidden_probe boolean`.execute(
						tx,
					);
				}),
			).rejects.toMatchObject({ code: "42501" });

			await asRole(h.db, config.rolloutRole, async (tx) => {
				await sql`
					UPDATE public.lookup_reference_compatibility
					SET continuous_registry_traffic_since = clock_timestamp(),
						updated_at = clock_timestamp()
					WHERE id = 1
				`.execute(tx);
			});
			await expect(
				asRole(h.db, config.rolloutRole, async (tx) => {
					await sql`
						UPDATE public.lookup_reference_compatibility
						SET minimum_writer_version = minimum_writer_version + 1
						WHERE id = 1
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				asRole(h.db, config.rolloutRole, async (tx) => {
					await sql`SELECT id FROM public.apps LIMIT 1`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });

			await asRole(h.db, config.migrationRole, async (tx) => {
				await sql`ALTER TABLE public.apps ADD COLUMN migration_probe boolean`.execute(
					tx,
				);
				await sql`ALTER TABLE public.apps DROP COLUMN migration_probe`.execute(
					tx,
				);
			});
		} finally {
			await dropRoles(h.db, config);
		}
	});
});
