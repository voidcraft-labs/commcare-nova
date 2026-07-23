import { getMigrations } from "better-auth/db/migration";
import {
	Kysely,
	PostgresDialect,
	type PostgresPool,
	sql,
	type Transaction,
} from "kysely";
import { Client, Pool } from "pg";
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
	type DatabaseOwnerBootstrapConfig,
	executeDatabaseOwnerBootstrap,
	quoteIdentifier,
} from "@/scripts/infra/databaseOwnerBootstrap";
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
	const identity = await sql<{ name: string }>`
		SELECT current_user AS name
	`.execute(db);
	const bootstrapUser = identity.rows[0]?.name;
	if (!bootstrapUser) throw new Error("Current role query returned no row.");
	await sql`
		GRANT ${sql.id(config.migrationRole)} TO ${sql.id(bootstrapUser)}
	`.execute(db);
	return config;
}

async function createLegacyBootstrapRoles(db: Kysely<unknown>): Promise<{
	readonly convergence: DatabasePrivilegeRoleConfig;
	readonly bootstrap: DatabaseOwnerBootstrapConfig;
	readonly bootstrapRole: string;
	readonly legacyRole: string;
}> {
	const suffix = Math.random().toString(36).slice(2, 10);
	const convergence = {
		migrationRole: `nova_migrate_legacy_${suffix}`,
		runtimeRole: `nova_runtime_legacy_${suffix}`,
	};
	const legacyRole = `nova_legacy_${suffix}`;
	const bootstrapRole = `nova_bootstrap_${suffix}`;
	for (const role of [
		convergence.migrationRole,
		convergence.runtimeRole,
		legacyRole,
	]) {
		await sql`CREATE ROLE ${sql.id(role)} NOLOGIN`.execute(db);
	}
	await sql`
		CREATE ROLE ${sql.id(bootstrapRole)} NOLOGIN SUPERUSER CREATEDB CREATEROLE
	`.execute(db);
	await sql`
		GRANT ${sql.id(convergence.runtimeRole)}
		TO ${sql.id(convergence.migrationRole)}
	`.execute(db);
	await sql`
		GRANT ${sql.id(convergence.migrationRole)}, ${sql.id(legacyRole)}
		TO ${sql.id(bootstrapRole)}
	`.execute(db);
	await sql`
		GRANT ${sql.id(legacyRole)} TO ${sql.id(convergence.runtimeRole)}
	`.execute(db);
	await sql`
		ALTER DATABASE ${sql.id(h.databaseName)} OWNER TO ${sql.id(legacyRole)}
	`.execute(db);
	return {
		convergence,
		bootstrap: {
			database: h.databaseName,
			migrationRole: convergence.migrationRole,
			runtimeRole: convergence.runtimeRole,
			legacyRole,
		},
		bootstrapRole,
		legacyRole,
	};
}

async function createMigrationDatabase(
	config: DatabasePrivilegeRoleConfig,
): Promise<{ db: Kysely<unknown>; pool: Pool }> {
	return createRoleDatabase(config.migrationRole);
}

async function createRoleDatabase(
	role: string,
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
	await sql`SET ROLE ${sql.id(role)}`.execute(db);
	return { db, pool };
}

async function dropRoles(
	db: Kysely<unknown>,
	config: DatabasePrivilegeRoleConfig,
	extraRoles: readonly string[] = [],
): Promise<void> {
	const current = await sql<{ name: string }>`
		SELECT current_user AS name
	`.execute(db);
	const currentRole = current.rows[0]?.name;
	if (!currentRole) throw new Error("Current role query returned no row.");
	await sql`
		ALTER DATABASE ${sql.id(h.databaseName)} OWNER TO ${sql.id(currentRole)}
	`.execute(db);
	const requestedRoles = [
		config.migrationRole,
		config.runtimeRole,
		...extraRoles,
	];
	const existing = await sql<{ name: string }>`
		SELECT rolname AS name
		FROM pg_catalog.pg_roles
		WHERE rolname IN (${sql.join(requestedRoles)})
	`.execute(db);
	const roles = existing.rows.map((row) => row.name);
	for (const role of roles) {
		await sql`
			REASSIGN OWNED BY ${sql.id(role)} TO ${sql.id(currentRole)}
		`.execute(db);
		await sql`DROP OWNED BY ${sql.id(role)}`.execute(db);
	}
	if (
		roles.includes(config.runtimeRole) &&
		roles.includes(config.migrationRole)
	) {
		await sql`
			REVOKE ${sql.id(config.runtimeRole)}
			FROM ${sql.id(config.migrationRole)}
		`.execute(db);
	}
	for (const role of roles) {
		await sql`DROP ROLE ${sql.id(role)}`.execute(db);
	}
}

