import type { QueryResultRow } from "pg";

export const DEPLOYMENT_DATABASE = "nova_cases";
export const MIGRATION_DATABASE_ROLE = "nova-migrate@commcare-nova.iam";
export const RUNTIME_DATABASE_ROLE = "commcare-nova@commcare-nova.iam";
export const LEGACY_DATABASE_ROLE = "51003905459-compute@developer";

export interface DatabaseOwnerBootstrapConfig {
	readonly database: string;
	readonly migrationRole: string;
	readonly runtimeRole: string;
	readonly legacyRole: string;
}

export const DATABASE_OWNER_BOOTSTRAP_CONFIG: DatabaseOwnerBootstrapConfig =
	Object.freeze({
		database: DEPLOYMENT_DATABASE,
		migrationRole: MIGRATION_DATABASE_ROLE,
		runtimeRole: RUNTIME_DATABASE_ROLE,
		legacyRole: LEGACY_DATABASE_ROLE,
	});

export interface DatabaseBootstrapFacts {
	readonly currentUser: string;
	readonly currentDatabase: string;
	readonly currentUserCanCreateRole: boolean;
	readonly currentUserCanCreateDatabase: boolean;
	readonly currentUserIsCloudSqlSuperuser: boolean;
	readonly databaseOwner: string;
	readonly publicSchemaOwner: string;
	readonly migrationRoleExists: boolean;
	readonly runtimeRoleExists: boolean;
	readonly legacyRoleExists: boolean;
	readonly currentUserIsMigrationMember: boolean;
	readonly currentUserCanSetMigration: boolean;
	readonly currentUserIsLegacyMember: boolean;
	readonly currentUserCanSetLegacy: boolean;
	readonly migrationIsRuntimeMember: boolean;
	readonly migrationCanSetRuntime: boolean;
	readonly runtimeIsMigrationMember: boolean;
	readonly runtimeCanSetMigration: boolean;
	readonly runtimeIsLegacyMember: boolean;
	readonly runtimeCanSetLegacy: boolean;
	readonly runtimeCanCreateDatabase: boolean;
	readonly runtimeCanCreatePublicSchema: boolean;
	readonly legacyCanCreateDatabase: boolean;
	readonly legacyCanCreatePublicSchema: boolean;
	readonly currentUserDependencyCount: number;
	readonly currentUserForeignOrSharedDependencyCount: number;
	readonly currentUserOwnedSchemaCount: number;
	readonly currentUserOwnedRelationCount: number;
	readonly currentUserOwnedRoutineCount: number;
	readonly currentUserDefaultAclCount: number;
	readonly legacyDependencyCount: number;
	readonly legacyForeignOrSharedDependencyCount: number;
	readonly legacyOwnedSchemaCount: number;
	readonly legacyOwnedRelationCount: number;
	readonly legacyOwnedRoutineCount: number;
	readonly legacyDefaultAclCount: number;
}

interface DatabaseBootstrapFactRow extends QueryResultRow {
	readonly current_user: string;
	readonly current_database: string;
	readonly current_user_can_create_role: boolean;
	readonly current_user_can_create_database: boolean;
	readonly current_user_is_cloudsqlsuperuser: boolean;
	readonly database_owner: string;
	readonly public_schema_owner: string;
	readonly migration_role_exists: boolean;
	readonly runtime_role_exists: boolean;
	readonly legacy_role_exists: boolean;
	readonly current_user_is_migration_member: boolean;
	readonly current_user_can_set_migration: boolean;
	readonly current_user_is_legacy_member: boolean;
	readonly current_user_can_set_legacy: boolean;
	readonly migration_is_runtime_member: boolean;
	readonly migration_can_set_runtime: boolean;
	readonly runtime_is_migration_member: boolean;
	readonly runtime_can_set_migration: boolean;
	readonly runtime_is_legacy_member: boolean;
	readonly runtime_can_set_legacy: boolean;
	readonly runtime_can_create_database: boolean;
	readonly runtime_can_create_public_schema: boolean;
	readonly legacy_can_create_database: boolean;
	readonly legacy_can_create_public_schema: boolean;
	readonly current_user_dependency_count: number;
	readonly current_user_foreign_or_shared_dependency_count: number;
	readonly current_user_owned_schema_count: number;
	readonly current_user_owned_relation_count: number;
	readonly current_user_owned_routine_count: number;
	readonly current_user_default_acl_count: number;
	readonly legacy_dependency_count: number;
	readonly legacy_foreign_or_shared_dependency_count: number;
	readonly legacy_owned_schema_count: number;
	readonly legacy_owned_relation_count: number;
	readonly legacy_owned_routine_count: number;
	readonly legacy_default_acl_count: number;
}

