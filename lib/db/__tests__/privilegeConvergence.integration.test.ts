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
	AUDIT_DB_ROLE_CONNECTION_LIMIT,
	CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	CASE_RUNTIME_SCHEMA,
	DATABASE_CONNECTION_OPTIONS,
	MIGRATION_DB_ROLE_CONNECTION_LIMIT,
	RUNTIME_DB_ROLE_CONNECTION_LIMIT,
} from "@/lib/case-store/postgres/connection";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	type DatabaseOwnerBootstrapConfig,
	executeDatabaseOwnerBootstrap,
	quoteIdentifier,
} from "@/scripts/infra/databaseOwnerBootstrap";
import { readAppChangeStreamRowsSince } from "../appChangeStream";
import { createExplicitBlankApp } from "../appGenesis";
import { runCaptureCleanupSchemaProbe } from "../captureCleanupSchemaProbe";
import { __setAppDbForTests, type AppDatabase } from "../pg";
import {
	convergeDatabasePrivileges,
	type DatabasePrivilegeRoleConfig,
} from "../privilegeConvergence";
import { runCanonicalRuntimeDatabaseProbe } from "../runtimeDatabaseProbe";

const h = setupPerTestDatabase({
	databaseNamePrefix: "privilege_convergence_",
	establishLocalMigrationAuthority: true,
});

type BootstrapTestRoleConfig = DatabasePrivilegeRoleConfig;

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
): Promise<BootstrapTestRoleConfig> {
	const suffix = Math.random().toString(36).slice(2, 10);
	const config = {
		migrationRole: `nova_migrate_${suffix}`,
		runtimeRole: `nova_runtime_${suffix}`,
		cleanupRole: `nova_cleanup_${suffix}`,
		auditRole: `nova_audit_${suffix}`,
	};
	for (const role of [
		config.migrationRole,
		config.runtimeRole,
		config.cleanupRole,
		config.auditRole,
	]) {
		await sql`CREATE ROLE ${sql.id(role)} LOGIN`.execute(db);
	}
	for (const [role, connectionLimit] of [
		[config.migrationRole, MIGRATION_DB_ROLE_CONNECTION_LIMIT],
		[config.runtimeRole, RUNTIME_DB_ROLE_CONNECTION_LIMIT],
		[config.cleanupRole, CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT],
		[config.auditRole, AUDIT_DB_ROLE_CONNECTION_LIMIT],
	] as const) {
		await sql`
			ALTER ROLE ${sql.id(role)}
			CONNECTION LIMIT ${sql.raw(String(connectionLimit))}
		`.execute(db);
	}
	await sql`
		GRANT ${sql.id(config.runtimeRole)}
		TO ${sql.id(config.migrationRole)}
	`.execute(db);
	const identity = await sql<{ name: string }>`
		SELECT current_user AS name
	`.execute(db);
	const bootstrapUser = identity.rows[0]?.name;
	if (!bootstrapUser) throw new Error("Current role query returned no row.");
	await sql`
		GRANT ${sql.id(config.runtimeRole)}, ${sql.id(config.migrationRole)},
			${sql.id(config.cleanupRole)}
			, ${sql.id(config.auditRole)}
		TO ${sql.id(bootstrapUser)}
	`.execute(db);
	return config;
}

