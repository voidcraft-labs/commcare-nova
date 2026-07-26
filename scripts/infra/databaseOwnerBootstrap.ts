import type { QueryResultRow } from "pg";
import {
	CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	MIGRATION_DB_ROLE_CONNECTION_LIMIT,
	RUNTIME_DB_ROLE_CONNECTION_LIMIT,
} from "@/lib/case-store/postgres/connection";

export const DEPLOYMENT_DATABASE = "nova_cases";
export const MIGRATION_DATABASE_ROLE = "nova-migrate@commcare-nova.iam";
export const RUNTIME_DATABASE_ROLE = "commcare-nova@commcare-nova.iam";
export const CAPTURE_CLEANUP_DATABASE_ROLE =
	"nova-capture-cleanup@commcare-nova.iam";
export const LEGACY_DATABASE_ROLE = "51003905459-compute@developer";
export const REQUIRED_DATABASE_EXTENSIONS = Object.freeze([
	"pg_trgm",
	"fuzzystrmatch",
	"postgis",
	"pgaudit",
] as const);

export interface DatabaseOwnerBootstrapConfig {
	readonly database: string;
	readonly migrationRole: string;
	readonly runtimeRole: string;
	readonly cleanupRole: string;
	readonly legacyRole: string;
	readonly migrationConnectionLimit: number;
	readonly runtimeConnectionLimit: number;
	readonly cleanupConnectionLimit: number;
	readonly requiredExtensions: readonly string[];
}