export interface DatabaseBootstrapSqlClient {
	query<Row extends QueryResultRow = QueryResultRow>(
		queryText: string,
		values?: unknown[],
	): Promise<{ readonly rows: Row[] }>;
}

export interface DatabaseBootstrapInspection {
	readonly before: DatabaseBootstrapFacts;
	readonly statements: readonly string[];
}

export interface DatabaseBootstrapExecution
	extends DatabaseBootstrapInspection {
	readonly after: DatabaseBootstrapFacts;
}

export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/** Role memberships are a Cloud SQL Admin API prerequisite on PostgreSQL 18.
 * This plan deliberately contains ownership/ACL SQL only. */
export function databaseOwnerBootstrapStatements(
	facts: Pick<DatabaseBootstrapFacts, "currentUser" | "legacyRoleExists">,
	config: DatabaseOwnerBootstrapConfig = DATABASE_OWNER_BOOTSTRAP_CONFIG,
): readonly string[] {
	const migration = quoteIdentifier(config.migrationRole);
	const bootstrap = quoteIdentifier(facts.currentUser);
	const statements = [
		`ALTER DATABASE ${quoteIdentifier(config.database)} OWNER TO ${migration}`,
	];
	if (facts.legacyRoleExists) {
		const legacy = quoteIdentifier(config.legacyRole);
		statements.push(
			`REASSIGN OWNED BY ${legacy} TO ${migration}`,
			`DROP OWNED BY ${legacy} RESTRICT`,
		);
	}
	statements.push(
		`REASSIGN OWNED BY ${bootstrap} TO ${migration}`,
		`DROP OWNED BY ${bootstrap} RESTRICT`,
	);
	return Object.freeze(statements);
}

function assertNoEffectiveRuntimeCreate(
	facts: DatabaseBootstrapFacts,
	config: DatabaseOwnerBootstrapConfig,
): void {
	if (facts.runtimeCanCreateDatabase || facts.runtimeCanCreatePublicSchema) {
		throw new Error(
			`The runtime role still has effective CREATE on ${config.database} or public.`,
		);
	}
}

export function assertDatabaseBootstrapPreconditions(
	facts: DatabaseBootstrapFacts,
	config: DatabaseOwnerBootstrapConfig = DATABASE_OWNER_BOOTSTRAP_CONFIG,
): void {
	if (
		!facts.currentUserCanCreateRole ||
		!facts.currentUserCanCreateDatabase ||
		!facts.currentUserIsCloudSqlSuperuser
	) {
		throw new Error(
			"Database bootstrap requires a temporary built-in Cloud SQL administrator.",
		);
	}
	if (!facts.migrationRoleExists || !facts.runtimeRoleExists) {
		throw new Error(
			"Migration and runtime IAM database users must exist before bootstrap.",
		);
	}
	if (facts.currentDatabase !== config.database) {
		throw new Error(
			`Database bootstrap connected to ${facts.currentDatabase}, expected ${config.database}.`,
		);
	}
	if (
		facts.currentUser === config.migrationRole ||
		facts.currentUser === config.runtimeRole ||
		facts.currentUser === config.legacyRole
	) {
		throw new Error(
			"Database bootstrap requires a distinct temporary administrator.",
		);
	}
	if (
		!facts.currentUserIsMigrationMember ||
		!facts.currentUserCanSetMigration ||
		(facts.legacyRoleExists &&
			(!facts.currentUserIsLegacyMember || !facts.currentUserCanSetLegacy))
	) {
		throw new Error(
			"The temporary administrator needs Cloud SQL API-assigned MEMBER and SET access to the legacy and migration roles.",
		);
	}
	if (!facts.migrationIsRuntimeMember || !facts.migrationCanSetRuntime) {
		throw new Error(
			"The migration role must have MEMBER and SET access to the runtime role.",
		);
	}
	if (
		facts.runtimeIsMigrationMember ||
		facts.runtimeCanSetMigration ||
		facts.runtimeIsLegacyMember ||
		facts.runtimeCanSetLegacy
	) {
		throw new Error(
			"Runtime inherited-role membership must be removed through the Cloud SQL Admin API before SQL bootstrap.",
		);
	}
	assertNoEffectiveRuntimeCreate(facts, config);
	if (facts.legacyForeignOrSharedDependencyCount > 0) {
		throw new Error(
			`The legacy role has dependencies outside ${config.database} that this bootstrap cannot safely transfer.`,
		);
	}
	if (facts.currentUserForeignOrSharedDependencyCount > 0) {
		throw new Error(
			`The temporary administrator has dependencies outside ${config.database} that this bootstrap cannot safely transfer.`,
		);
	}
	if (
		!facts.legacyRoleExists &&
		(facts.legacyDependencyCount > 0 ||
			facts.legacyOwnedSchemaCount > 0 ||
			facts.legacyOwnedRelationCount > 0 ||
			facts.legacyOwnedRoutineCount > 0 ||
			facts.legacyDefaultAclCount > 0)
	) {
		throw new Error(
			"Legacy dependencies exist even though the legacy role is absent.",
		);
	}
}