describe("database privilege convergence", () => {
	test("atomically retires legacy ownership before converging the runtime boundary", async () => {
		const fixture = await createLegacyBootstrapRoles(h.db);
		const legacy = await createRoleDatabase(fixture.legacyRole);
		let migration:
			| { readonly db: Kysely<unknown>; readonly pool: Pool }
			| undefined;
		const bootstrapClient = new Client({ connectionString: h.uri });
		try {
			await runCaseStoreMigrations(legacy.db);
			const { runMigrations } = await getMigrations(
				authMigrateOptions(legacy.pool),
			);
			await runMigrations();
			await runAuthAppMigrations(legacy.db);
			await sql`
				GRANT CREATE ON DATABASE ${sql.id(h.databaseName)}
				TO ${sql.id(fixture.legacyRole)}
			`.execute(h.db);
			await sql`
				GRANT CREATE ON SCHEMA public TO ${sql.id(fixture.legacyRole)}
			`.execute(h.db);
			await legacy.db.destroy();

			const legacyOwners = await sql<{ name: string; owner: string }>`
				SELECT class.relname AS name,
					pg_catalog.pg_get_userbyid(class.relowner) AS owner
				FROM pg_catalog.pg_class AS class
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = class.relnamespace
				WHERE namespace.nspname = 'public'
					AND class.relname IN (
						'case_indices', 'case_type_schemas', 'cases'
					)
				ORDER BY class.relname
			`.execute(h.db);
			expect(legacyOwners.rows).toEqual([
				{ name: "case_indices", owner: fixture.legacyRole },
				{ name: "case_type_schemas", owner: fixture.legacyRole },
				{ name: "cases", owner: fixture.legacyRole },
			]);

			migration = await createMigrationDatabase(fixture.convergence);
			await expect(
				convergeDatabasePrivileges(migration.db, fixture.convergence),
			).rejects.toMatchObject({ code: "role_policy_invalid" });

			// Simulate Cloud SQL Admin API removal of runtime -> legacy before
			// the SQL utility takes locks or changes ownership.
			await sql`
				REVOKE ${sql.id(fixture.legacyRole)}
				FROM ${sql.id(fixture.convergence.runtimeRole)}
			`.execute(h.db);
			await bootstrapClient.connect();
			await bootstrapClient.query(
				`SET ROLE ${quoteIdentifier(fixture.bootstrapRole)}`,
			);

			// A failed post-audit must undo ALTER DATABASE, REASSIGN OWNED, and
			// DROP OWNED together. Giving public to legacy makes the post-audit
			// fail after all three statements have run.
			await sql`
				ALTER SCHEMA public OWNER TO ${sql.id(fixture.legacyRole)}
			`.execute(h.db);
			await expect(
				executeDatabaseOwnerBootstrap(bootstrapClient, fixture.bootstrap),
			).rejects.toThrow("public schema is not owned by pg_database_owner");
			const rolledBack = await sql<{
				database_owner: string;
				public_owner: string;
				cases_owner: string;
			}>`
				SELECT
					pg_catalog.pg_get_userbyid(database.datdba)
						AS database_owner,
					pg_catalog.pg_get_userbyid(namespace.nspowner)
						AS public_owner,
					pg_catalog.pg_get_userbyid(cases.relowner) AS cases_owner
				FROM pg_catalog.pg_database AS database
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.nspname = 'public'
				JOIN pg_catalog.pg_class AS cases
					ON cases.relnamespace = namespace.oid
					AND cases.relname = 'cases'
				WHERE database.datname = pg_catalog.current_database()
			`.execute(h.db);
			expect(rolledBack.rows[0]).toEqual({
				database_owner: fixture.legacyRole,
				public_owner: fixture.legacyRole,
				cases_owner: fixture.legacyRole,
			});

			await sql`
				ALTER SCHEMA public OWNER TO pg_database_owner
			`.execute(h.db);
			const bootstrap = await executeDatabaseOwnerBootstrap(
				bootstrapClient,
				fixture.bootstrap,
			);
			expect(bootstrap.after).toMatchObject({
				databaseOwner: fixture.convergence.migrationRole,
				publicSchemaOwner: "pg_database_owner",
				currentUserDependencyCount: 0,
				legacyDependencyCount: 0,
				runtimeCanCreateDatabase: false,
				runtimeCanCreatePublicSchema: false,
			});

			await sql`
				REVOKE ${sql.id(fixture.legacyRole)}
				FROM ${sql.id(fixture.bootstrapRole)}
			`.execute(h.db);
			await sql`DROP ROLE ${sql.id(fixture.legacyRole)}`.execute(h.db);
			await bootstrapClient.query("RESET ROLE");
			await sql`DROP ROLE ${sql.id(fixture.bootstrapRole)}`.execute(h.db);

			await convergeDatabasePrivileges(migration.db, fixture.convergence);
			await asRole(h.db, fixture.convergence.runtimeRole, async (tx) => {
				const authority = await sql<{
					can_create_database: boolean;
					can_create_public: boolean;
				}>`
					SELECT
						pg_catalog.has_database_privilege(
							current_user,
							pg_catalog.current_database(),
							'CREATE'
						) AS can_create_database,
						pg_catalog.has_schema_privilege(
							current_user, 'public', 'CREATE'
						) AS can_create_public
				`.execute(tx);
				expect(authority.rows[0]).toEqual({
					can_create_database: false,
					can_create_public: false,
				});
			});
			await expect(
				asRole(h.db, fixture.convergence.runtimeRole, async (tx) => {
					await sql`CREATE SCHEMA forbidden_runtime_schema`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				asRole(h.db, fixture.convergence.runtimeRole, async (tx) => {
					await sql`
						CREATE TABLE public.forbidden_runtime_table (id integer)
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });
		} finally {
			await bootstrapClient.end().catch(() => undefined);
			await legacy.db.destroy().catch(() => undefined);
			await migration?.db.destroy().catch(() => undefined);
			await dropRoles(h.db, fixture.convergence, [
				fixture.legacyRole,
				fixture.bootstrapRole,
			]);
		}
	});

	test("converges from the database-owning migration identity to the two-role boundary", async () => {
		const config = await createRoles(h.db);
		const bootstrapRole = `nova_bootstrap_fresh_${Math.random()
			.toString(36)
			.slice(2, 10)}`;
		const bootstrapSchema = `bootstrap_owned_${Math.random()
			.toString(36)
			.slice(2, 10)}`;
		await sql`
			CREATE ROLE ${sql.id(bootstrapRole)}
			NOLOGIN SUPERUSER CREATEDB CREATEROLE
		`.execute(h.db);
		await sql`
			GRANT ${sql.id(config.migrationRole)} TO ${sql.id(bootstrapRole)}
		`.execute(h.db);
		const bootstrapClient = new Client({ connectionString: h.uri });
		let migration:
			| { readonly db: Kysely<unknown>; readonly pool: Pool }
			| undefined;
		try {
			await bootstrapClient.connect();
			await bootstrapClient.query(`SET ROLE ${quoteIdentifier(bootstrapRole)}`);
			await bootstrapClient.query(
				`CREATE SCHEMA ${quoteIdentifier(bootstrapSchema)}`,
			);
			await bootstrapClient.query(
				`CREATE TABLE ${quoteIdentifier(bootstrapSchema)}.owned_probe (id integer)`,
			);
			await bootstrapClient.query(
				`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${quoteIdentifier(config.runtimeRole)}`,
			);
			const freshBootstrap = await executeDatabaseOwnerBootstrap(
				bootstrapClient,
				{
					database: h.databaseName,
					migrationRole: config.migrationRole,
					runtimeRole: config.runtimeRole,
					legacyRole: `absent_${config.migrationRole}`,
				},
			);
			expect(freshBootstrap.before.legacyRoleExists).toBe(false);
			expect(freshBootstrap.before.currentUserDependencyCount).toBeGreaterThan(
				0,
			);
			expect(freshBootstrap.statements).toEqual([
				`ALTER DATABASE "${h.databaseName}" OWNER TO "${config.migrationRole}"`,
				`REASSIGN OWNED BY "${bootstrapRole}" TO "${config.migrationRole}"`,
				`DROP OWNED BY "${bootstrapRole}" RESTRICT`,
			]);
			expect(freshBootstrap.after).toMatchObject({
				currentUserDependencyCount: 0,
				currentUserOwnedSchemaCount: 0,
				currentUserOwnedRelationCount: 0,
				currentUserDefaultAclCount: 0,
			});
			const reassigned = await sql<{ owner: string }>`
				SELECT pg_catalog.pg_get_userbyid(namespace.nspowner) AS owner
				FROM pg_catalog.pg_namespace AS namespace
				WHERE namespace.nspname = ${bootstrapSchema}
			`.execute(h.db);
			expect(reassigned.rows[0]?.owner).toBe(config.migrationRole);
			await bootstrapClient.query("RESET ROLE");
			await sql`DROP ROLE ${sql.id(bootstrapRole)}`.execute(h.db);
			migration = await createMigrationDatabase(config);
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
						'kysely_migration')
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
				kysely_migration: {
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
						SELECT name FROM public.kysely_migration LIMIT 1
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
			await bootstrapClient.query("RESET ROLE").catch(() => undefined);
			await bootstrapClient.end().catch(() => undefined);
			await migration?.db.destroy().catch(() => undefined);
			await dropRoles(h.db, config, [bootstrapRole]);
		}
	});
});