export const DATABASE_OWNER_BOOTSTRAP_CONFIG: DatabaseOwnerBootstrapConfig =
	Object.freeze({
		database: DEPLOYMENT_DATABASE,
		migrationRole: MIGRATION_DATABASE_ROLE,
		runtimeRole: RUNTIME_DATABASE_ROLE,
		cleanupRole: CAPTURE_CLEANUP_DATABASE_ROLE,
		legacyRole: LEGACY_DATABASE_ROLE,
		migrationConnectionLimit: MIGRATION_DB_ROLE_CONNECTION_LIMIT,
		runtimeConnectionLimit: RUNTIME_DB_ROLE_CONNECTION_LIMIT,
		cleanupConnectionLimit: CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
		requiredExtensions: REQUIRED_DATABASE_EXTENSIONS,
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
	readonly cleanupRoleExists: boolean;
	readonly legacyRoleExists: boolean;
	readonly migrationRoleCanLogin: boolean;
	readonly runtimeRoleCanLogin: boolean;
	readonly cleanupRoleCanLogin: boolean;
	readonly migrationRoleIsSuperuser: boolean;
	readonly runtimeRoleIsSuperuser: boolean;
	readonly cleanupRoleIsSuperuser: boolean;
	readonly migrationRoleConnectionLimit: number;
	readonly runtimeRoleConnectionLimit: number;
	readonly cleanupRoleConnectionLimit: number;
	readonly currentUserIsMigrationMember: boolean;
	readonly currentUserCanSetMigration: boolean;
	readonly currentUserIsRuntimeMember: boolean;
	readonly currentUserCanSetRuntime: boolean;
	readonly currentUserIsCleanupMember: boolean;
	readonly currentUserCanSetCleanup: boolean;
	readonly currentUserIsLegacyMember: boolean;
	readonly currentUserCanSetLegacy: boolean;
	readonly migrationIsRuntimeMember: boolean;
	readonly migrationCanSetRuntime: boolean;
	readonly migrationIsCleanupMember: boolean;
	readonly migrationCanSetCleanup: boolean;
	readonly migrationIsLegacyMember: boolean;
	readonly migrationCanSetLegacy: boolean;
	readonly cleanupIsRuntimeMember: boolean;
	readonly cleanupCanSetRuntime: boolean;
	readonly cleanupIsMigrationMember: boolean;
	readonly cleanupCanSetMigration: boolean;
	readonly cleanupIsLegacyMember: boolean;
	readonly cleanupCanSetLegacy: boolean;
	readonly runtimeIsMigrationMember: boolean;
	readonly runtimeCanSetMigration: boolean;
	readonly runtimeIsCleanupMember: boolean;
	readonly runtimeCanSetCleanup: boolean;
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
	readonly requiredExtensionCount: number;
	readonly requiredExtensionsOwnedByMigration: number;
	readonly pgauditPresent: boolean;
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
	readonly cleanup_role_exists: boolean;
	readonly legacy_role_exists: boolean;
	readonly migration_role_can_login: boolean;
	readonly runtime_role_can_login: boolean;
	readonly cleanup_role_can_login: boolean;
	readonly migration_role_is_superuser: boolean;
	readonly runtime_role_is_superuser: boolean;
	readonly cleanup_role_is_superuser: boolean;
	readonly migration_role_connection_limit: number;
	readonly runtime_role_connection_limit: number;
	readonly cleanup_role_connection_limit: number;
	readonly current_user_is_migration_member: boolean;
	readonly current_user_can_set_migration: boolean;
	readonly current_user_is_runtime_member: boolean;
	readonly current_user_can_set_runtime: boolean;
	readonly current_user_is_cleanup_member: boolean;
	readonly current_user_can_set_cleanup: boolean;
	readonly current_user_is_legacy_member: boolean;
	readonly current_user_can_set_legacy: boolean;
	readonly migration_is_runtime_member: boolean;
	readonly migration_can_set_runtime: boolean;
	readonly migration_is_cleanup_member: boolean;
	readonly migration_can_set_cleanup: boolean;
	readonly migration_is_legacy_member: boolean;
	readonly migration_can_set_legacy: boolean;
	readonly cleanup_is_runtime_member: boolean;
	readonly cleanup_can_set_runtime: boolean;
	readonly cleanup_is_migration_member: boolean;
	readonly cleanup_can_set_migration: boolean;
	readonly cleanup_is_legacy_member: boolean;
	readonly cleanup_can_set_legacy: boolean;
	readonly runtime_is_migration_member: boolean;
	readonly runtime_can_set_migration: boolean;
	readonly runtime_is_cleanup_member: boolean;
	readonly runtime_can_set_cleanup: boolean;
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
	readonly required_extension_count: number;
	readonly required_extensions_owned_by_migration: number;
	readonly pgaudit_present: boolean;
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
 * This transaction owns the hard login-role caps plus ownership/ACL SQL. */
export function databaseOwnerBootstrapStatements(
	facts: Pick<DatabaseBootstrapFacts, "currentUser" | "legacyRoleExists">,
	config: DatabaseOwnerBootstrapConfig = DATABASE_OWNER_BOOTSTRAP_CONFIG,
): readonly string[] {
	const migration = quoteIdentifier(config.migrationRole);
	const runtime = quoteIdentifier(config.runtimeRole);
	const cleanup = quoteIdentifier(config.cleanupRole);
	const bootstrap = quoteIdentifier(facts.currentUser);
	const statements = [
		...config.requiredExtensions.map(
			(extension) =>
				`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)} WITH SCHEMA public`,
		),
		`ALTER ROLE ${runtime} CONNECTION LIMIT ${config.runtimeConnectionLimit}`,
		`ALTER ROLE ${migration} CONNECTION LIMIT ${config.migrationConnectionLimit}`,
		`ALTER ROLE ${cleanup} CONNECTION LIMIT ${config.cleanupConnectionLimit}`,
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

function assertApplicationLoginRoleShape(
	facts: DatabaseBootstrapFacts,
	config: DatabaseOwnerBootstrapConfig,
	expectExactConnectionLimits: boolean,
): void {
	if (
		!facts.migrationRoleExists ||
		!facts.runtimeRoleExists ||
		!facts.cleanupRoleExists
	) {
		throw new Error(
			"Migration, runtime, and capture-cleanup IAM database users must exist before bootstrap.",
		);
	}
	if (
		!facts.migrationRoleCanLogin ||
		!facts.runtimeRoleCanLogin ||
		!facts.cleanupRoleCanLogin
	) {
		throw new Error(
			"Migration, runtime, and capture-cleanup database roles must remain direct LOGIN roles.",
		);
	}
	if (
		facts.migrationRoleIsSuperuser ||
		facts.runtimeRoleIsSuperuser ||
		facts.cleanupRoleIsSuperuser
	) {
		throw new Error(
			"Application database login roles must not be PostgreSQL superusers.",
		);
	}
	if (
		expectExactConnectionLimits &&
		(facts.migrationRoleConnectionLimit !== config.migrationConnectionLimit ||
			facts.runtimeRoleConnectionLimit !== config.runtimeConnectionLimit ||
			facts.cleanupRoleConnectionLimit !== config.cleanupConnectionLimit)
	) {
		throw new Error(
			[
				"Application database login-role connection limits are unsafe.",
				`Expected runtime=${config.runtimeConnectionLimit}, migration=${config.migrationConnectionLimit}, cleanup=${config.cleanupConnectionLimit}; found runtime=${facts.runtimeRoleConnectionLimit}, migration=${facts.migrationRoleConnectionLimit}, cleanup=${facts.cleanupRoleConnectionLimit}.`,
			].join(" "),
		);
	}
}

function assertApplicationRoleMemberships(facts: DatabaseBootstrapFacts): void {
	if (!facts.migrationIsRuntimeMember || !facts.migrationCanSetRuntime) {
		throw new Error("Migration must have MEMBER and SET access to runtime.");
	}
	if (
		facts.cleanupIsRuntimeMember ||
		facts.cleanupCanSetRuntime ||
		facts.migrationIsCleanupMember ||
		facts.migrationCanSetCleanup ||
		facts.migrationIsLegacyMember ||
		facts.migrationCanSetLegacy ||
		facts.cleanupIsMigrationMember ||
		facts.cleanupCanSetMigration ||
		facts.cleanupIsLegacyMember ||
		facts.cleanupCanSetLegacy ||
		facts.runtimeIsMigrationMember ||
		facts.runtimeCanSetMigration ||
		facts.runtimeIsCleanupMember ||
		facts.runtimeCanSetCleanup ||
		facts.runtimeIsLegacyMember ||
		facts.runtimeCanSetLegacy
	) {
		throw new Error(
			"Application database role membership is wider than the one-way migration-to-runtime grant.",
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
	assertApplicationLoginRoleShape(facts, config, false);
	if (facts.currentDatabase !== config.database) {
		throw new Error(
			`Database bootstrap connected to ${facts.currentDatabase}, expected ${config.database}.`,
		);
	}
	if (
		facts.currentUser === config.migrationRole ||
		facts.currentUser === config.runtimeRole ||
		facts.currentUser === config.cleanupRole ||
		facts.currentUser === config.legacyRole
	) {
		throw new Error(
			"Database bootstrap requires a distinct temporary administrator.",
		);
	}
	if (
		!facts.currentUserIsMigrationMember ||
		!facts.currentUserCanSetMigration ||
		!facts.currentUserIsRuntimeMember ||
		!facts.currentUserCanSetRuntime ||
		!facts.currentUserIsCleanupMember ||
		!facts.currentUserCanSetCleanup ||
		(facts.legacyRoleExists &&
			(!facts.currentUserIsLegacyMember || !facts.currentUserCanSetLegacy))
	) {
		throw new Error(
			"The temporary administrator needs Cloud SQL API-assigned MEMBER and SET access to runtime, migration, capture-cleanup, and legacy when present.",
		);
	}
	assertApplicationRoleMemberships(facts);
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
	assertApplicationLoginRoleShape(facts, config, true);
	if (
		facts.requiredExtensionCount !== config.requiredExtensions.length ||
		facts.requiredExtensionsOwnedByMigration !==
			config.requiredExtensions.length ||
		(config.requiredExtensions.includes("pgaudit") && !facts.pgauditPresent)
	) {
		throw new Error(
			`The required database extensions are incomplete or are not all owned by ${config.migrationRole}.`,
		);
	}
	if (facts.databaseOwner !== config.migrationRole) {
		throw new Error("Migration identity does not own the Nova database.");
	}
	if (facts.publicSchemaOwner !== "pg_database_owner") {
		throw new Error("The public schema is not owned by pg_database_owner.");
	}
	assertApplicationRoleMemberships(facts);
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

/** Audit direct MEMBER + SET grants where the Cloud SQL API must establish a
 * specific edge. PostgreSQL 18 can allow membership without SET ROLE. */
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
					AS cleanup_oid,
				(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $4)
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
			role_oids.cleanup_oid IS NOT NULL AS cleanup_role_exists,
			role_oids.legacy_oid IS NOT NULL AS legacy_role_exists,
			COALESCE(migration_role.rolcanlogin, false)
				AS migration_role_can_login,
			COALESCE(runtime_role.rolcanlogin, false)
				AS runtime_role_can_login,
			COALESCE(cleanup_role.rolcanlogin, false)
				AS cleanup_role_can_login,
			COALESCE(migration_role.rolsuper, false)
				AS migration_role_is_superuser,
			COALESCE(runtime_role.rolsuper, false)
				AS runtime_role_is_superuser,
			COALESCE(cleanup_role.rolsuper, false)
				AS cleanup_role_is_superuser,
			COALESCE(migration_role.rolconnlimit, -1)
				AS migration_role_connection_limit,
			COALESCE(runtime_role.rolconnlimit, -1)
				AS runtime_role_connection_limit,
			COALESCE(cleanup_role.rolconnlimit, -1)
				AS cleanup_role_connection_limit,
			CASE WHEN role_oids.migration_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.migration_oid
				) END AS current_user_is_migration_member,
			CASE WHEN role_oids.migration_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.migration_oid
						AND membership.set_option
				) END AS current_user_can_set_migration,
			CASE WHEN role_oids.runtime_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.runtime_oid
				) END AS current_user_is_runtime_member,
			CASE WHEN role_oids.runtime_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.runtime_oid
						AND membership.set_option
				) END AS current_user_can_set_runtime,
			CASE WHEN role_oids.cleanup_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.cleanup_oid
				) END AS current_user_is_cleanup_member,
			CASE WHEN role_oids.cleanup_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.cleanup_oid
						AND membership.set_option
				) END AS current_user_can_set_cleanup,
			CASE WHEN role_oids.legacy_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.legacy_oid
				) END AS current_user_is_legacy_member,
			CASE WHEN role_oids.legacy_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = login_role.oid
						AND membership.roleid = role_oids.legacy_oid
						AND membership.set_option
				) END AS current_user_can_set_legacy,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = role_oids.migration_oid
						AND membership.roleid = role_oids.runtime_oid
				) END AS migration_is_runtime_member,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = role_oids.migration_oid
						AND membership.roleid = role_oids.runtime_oid
						AND membership.set_option
				) END AS migration_can_set_runtime,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.cleanup_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.migration_oid, role_oids.cleanup_oid, 'MEMBER'
				) END AS migration_is_cleanup_member,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.cleanup_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.migration_oid, role_oids.cleanup_oid, 'SET'
				) END AS migration_can_set_cleanup,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.migration_oid, role_oids.legacy_oid, 'MEMBER'
				) END AS migration_is_legacy_member,
			CASE WHEN role_oids.migration_oid IS NULL
				OR role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.migration_oid, role_oids.legacy_oid, 'SET'
				) END AS migration_can_set_legacy,
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = role_oids.cleanup_oid
						AND membership.roleid = role_oids.runtime_oid
				) END AS cleanup_is_runtime_member,
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_auth_members AS membership
					WHERE membership.member = role_oids.cleanup_oid
						AND membership.roleid = role_oids.runtime_oid
						AND membership.set_option
				) END AS cleanup_can_set_runtime,
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.migration_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.cleanup_oid, role_oids.migration_oid, 'MEMBER'
				) END AS cleanup_is_migration_member,
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.migration_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.cleanup_oid, role_oids.migration_oid, 'SET'
				) END AS cleanup_can_set_migration,
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.cleanup_oid, role_oids.legacy_oid, 'MEMBER'
				) END AS cleanup_is_legacy_member,
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.legacy_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.cleanup_oid, role_oids.legacy_oid, 'SET'
				) END AS cleanup_can_set_legacy,
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
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.runtime_oid, role_oids.cleanup_oid, 'MEMBER'
				) END AS runtime_is_cleanup_member,
			CASE WHEN role_oids.cleanup_oid IS NULL
				OR role_oids.runtime_oid IS NULL THEN false ELSE
				pg_catalog.pg_has_role(
					role_oids.runtime_oid, role_oids.cleanup_oid, 'SET'
				) END AS runtime_can_set_cleanup,
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
				) AS legacy_default_acl_count,
				(
					SELECT count(*)::integer
					FROM pg_catalog.pg_extension AS extension
					WHERE extension.extname = ANY($5::text[])
				) AS required_extension_count,
				(
					SELECT count(*)::integer
					FROM pg_catalog.pg_extension AS extension
					WHERE extension.extname = ANY($5::text[])
						AND extension.extowner = role_oids.migration_oid
				) AS required_extensions_owned_by_migration,
				EXISTS (
					SELECT 1
					FROM pg_catalog.pg_extension AS extension
					WHERE extension.extname = 'pgaudit'
				) AS pgaudit_present
		FROM pg_catalog.pg_roles AS login_role
		CROSS JOIN role_oids
		CROSS JOIN database_row
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.nspname = 'public'
		LEFT JOIN pg_catalog.pg_roles AS migration_role
			ON migration_role.oid = role_oids.migration_oid
		LEFT JOIN pg_catalog.pg_roles AS runtime_role
			ON runtime_role.oid = role_oids.runtime_oid
		LEFT JOIN pg_catalog.pg_roles AS cleanup_role
			ON cleanup_role.oid = role_oids.cleanup_oid
		WHERE login_role.rolname = current_user`,
		[
			config.migrationRole,
			config.runtimeRole,
			config.cleanupRole,
			config.legacyRole,
			config.requiredExtensions,
		],
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
		cleanupRoleExists: row.cleanup_role_exists,
		legacyRoleExists: row.legacy_role_exists,
		migrationRoleCanLogin: row.migration_role_can_login,
		runtimeRoleCanLogin: row.runtime_role_can_login,
		cleanupRoleCanLogin: row.cleanup_role_can_login,
		migrationRoleIsSuperuser: row.migration_role_is_superuser,
		runtimeRoleIsSuperuser: row.runtime_role_is_superuser,
		cleanupRoleIsSuperuser: row.cleanup_role_is_superuser,
		migrationRoleConnectionLimit: row.migration_role_connection_limit,
		runtimeRoleConnectionLimit: row.runtime_role_connection_limit,
		cleanupRoleConnectionLimit: row.cleanup_role_connection_limit,
		currentUserIsMigrationMember: row.current_user_is_migration_member,
		currentUserCanSetMigration: row.current_user_can_set_migration,
		currentUserIsRuntimeMember: row.current_user_is_runtime_member,
		currentUserCanSetRuntime: row.current_user_can_set_runtime,
		currentUserIsCleanupMember: row.current_user_is_cleanup_member,
		currentUserCanSetCleanup: row.current_user_can_set_cleanup,
		currentUserIsLegacyMember: row.current_user_is_legacy_member,
		currentUserCanSetLegacy: row.current_user_can_set_legacy,
		migrationIsRuntimeMember: row.migration_is_runtime_member,
		migrationCanSetRuntime: row.migration_can_set_runtime,
		migrationIsCleanupMember: row.migration_is_cleanup_member,
		migrationCanSetCleanup: row.migration_can_set_cleanup,
		migrationIsLegacyMember: row.migration_is_legacy_member,
		migrationCanSetLegacy: row.migration_can_set_legacy,
		cleanupIsRuntimeMember: row.cleanup_is_runtime_member,
		cleanupCanSetRuntime: row.cleanup_can_set_runtime,
		cleanupIsMigrationMember: row.cleanup_is_migration_member,
		cleanupCanSetMigration: row.cleanup_can_set_migration,
		cleanupIsLegacyMember: row.cleanup_is_legacy_member,
		cleanupCanSetLegacy: row.cleanup_can_set_legacy,
		runtimeIsMigrationMember: row.runtime_is_migration_member,
		runtimeCanSetMigration: row.runtime_can_set_migration,
		runtimeIsCleanupMember: row.runtime_is_cleanup_member,
		runtimeCanSetCleanup: row.runtime_can_set_cleanup,
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
		requiredExtensionCount: row.required_extension_count,
		requiredExtensionsOwnedByMigration:
			row.required_extensions_owned_by_migration,
		pgauditPresent: row.pgaudit_present,
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