export function assertDatabaseBootstrapResult(
	facts: DatabaseBootstrapFacts,
	config: DatabaseOwnerBootstrapConfig = DATABASE_OWNER_BOOTSTRAP_CONFIG,
): void {
	if (facts.databaseOwner !== config.migrationRole) {
		throw new Error("Migration identity does not own the Nova database.");
	}
	if (facts.publicSchemaOwner !== "pg_database_owner") {
		throw new Error("The public schema is not owned by pg_database_owner.");
	}
	if (
		!facts.migrationIsRuntimeMember ||
		!facts.migrationCanSetRuntime ||
		facts.runtimeIsMigrationMember ||
		facts.runtimeCanSetMigration ||
		facts.runtimeIsLegacyMember ||
		facts.runtimeCanSetLegacy
	) {
		throw new Error("Migration/runtime database membership is unsafe.");
	}
	assertNoEffectiveRuntimeCreate(facts, config);
	if (
		facts.currentUserDependencyCount > 0 ||
		facts.currentUserOwnedSchemaCount > 0 ||
		facts.currentUserOwnedRelationCount > 0 ||
		facts.currentUserOwnedRoutineCount > 0 ||
		facts.currentUserDefaultAclCount > 0
	) {
		throw new Error(
			`The temporary administrator still owns objects or holds privileges in ${config.database}.`,
		);
	}
	if (
		facts.legacyCanCreateDatabase ||
		facts.legacyCanCreatePublicSchema ||
		facts.legacyDependencyCount > 0 ||
		facts.legacyOwnedSchemaCount > 0 ||
		facts.legacyOwnedRelationCount > 0 ||
		facts.legacyOwnedRoutineCount > 0 ||
		facts.legacyDefaultAclCount > 0
	) {
		throw new Error(
			`The legacy role still owns objects or holds privileges in ${config.database}.`,
		);
	}
}

/** Read both membership modes: PostgreSQL 18 can allow membership without
 * allowing SET ROLE, and both are required for the ownership transfer. */
