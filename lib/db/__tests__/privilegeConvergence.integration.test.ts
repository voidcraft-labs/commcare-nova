import { getMigrations } from "better-auth/db/migration";
import {
	Kysely,
	PostgresDialect,
	type PostgresPool,
	sql,
	type Transaction,
} from "kysely";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { runAuthAppMigrations } from "@/lib/auth/migrate";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import {
	CASE_RUNTIME_SCHEMA,
	DATABASE_CONNECTION_OPTIONS,
} from "@/lib/case-store/postgres/connection";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	convergeDatabasePrivileges,
	type DatabasePrivilegeRoleConfig,
} from "../privilegeConvergence";

const h = setupPerTestDatabase({
	databaseNamePrefix: "privilege_convergence_",
});

async function asRole<T>(
	db: Kysely<unknown>,
	role: string,
	body: (tx: Transaction<unknown>) => Promise<T>,
): Promise<T> {
	return db.transaction().execute(async (tx) => {
		await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(tx);
		await sql`
			SET LOCAL search_path TO public, ${sql.id(CASE_RUNTIME_SCHEMA)}
		`.execute(tx);
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
	};
	for (const role of [config.migrationRole, config.runtimeRole]) {
		await sql`CREATE ROLE ${sql.id(role)} NOLOGIN`.execute(db);
	}
	await sql`
		GRANT ${sql.id(config.runtimeRole)} TO ${sql.id(config.migrationRole)}
	`.execute(db);
	await sql`
		ALTER DATABASE ${sql.id(h.databaseName)} OWNER TO ${sql.id(config.migrationRole)}
	`.execute(db);
	return config;
}

async function createMigrationDatabase(
	config: DatabasePrivilegeRoleConfig,
): Promise<{ db: Kysely<unknown>; pool: Pool }> {
	const pool = new Pool({
		connectionString: h.uri,
		options: DATABASE_CONNECTION_OPTIONS,
		max: 1,
	});
	const db = new Kysely<unknown>({
		dialect: new PostgresDialect({
			pool: pool as unknown as PostgresPool,
		}),
	});
	await sql`SET ROLE ${sql.id(config.migrationRole)}`.execute(db);
	return { db, pool };
}

async function dropRoles(
	db: Kysely<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	const current = await sql<{ name: string }>`
		SELECT current_user AS name
	`.execute(db);
	const currentRole = current.rows[0]?.name;
	if (!currentRole) throw new Error("Current role query returned no row.");
	await sql`
		ALTER DATABASE ${sql.id(h.databaseName)} OWNER TO ${sql.id(currentRole)}
	`.execute(db);
	await sql`
		REASSIGN OWNED BY ${sql.id(config.migrationRole)},
			${sql.id(config.runtimeRole)} TO ${sql.id(currentRole)}
	`.execute(db);
	for (const role of [config.migrationRole, config.runtimeRole]) {
		await sql`DROP OWNED BY ${sql.id(role)}`.execute(db);
	}
	await sql`
		REVOKE ${sql.id(config.runtimeRole)} FROM ${sql.id(config.migrationRole)}
	`.execute(db);
	for (const role of [config.migrationRole, config.runtimeRole]) {
		await sql`DROP ROLE ${sql.id(role)}`.execute(db);
	}
}

describe("database privilege convergence", () => {
	test("converges from the database-owning migration identity to the two-role boundary", async () => {
		const config = await createRoles(h.db);
		const migration = await createMigrationDatabase(config);
		try {
			await runCaseStoreMigrations(migration.db);
			const { runMigrations } = await getMigrations(
				authMigrateOptions(migration.pool),
			);
			await runMigrations();
			await runAuthAppMigrations(migration.db);

			await convergeDatabasePrivileges(migration.db, config);
			// Convergence is an every-deploy operation, including after `cases` has
			// already moved and is runtime-owned.
			await convergeDatabasePrivileges(migration.db, config);

			const identity = await sql<{ current_user: string }>`
				SELECT current_user
			`.execute(migration.db);
			expect(identity.rows[0]?.current_user).toBe(config.migrationRole);
			const ownership = await sql<{
				database_owner: string;
				public_schema_owner: string;
			}>`
				SELECT pg_catalog.pg_get_userbyid(database.datdba) AS database_owner,
					pg_catalog.pg_get_userbyid(namespace.nspowner)
						AS public_schema_owner
				FROM pg_catalog.pg_database AS database
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.nspname = 'public'
				WHERE database.datname = pg_catalog.current_database()
			`.execute(migration.db);
			expect(ownership.rows[0]).toEqual({
				database_owner: config.migrationRole,
				public_schema_owner: "pg_database_owner",
			});

			const owners = await sql<{
				table_name: string;
				owner: string;
				schema_name: string;
			}>`
				SELECT class.relname AS table_name,
					pg_catalog.pg_get_userbyid(class.relowner) AS owner,
					namespace.nspname AS schema_name
				FROM pg_catalog.pg_class AS class
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = class.relnamespace
				WHERE namespace.nspname IN ('public', ${CASE_RUNTIME_SCHEMA})
					AND class.relname IN ('cases', 'apps', 'auth_member',
						'deployment_rollouts')
			`.execute(h.db);
			expect(
				Object.fromEntries(
					owners.rows.map((row) => [
						row.table_name,
						{ owner: row.owner, schema: row.schema_name },
					]),
				),
			).toEqual({
				apps: { owner: config.migrationRole, schema: "public" },
				auth_member: { owner: config.migrationRole, schema: "public" },
				cases: {
					owner: config.runtimeRole,
					schema: CASE_RUNTIME_SCHEMA,
				},
				deployment_rollouts: {
					owner: config.migrationRole,
					schema: "public",
				},
			});

			await asRole(h.db, config.runtimeRole, async (tx) => {
				const grants = await sql<{
					can_select_auth: boolean;
					can_insert_auth: boolean;
					can_update_auth: boolean;
					can_delete_auth: boolean;
					can_create_public: boolean;
					can_create_case_schema: boolean;
				}>`
					SELECT
						pg_catalog.has_table_privilege(
							current_user, 'public.auth_user', 'SELECT'
						) AS can_select_auth,
						pg_catalog.has_table_privilege(
							current_user, 'public.auth_user', 'INSERT'
						) AS can_insert_auth,
						pg_catalog.has_table_privilege(
							current_user, 'public.auth_user', 'UPDATE'
						) AS can_update_auth,
						pg_catalog.has_table_privilege(
							current_user, 'public.auth_user', 'DELETE'
						) AS can_delete_auth,
						pg_catalog.has_schema_privilege(
							current_user, 'public', 'CREATE'
						) AS can_create_public,
						pg_catalog.has_schema_privilege(
							current_user, ${CASE_RUNTIME_SCHEMA}, 'CREATE'
						) AS can_create_case_schema
				`.execute(tx);
				expect(grants.rows[0]).toEqual({
					can_select_auth: true,
					can_insert_auth: true,
					can_update_auth: true,
					can_delete_auth: true,
					can_create_public: false,
					can_create_case_schema: true,
				});
				await sql`SELECT count(*) FROM cases`.execute(tx);
				await sql`
					CREATE INDEX privilege_probe_idx ON cases (case_id)
				`.execute(tx);
				await sql`
					DROP INDEX ${sql.id(CASE_RUNTIME_SCHEMA)}.privilege_probe_idx
				`.execute(tx);
				await sql`
					SELECT id FROM public.lookup_reference_compatibility
				`.execute(tx);
			});

			await expect(
				asRole(h.db, config.runtimeRole, async (tx) => {
					await sql`
						CREATE TABLE public.forbidden_runtime_table (id integer)
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				asRole(h.db, config.runtimeRole, async (tx) => {
					await sql`
						ALTER TABLE public.apps ADD COLUMN forbidden_probe boolean
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				asRole(h.db, config.runtimeRole, async (tx) => {
					await sql`
						UPDATE public.lookup_reference_compatibility
						SET continuous_registry_traffic_since = clock_timestamp()
						WHERE id = 1
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				asRole(h.db, config.runtimeRole, async (tx) => {
					await sql`
						SELECT id FROM public.deployment_rollouts LIMIT 1
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				asRole(h.db, config.runtimeRole, async (tx) => {
					await sql`
						SELECT public.nova_lock_deployment_cutover_gate()
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });

			await asRole(h.db, config.runtimeRole, async (tx) => {
				await sql`
					CREATE VIEW ${sql.id(CASE_RUNTIME_SCHEMA)}.runtime_shadow AS
					SELECT case_id FROM cases
				`.execute(tx);
			});
			await expect(
				convergeDatabasePrivileges(migration.db, config),
			).rejects.toMatchObject({ code: "schema_inventory_drift" });
			await asRole(h.db, config.runtimeRole, async (tx) => {
				await sql`
					DROP VIEW ${sql.id(CASE_RUNTIME_SCHEMA)}.runtime_shadow
				`.execute(tx);
			});

			await sql`
				ALTER TABLE public.apps ADD COLUMN migration_probe boolean
			`.execute(migration.db);
			await sql`
				ALTER TABLE public.apps DROP COLUMN migration_probe
			`.execute(migration.db);
		} finally {
			await migration.db.destroy();
			await dropRoles(h.db, config);
		}
	});
});