async function createLegacyBootstrapRoles(db: Kysely<unknown>): Promise<{
	readonly convergence: DatabasePrivilegeRoleConfig;
	readonly bootstrap: DatabaseOwnerBootstrapConfig;
	readonly bootstrapRole: string;
	readonly cleanupRole: string;
	readonly legacyRole: string;
}> {
	const suffix = Math.random().toString(36).slice(2, 10);
	const convergence = {
		migrationRole: `nova_migrate_legacy_${suffix}`,
		runtimeRole: `nova_runtime_legacy_${suffix}`,
		cleanupRole: `nova_cleanup_legacy_${suffix}`,
		auditRole: `nova_audit_legacy_${suffix}`,
	};
	const cleanupRole = convergence.cleanupRole;
	const legacyRole = `nova_legacy_${suffix}`;
	const bootstrapRole = `nova_bootstrap_${suffix}`;
	for (const role of [
		convergence.migrationRole,
		convergence.runtimeRole,
		cleanupRole,
		convergence.auditRole,
	]) {
		await sql`CREATE ROLE ${sql.id(role)} LOGIN`.execute(db);
	}
	await sql`CREATE ROLE ${sql.id(legacyRole)} NOLOGIN`.execute(db);
	await sql`
		CREATE ROLE ${sql.id(bootstrapRole)} NOLOGIN SUPERUSER CREATEDB CREATEROLE
	`.execute(db);
	await sql`
		GRANT ${sql.id(convergence.runtimeRole)}
		TO ${sql.id(convergence.migrationRole)}
	`.execute(db);
	await sql`
		GRANT ${sql.id(convergence.runtimeRole)},
			${sql.id(convergence.migrationRole)}, ${sql.id(cleanupRole)},
			${sql.id(convergence.auditRole)}, ${sql.id(legacyRole)}
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
			cleanupRole,
			auditRole: convergence.auditRole,
			legacyRole,
			migrationConnectionLimit: MIGRATION_DB_ROLE_CONNECTION_LIMIT,
			runtimeConnectionLimit: RUNTIME_DB_ROLE_CONNECTION_LIMIT,
			cleanupConnectionLimit: CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
			auditConnectionLimit: AUDIT_DB_ROLE_CONNECTION_LIMIT,
			// The pinned test image intentionally exercises the compiler's three
			// data extensions but does not package Cloud SQL's pgAudit library.
			// Production uses DATABASE_OWNER_BOOTSTRAP_CONFIG's four-extension
			// contract, pinned by the bootstrap unit tests and deploy preflight.
			requiredExtensions: [],
		},
		bootstrapRole,
		cleanupRole,
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
		config.cleanupRole,
		config.auditRole,
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
				fixture.cleanupRole,
				fixture.legacyRole,
				fixture.bootstrapRole,
			]);
		}
	});

	test("converges from the database-owning migration identity to the complete role boundary", async () => {
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
				GRANT ${sql.id(config.runtimeRole)}, ${sql.id(config.migrationRole)},
					${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
				TO ${sql.id(bootstrapRole)}
			`.execute(h.db);
		const bootstrapClient = new Client({ connectionString: h.uri });
		let migration:
			| { readonly db: Kysely<unknown>; readonly pool: Pool }
			| undefined;
		let cleanup:
			| { readonly db: Kysely<unknown>; readonly pool: Pool }
			| undefined;
		let runtime:
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
				`GRANT USAGE ON SCHEMA ${quoteIdentifier(bootstrapSchema)} TO ${quoteIdentifier(config.runtimeRole)}`,
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
					cleanupRole: config.cleanupRole,
					auditRole: config.auditRole,
					legacyRole: `absent_${config.migrationRole}`,
					migrationConnectionLimit: MIGRATION_DB_ROLE_CONNECTION_LIMIT,
					runtimeConnectionLimit: RUNTIME_DB_ROLE_CONNECTION_LIMIT,
					cleanupConnectionLimit: CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
					auditConnectionLimit: AUDIT_DB_ROLE_CONNECTION_LIMIT,
					requiredExtensions: [],
				},
			);
			expect(freshBootstrap.before.legacyRoleExists).toBe(false);
			expect(freshBootstrap.before.currentUserDependencyCount).toBeGreaterThan(
				0,
			);
			expect(freshBootstrap.statements).toEqual([
				`ALTER ROLE "${config.runtimeRole}" CONNECTION LIMIT ${RUNTIME_DB_ROLE_CONNECTION_LIMIT}`,
				`ALTER ROLE "${config.migrationRole}" CONNECTION LIMIT ${MIGRATION_DB_ROLE_CONNECTION_LIMIT}`,
				`ALTER ROLE "${config.cleanupRole}" CONNECTION LIMIT ${CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT}`,
				`ALTER ROLE "${config.auditRole}" CONNECTION LIMIT ${AUDIT_DB_ROLE_CONNECTION_LIMIT}`,
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

			const missingProbeAppId = crypto.randomUUID();
			const probeUserId = crypto.randomUUID();
			const probeProjectId = crypto.randomUUID();
			await sql`
				INSERT INTO auth_user (
					id, name, email, "emailVerified", "createdAt", "updatedAt"
				)
				VALUES (
					${probeUserId}, 'Runtime probe',
					${`${probeUserId}@dimagi.com`}, true, now(), now()
				)
			`.execute(migration.db);
			await sql`
				INSERT INTO auth_organization (
					id, name, slug, "createdAt"
				)
				VALUES (
					${probeProjectId}, 'Runtime probe',
					${`runtime-probe-${probeProjectId}`}, now()
				)
			`.execute(migration.db);
			await sql`
				INSERT INTO auth_member (
					id, "userId", "organizationId", role, "createdAt"
				)
				VALUES (
					${crypto.randomUUID()}, ${probeUserId}, ${probeProjectId},
					'editor', now()
				)
			`.execute(migration.db);
			__setAppDbForTests(migration.db as Kysely<AppDatabase>);
			const probeApp = await createExplicitBlankApp(
				probeUserId,
				probeProjectId,
				crypto.randomUUID(),
				{ status: "complete", name: "Runtime probe" },
			);
			__setAppDbForTests(null);

			/* The SPLIT media projection under the probe: a conversation
			 * attachment lives in the thread's `thread_media_refs` row and NOT
			 * in `media_asset_refs` (which holds only Blueprint-authored
			 * refs). The probe must read exactly that shape as zero
			 * divergence — a probe that still expects the app-wide union
			 * would fail every deploy whose conversations carry attachments
			 * the Blueprint never authored (the normal case for chat
			 * uploads). */
			const probeAssetId = crypto.randomUUID();
			const probeThreadId = crypto.randomUUID();
			await sql`
				INSERT INTO media_assets (
					id, project_id, owner, content_hash, mime_type, extension,
					size_bytes, dimensions, duration_ms, kind, gcs_object_key,
					original_filename, display_name, status, extract
				)
				VALUES (
					${probeAssetId}::uuid, ${probeProjectId}, ${probeUserId},
					${probeAssetId.replaceAll("-", "").padEnd(64, "a").slice(0, 64)},
					'application/pdf', '.pdf', 128, NULL, NULL, 'pdf',
					${`projects/${probeProjectId}/${probeAssetId}.pdf`},
					'requirements.pdf', 'Requirements', 'ready', NULL
				)
			`.execute(migration.db);
			await sql`
				INSERT INTO threads (
					thread_id, app_id, created_at, updated_at, thread_type,
					summary, run_id, messages
				)
				VALUES (
					${probeThreadId}, ${probeApp.appId}, now()::text, now()::text,
					'chat', 'Probe attachment thread', ${crypto.randomUUID()},
					${JSON.stringify([
						{
							id: "m1",
							role: "user",
							parts: [{ type: "text", text: "Please read this" }],
							metadata: {
								attachments: [
									{
										assetId: probeAssetId,
										kind: "pdf",
										filename: "requirements.pdf",
										mimeType: "application/pdf",
									},
								],
							},
						},
					])}::jsonb
				)
			`.execute(migration.db);
			await sql`
				INSERT INTO thread_media_refs (thread_id, asset_id, project_id)
				VALUES (${probeThreadId}, ${probeAssetId}::uuid, ${probeProjectId})
			`.execute(migration.db);

			const runtimeProbe = await runCanonicalRuntimeDatabaseProbe(
				migration.db,
				config.runtimeRole,
			);
			expect(runtimeProbe).toMatchObject({
				parsedAppCount: 1,
				parserFindingCount: 0,
				mediaReferenceProjectionFindingCount: 0,
				rollbackVerified: true,
			});
			expect(runtimeProbe.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
			const runtimeProbeResidue = await sql<{
				mutation_seq: string | number;
				mutation_count: string | number;
			}>`
				SELECT
					app.mutation_seq,
					(
						SELECT count(*)
						FROM app_changes
						WHERE app_id = app.id
					) AS mutation_count
				FROM apps AS app
				WHERE app.id = ${probeApp.appId}
			`.execute(migration.db);
			expect(runtimeProbeResidue.rows).toEqual([
				{ mutation_seq: "1", mutation_count: "1" },
			]);

			runtime = await createRoleDatabase(config.runtimeRole);
			__setAppDbForTests(runtime.db as Kysely<AppDatabase>);
			const genesis = await createExplicitBlankApp(
				probeUserId,
				probeProjectId,
				crypto.randomUUID(),
				{ status: "complete", name: "Runtime genesis" },
			);
			__setAppDbForTests(null);
			const genesisProof = await sql<{
				baselines: string;
				digest_matches: boolean;
			}>`
				SELECT
					count(*)::text AS baselines,
					bool_and(
						baseline.snapshot_digest =
						encode(
							sha256(convert_to(baseline.snapshot::text, 'UTF8')),
							'hex'
						)
					) AS digest_matches
				FROM app_change_fold_baselines AS baseline
				WHERE baseline.app_id = ${genesis.appId}
			`.execute(migration.db);
			expect(genesisProof.rows).toEqual([
				{ baselines: "1", digest_matches: true },
			]);
			const runtimeStreamRows = await readAppChangeStreamRowsSince(
				runtime.db as Kysely<AppDatabase>,
				genesis.appId,
				0,
			);
			expect(runtimeStreamRows).toHaveLength(1);
			expect(runtimeStreamRows[0]).toMatchObject({
				seq: "1",
				baseline_seq: "1",
				kind: "fold-baseline",
				mutations_text: "[]",
			});
			await expect(
				sql`
					SELECT seq
					FROM app_changes
					WHERE app_id = ${genesis.appId}
					FOR SHARE
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					SELECT seq
					FROM app_change_fold_baselines
					WHERE app_id = ${genesis.appId}
					FOR SHARE
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					INSERT INTO app_change_fold_baselines
						(app_id, seq, project_id, snapshot, snapshot_digest)
					VALUES (
						${genesis.appId},
						2,
						${probeProjectId},
						'{}'::jsonb,
						repeat('0', 64)
					)
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					UPDATE app_change_fold_baselines
					SET snapshot = snapshot
					WHERE app_id = ${genesis.appId}
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					DELETE FROM app_change_fold_baselines
					WHERE app_id = ${genesis.appId}
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					UPDATE app_changes
					SET actor_id = actor_id
					WHERE app_id = ${genesis.appId}
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					DELETE FROM app_changes
					WHERE app_id = ${genesis.appId}
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			/* The identity-handle ledger's reference-to-declaration kind upgrade
			 * is ordinary runtime DML; a zero-row statement still requires the
			 * UPDATE privilege, so no fixture rows are needed. */
			await expect(
				sql`
					UPDATE design_identity_handles
					SET entity_kind = 'record'
					WHERE design_session_id = ${crypto.randomUUID()}::uuid
				`.execute(runtime.db),
			).resolves.toBeDefined();
			await expect(
				sql`
					DELETE FROM design_identity_handles
					WHERE design_session_id = ${crypto.randomUUID()}::uuid
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					UPDATE design_change_set_handles
					SET handle = handle
					WHERE change_set_id = ${crypto.randomUUID()}::uuid
				`.execute(runtime.db),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				sql`
					SELECT nova_insert_app_change_genesis_fold_baseline(${missingProbeAppId})
				`.execute(runtime.db),
			).rejects.toThrow(/current sequence-one app/);
			await expect(
				sql`
					SELECT nova_insert_app_change_genesis_fold_baseline(${genesis.appId})
				`.execute(runtime.db),
			).rejects.toThrow(
				/snapshot does not equal current app state|exact horizon or genesis marker|duplicate key/,
			);

			cleanup = await createRoleDatabase(config.cleanupRole);
			const cleanupProbe = await runCaptureCleanupSchemaProbe(
				cleanup.db as unknown as Kysely<AppDatabase>,
			);
			expect(cleanupProbe).toEqual({
				columnCount: 23,
				rollbackVerified: true,
			});
			// Convergence is an every-deploy operation, including after `cases` has
			// already moved and is runtime-owned. Seed historical direct cleanup
			// grants to prove the second pass converges rather than merely audits
			// its exact least-privilege boundary.
			await sql`
				GRANT SELECT ON TABLE public.apps TO ${sql.id(config.cleanupRole)}
			`.execute(h.db);
			await sql`
				GRANT INSERT ON TABLE public.form_attachments
				TO ${sql.id(config.cleanupRole)}
			`.execute(h.db);
			await sql`
				GRANT SELECT ON TABLE
					${sql.id(CASE_RUNTIME_SCHEMA)}.cases
				TO ${sql.id(config.cleanupRole)}
			`.execute(h.db);
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
							'kysely_migration', 'media_asset_refs')
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
				media_asset_refs: {
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
					can_select_media_asset_refs: boolean;
					can_insert_media_asset_refs: boolean;
					can_update_media_asset_refs: boolean;
					can_delete_media_asset_refs: boolean;
					can_select_index_deletions: boolean;
					can_insert_index_deletions: boolean;
					can_update_index_deletions: boolean;
					can_delete_index_deletions: boolean;
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
							pg_catalog.has_table_privilege(
								current_user,
								'public.media_asset_refs',
								'SELECT'
							) AS can_select_media_asset_refs,
						pg_catalog.has_table_privilege(
							current_user,
								'public.media_asset_refs',
								'INSERT'
							) AS can_insert_media_asset_refs,
						pg_catalog.has_table_privilege(
							current_user,
								'public.media_asset_refs',
								'UPDATE'
							) AS can_update_media_asset_refs,
						pg_catalog.has_table_privilege(
							current_user,
								'public.media_asset_refs',
								'DELETE'
							) AS can_delete_media_asset_refs,
						pg_catalog.has_table_privilege(
							current_user,
							'public.case_schema_index_deletions',
							'SELECT'
						) AS can_select_index_deletions,
						pg_catalog.has_table_privilege(
							current_user,
							'public.case_schema_index_deletions',
							'INSERT'
						) AS can_insert_index_deletions,
						pg_catalog.has_table_privilege(
							current_user,
							'public.case_schema_index_deletions',
							'UPDATE'
						) AS can_update_index_deletions,
						pg_catalog.has_table_privilege(
							current_user,
							'public.case_schema_index_deletions',
							'DELETE'
						) AS can_delete_index_deletions,
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
					can_select_media_asset_refs: true,
					can_insert_media_asset_refs: true,
					can_update_media_asset_refs: false,
					can_delete_media_asset_refs: true,
					can_select_index_deletions: true,
					can_insert_index_deletions: true,
					can_update_index_deletions: false,
					can_delete_index_deletions: true,
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
				await sql`SELECT project_id FROM public.media_asset_refs`.execute(tx);
				await sql`
					INSERT INTO public.case_schema_index_deletions
						(app_id, case_type)
					VALUES ('privilege-probe', 'patient')
				`.execute(tx);
				await sql`
					SELECT case_type
					FROM public.case_schema_index_deletions
					WHERE app_id = 'privilege-probe'
				`.execute(tx);
				await sql`
					DELETE FROM public.case_schema_index_deletions
					WHERE app_id = 'privilege-probe'
				`.execute(tx);
			});
			await expect(
				asRole(h.db, config.runtimeRole, async (tx) => {
					await sql`
						UPDATE public.case_schema_index_deletions
						SET case_type = case_type
						WHERE app_id = 'privilege-probe'
					`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });

			await asRole(h.db, config.cleanupRole, async (tx) => {
				const grants = await sql<{
					can_select: boolean;
					can_update: boolean;
					can_delete: boolean;
					can_insert: boolean;
					can_use_case_schema: boolean;
					can_read_apps: boolean;
					can_read_cases: boolean;
				}>`
						SELECT
							pg_catalog.has_table_privilege(
								current_user, 'public.form_attachments', 'SELECT'
							) AS can_select,
							pg_catalog.has_table_privilege(
								current_user, 'public.form_attachments', 'UPDATE'
							) AS can_update,
							pg_catalog.has_table_privilege(
								current_user, 'public.form_attachments', 'DELETE'
							) AS can_delete,
							pg_catalog.has_table_privilege(
								current_user, 'public.form_attachments', 'INSERT'
							) AS can_insert,
							pg_catalog.has_schema_privilege(
								current_user, ${CASE_RUNTIME_SCHEMA}, 'USAGE'
							) AS can_use_case_schema,
							pg_catalog.has_table_privilege(
								current_user, 'public.apps', 'SELECT'
							) AS can_read_apps,
							pg_catalog.has_table_privilege(
								current_user,
								(
									SELECT class.oid
									FROM pg_catalog.pg_class AS class
									JOIN pg_catalog.pg_namespace AS namespace
										ON namespace.oid = class.relnamespace
									WHERE namespace.nspname = ${CASE_RUNTIME_SCHEMA}
										AND class.relname = 'cases'
								),
								'SELECT'
							) AS can_read_cases
					`.execute(tx);
				expect(grants.rows[0]).toEqual({
					can_select: true,
					can_update: true,
					can_delete: true,
					can_insert: false,
					can_use_case_schema: false,
					can_read_apps: false,
					can_read_cases: false,
				});
				await sql`SELECT count(*) FROM public.form_attachments`.execute(tx);
				await sql`SELECT pg_catalog.current_setting('max_connections')`.execute(
					tx,
				);
				await sql`
						SELECT count(*) FROM pg_catalog.pg_stat_activity
						WHERE backend_type = 'client backend'
					`.execute(tx);
				await sql`
						SELECT pg_catalog.pg_try_advisory_xact_lock(42)
					`.execute(tx);
			});
			await expect(
				asRole(h.db, config.cleanupRole, async (tx) => {
					await sql`SELECT count(*) FROM public.apps`.execute(tx);
				}),
			).rejects.toMatchObject({ code: "42501" });

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
						SELECT name FROM public.kysely_migration LIMIT 1
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
			__setAppDbForTests(null);
			await bootstrapClient.query("RESET ROLE").catch(() => undefined);
			await bootstrapClient.end().catch(() => undefined);
			await cleanup?.db.destroy().catch(() => undefined);
			await runtime?.db.destroy().catch(() => undefined);
			await migration?.db.destroy().catch(() => undefined);
			await dropRoles(h.db, config, [config.cleanupRole, bootstrapRole]);
		}
	});
});