export async function readDatabaseBootstrapFacts(
	client: DatabaseBootstrapSqlClient,
	config: DatabaseOwnerBootstrapConfig = DATABASE_OWNER_BOOTSTRAP_CONFIG,
): Promise<DatabaseBootstrapFacts> {
	const result = await client.query<DatabaseBootstrapFactRow>(
		`WITH role_oids AS (
			SELECT
				(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
					AS migration_oid,
				(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $2)
					AS runtime_oid,
				(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $3)
					AS legacy_oid,
				(SELECT oid FROM pg_catalog.pg_roles
					WHERE rolname = 'cloudsqlsuperuser')
					AS cloudsqlsuperuser_oid
		), database_row AS (
			SELECT oid, datdba
			FROM pg_catalog.pg_database
			WHERE datname = pg_catalog.current_database()
		)
		SELECT
			current_user,
			pg_catalog.current_database() AS current_database,
			login_role.rolcreaterole AS current_user_can_create_role,
			login_role.rolcreatedb AS current_user_can_create_database,
			(
				login_role.rolsuper OR CASE
					WHEN role_oids.cloudsqlsuperuser_oid IS NULL THEN false
					ELSE pg_catalog.pg_has_role(
						login_role.oid,
						role_oids.cloudsqlsuperuser_oid,
						'MEMBER'
					)
				END
			) AS current_user_is_cloudsqlsuperuser,
			pg_catalog.pg_get_userbyid(database_row.datdba) AS database_owner,
			pg_catalog.pg_get_userbyid(namespace.nspowner) AS public_schema_owner,
			role_oids.migration_oid IS NOT NULL AS migration_role_exists,
			role_oids.runtime_oid IS NOT NULL AS runtime_role_exists,
			role_oids.legacy_oid IS NOT NULL AS legacy_role_exists,
			CASE WHEN role_oids.migration_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					login_role.oid, role_oids.migration_oid, 'MEMBER'
				) END AS current_user_is_migration_member,
			CASE WHEN role_oids.migration_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					login_role.oid, role_oids.migration_oid, 'SET'
				) END AS current_user_can_set_migration,
			CASE WHEN role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					login_role.oid, role_oids.legacy_oid, 'MEMBER'
				) END AS current_user_is_legacy_member,
			CASE WHEN role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					login_role.oid, role_oids.legacy_oid, 'SET'
				) END AS current_user_can_set_legacy,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.migration_oid, role_oids.runtime_oid, 'MEMBER'
				) END AS migration_is_runtime_member,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.migration_oid, role_oids.runtime_oid, 'SET'
				) END AS migration_can_set_runtime,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.runtime_oid, role_oids.migration_oid, 'MEMBER'
				) END AS runtime_is_migration_member,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.runtime_oid, role_oids.migration_oid, 'SET'
				) END AS runtime_can_set_migration,
			CASE WHEN role_oids.legacy_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.runtime_oid, role_oids.legacy_oid, 'MEMBER'
				) END AS runtime_is_legacy_member,
			CASE WHEN role_oids.legacy_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.runtime_oid, role_oids.legacy_oid, 'SET'
				) END AS runtime_can_set_legacy,
			CASE WHEN role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.has_database_privilege(
					role_oids.runtime_oid, database_row.oid, 'CREATE'
				) END AS runtime_can_create_database,
			CASE WHEN role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.has_schema_privilege(
					role_oids.runtime_oid, namespace.oid, 'CREATE'
				) END AS runtime_can_create_public_schema,
			CASE WHEN role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.has_database_privilege(
					role_oids.legacy_oid, database_row.oid, 'CREATE'
				) END AS legacy_can_create_database,
			CASE WHEN role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.has_schema_privilege(
					role_oids.legacy_oid, namespace.oid, 'CREATE'
				) END AS legacy_can_create_public_schema,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_shdepend AS dependency
				WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
					AND dependency.refobjid = login_role.oid
			) AS current_user_dependency_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_shdepend AS dependency
				WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
					AND dependency.refobjid = login_role.oid
					AND NOT (
						dependency.dbid = database_row.oid
						OR (
							dependency.dbid = 0
							AND dependency.classid =
								'pg_catalog.pg_database'::regclass
							AND dependency.objid = database_row.oid
						)
					)
			) AS current_user_foreign_or_shared_dependency_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_namespace AS owned_namespace
				WHERE owned_namespace.nspowner = login_role.oid
			) AS current_user_owned_schema_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_class AS owned_relation
				WHERE owned_relation.relowner = login_role.oid
			) AS current_user_owned_relation_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_proc AS owned_routine
				WHERE owned_routine.proowner = login_role.oid
			) AS current_user_owned_routine_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_default_acl AS default_acl
				WHERE default_acl.defaclrole = login_role.oid
			) AS current_user_default_acl_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_shdepend AS dependency
				WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
					AND dependency.refobjid = role_oids.legacy_oid
			) AS legacy_dependency_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_shdepend AS dependency
				WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
					AND dependency.refobjid = role_oids.legacy_oid
					AND NOT (
						dependency.dbid = database_row.oid
						OR (
							dependency.dbid = 0
							AND dependency.classid =
								'pg_catalog.pg_database'::regclass
							AND dependency.objid = database_row.oid
						)
					)
			) AS legacy_foreign_or_shared_dependency_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_namespace AS owned_namespace
				WHERE owned_namespace.nspowner = role_oids.legacy_oid
			) AS legacy_owned_schema_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_class AS owned_relation
				WHERE owned_relation.relowner = role_oids.legacy_oid
			) AS legacy_owned_relation_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_proc AS owned_routine
				WHERE owned_routine.proowner = role_oids.legacy_oid
			) AS legacy_owned_routine_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_default_acl AS default_acl
				WHERE default_acl.defaclrole = role_oids.legacy_oid
			) AS legacy_default_acl_count
		FROM pg_catalog.pg_roles AS login_role
		CROSS JOIN role_oids
		CROSS JOIN database_row
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.nspname = 'public'
		WHERE login_role.rolname = current_user`,
		[config.migrationRole, config.runtimeRole, config.legacyRole],
	);
	const row = result.rows[0];
	if (!row) throw new Error("Database bootstrap fact query returned no row.");
	return {
		currentUser: row.current_user,
		currentDatabase: row.current_database,
		currentUserCanCreateRole: row.current_user_can_create_role,
		currentUserCanCreateDatabase: row.current_user_can_create_database,
		currentUserIsCloudSqlSuperuser: row.current_user_is_cloudsqlsuperuser,
		databaseOwner: row.database_owner,
		publicSchemaOwner: row.public_schema_owner,
		migrationRoleExists: row.migration_role_exists,
		runtimeRoleExists: row.runtime_role_exists,
		legacyRoleExists: row.legacy_role_exists,
		currentUserIsMigrationMember: row.current_user_is_migration_member,
		currentUserCanSetMigration: row.current_user_can_set_migration,
		currentUserIsLegacyMember: row.current_user_is_legacy_member,
		currentUserCanSetLegacy: row.current_user_can_set_legacy,
		migrationIsRuntimeMember: row.migration_is_runtime_member,
		migrationCanSetRuntime: row.migration_can_set_runtime,
		runtimeIsMigrationMember: row.runtime_is_migration_member,
		runtimeCanSetMigration: row.runtime_can_set_migration,
		runtimeIsLegacyMember: row.runtime_is_legacy_member,
		runtimeCanSetLegacy: row.runtime_can_set_legacy,
		runtimeCanCreateDatabase: row.runtime_can_create_database,
		runtimeCanCreatePublicSchema: row.runtime_can_create_public_schema,
		legacyCanCreateDatabase: row.legacy_can_create_database,
		legacyCanCreatePublicSchema: row.legacy_can_create_public_schema,
		currentUserDependencyCount: row.current_user_dependency_count,
		currentUserForeignOrSharedDependencyCount:
			row.current_user_foreign_or_shared_dependency_count,
		currentUserOwnedSchemaCount: row.current_user_owned_schema_count,
		currentUserOwnedRelationCount: row.current_user_owned_relation_count,
		currentUserOwnedRoutineCount: row.current_user_owned_routine_count,
		currentUserDefaultAclCount: row.current_user_default_acl_count,
		legacyDependencyCount: row.legacy_dependency_count,
		legacyForeignOrSharedDependencyCount:
			row.legacy_foreign_or_shared_dependency_count,
		legacyOwnedSchemaCount: row.legacy_owned_schema_count,
		legacyOwnedRelationCount: row.legacy_owned_relation_count,
		legacyOwnedRoutineCount: row.legacy_owned_routine_count,
		legacyDefaultAclCount: row.legacy_default_acl_count,
	};
}

async function configureTransaction(
	client: DatabaseBootstrapSqlClient,
): Promise<void> {
	await client.query("SET LOCAL search_path = pg_catalog");
	await client.query("SET LOCAL lock_timeout = '30s'");
}

async function rollbackAndRethrow(
	client: DatabaseBootstrapSqlClient,
	error: unknown,
): Promise<never> {
	try {
		await client.query("ROLLBACK");
	} catch (rollbackError: unknown) {
		throw new AggregateError(
			[error, rollbackError],
			"Database bootstrap failed and its rollback also failed.",
		);
	}
	throw error;
}

/** Dry-run inspection also uses a read-only transaction so every fact comes
 * from one catalog snapshot. */
export async function inspectDatabaseOwnerBootstrap(
	client: DatabaseBootstrapSqlClient,
	config: DatabaseOwnerBootstrapConfig = DATABASE_OWNER_BOOTSTRAP_CONFIG,
): Promise<DatabaseBootstrapInspection> {
	await client.query("BEGIN READ ONLY");
	try {
		await configureTransaction(client);
		const before = await readDatabaseBootstrapFacts(client, config);
		assertDatabaseBootstrapPreconditions(before, config);
		const statements = databaseOwnerBootstrapStatements(before, config);
		await client.query("ROLLBACK");
		return { before, statements };
	} catch (error: unknown) {
		return rollbackAndRethrow(client, error);
	}
}

/** The ownership transfer and its post-audit are one transaction. Any failed
 * statement or result assertion rolls back ALTER DATABASE and REASSIGN OWNED. */
export async function executeDatabaseOwnerBootstrap(
	client: DatabaseBootstrapSqlClient,
	config: DatabaseOwnerBootstrapConfig = DATABASE_OWNER_BOOTSTRAP_CONFIG,
): Promise<DatabaseBootstrapExecution> {
	await client.query("BEGIN");
	try {
		await configureTransaction(client);
		const before = await readDatabaseBootstrapFacts(client, config);
		assertDatabaseBootstrapPreconditions(before, config);
		const statements = databaseOwnerBootstrapStatements(before, config);
		for (const statement of statements) await client.query(statement);
		const after = await readDatabaseBootstrapFacts(client, config);
		assertDatabaseBootstrapResult(after, config);
		await client.query("COMMIT");
		return { before, statements, after };
	} catch (error: unknown) {
		return rollbackAndRethrow(client, error);
	}
}
