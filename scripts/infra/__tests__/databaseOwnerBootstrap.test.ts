import { describe, expect, test } from "vitest";
import {
	assertDatabaseBootstrapPreconditions,
	assertDatabaseBootstrapResult,
	type DatabaseBootstrapFacts,
	databaseOwnerBootstrapStatements,
	LEGACY_DATABASE_ROLE,
	quoteIdentifier,
} from "../databaseOwnerBootstrap";

const safeFacts: DatabaseBootstrapFacts = {
	currentUser: "nova-deployment-bootstrap",
	currentDatabase: "nova_cases",
	currentUserCanCreateRole: true,
	currentUserCanCreateDatabase: true,
	currentUserIsCloudSqlSuperuser: true,
	databaseOwner: "nova-migrate@commcare-nova.iam",
	publicSchemaOwner: "pg_database_owner",
	migrationRoleExists: true,
	runtimeRoleExists: true,
	cleanupRoleExists: true,
	legacyRoleExists: true,
	migrationRoleCanLogin: true,
	runtimeRoleCanLogin: true,
	cleanupRoleCanLogin: true,
	migrationRoleIsSuperuser: false,
	runtimeRoleIsSuperuser: false,
	cleanupRoleIsSuperuser: false,
	migrationRoleConnectionLimit: 1,
	runtimeRoleConnectionLimit: 16,
	cleanupRoleConnectionLimit: 3,
	currentUserIsMigrationMember: true,
	currentUserCanSetMigration: true,
	currentUserIsRuntimeMember: true,
	currentUserCanSetRuntime: true,
	currentUserIsCleanupMember: true,
	currentUserCanSetCleanup: true,
	currentUserIsLegacyMember: true,
	currentUserCanSetLegacy: true,
	migrationIsRuntimeMember: true,
	migrationCanSetRuntime: true,
	migrationIsCleanupMember: false,
	migrationCanSetCleanup: false,
	migrationIsLegacyMember: false,
	migrationCanSetLegacy: false,
	cleanupIsRuntimeMember: false,
	cleanupCanSetRuntime: false,
	cleanupIsMigrationMember: false,
	cleanupCanSetMigration: false,
	cleanupIsLegacyMember: false,
	cleanupCanSetLegacy: false,
	runtimeIsMigrationMember: false,
	runtimeCanSetMigration: false,
	runtimeIsCleanupMember: false,
	runtimeCanSetCleanup: false,
	runtimeIsLegacyMember: false,
	runtimeCanSetLegacy: false,
	runtimeCanCreateDatabase: false,
	runtimeCanCreatePublicSchema: false,
	legacyCanCreateDatabase: false,
	legacyCanCreatePublicSchema: false,
	currentUserDependencyCount: 0,
	currentUserForeignOrSharedDependencyCount: 0,
	currentUserOwnedSchemaCount: 0,
	currentUserOwnedRelationCount: 0,
	currentUserOwnedRoutineCount: 0,
	currentUserDefaultAclCount: 0,
	legacyDependencyCount: 0,
	legacyForeignOrSharedDependencyCount: 0,
	legacyOwnedSchemaCount: 0,
	legacyOwnedRelationCount: 0,
	legacyOwnedRoutineCount: 0,
	legacyDefaultAclCount: 0,
	requiredExtensionCount: 4,
	requiredExtensionsOwnedByMigration: 4,
	pgauditPresent: true,
};

describe("deployment database owner bootstrap", () => {
	test("quotes identifiers and emits the legacy ownership transfer without SQL membership changes", () => {
		expect(quoteIdentifier('role"name')).toBe('"role""name"');
		expect(databaseOwnerBootstrapStatements(safeFacts)).toEqual([
			'CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA public',
			'CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch" WITH SCHEMA public',
			'CREATE EXTENSION IF NOT EXISTS "postgis" WITH SCHEMA public',
			'CREATE EXTENSION IF NOT EXISTS "pgaudit" WITH SCHEMA public',
			'ALTER ROLE "commcare-nova@commcare-nova.iam" CONNECTION LIMIT 16',
			'ALTER ROLE "nova-migrate@commcare-nova.iam" CONNECTION LIMIT 1',
			'ALTER ROLE "nova-capture-cleanup@commcare-nova.iam" CONNECTION LIMIT 3',
			'ALTER DATABASE "nova_cases" OWNER TO "nova-migrate@commcare-nova.iam"',
			`REASSIGN OWNED BY "${LEGACY_DATABASE_ROLE}" TO "nova-migrate@commcare-nova.iam"`,
			`DROP OWNED BY "${LEGACY_DATABASE_ROLE}" RESTRICT`,
			'REASSIGN OWNED BY "nova-deployment-bootstrap" TO "nova-migrate@commcare-nova.iam"',
			'DROP OWNED BY "nova-deployment-bootstrap" RESTRICT',
		]);
		expect(
			databaseOwnerBootstrapStatements({
				...safeFacts,
				legacyRoleExists: false,
			}),
		).toEqual([
			'CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA public',
			'CREATE EXTENSION IF NOT EXISTS "fuzzystrmatch" WITH SCHEMA public',
			'CREATE EXTENSION IF NOT EXISTS "postgis" WITH SCHEMA public',
			'CREATE EXTENSION IF NOT EXISTS "pgaudit" WITH SCHEMA public',
			'ALTER ROLE "commcare-nova@commcare-nova.iam" CONNECTION LIMIT 16',
			'ALTER ROLE "nova-migrate@commcare-nova.iam" CONNECTION LIMIT 1',
			'ALTER ROLE "nova-capture-cleanup@commcare-nova.iam" CONNECTION LIMIT 3',
			'ALTER DATABASE "nova_cases" OWNER TO "nova-migrate@commcare-nova.iam"',
			'REASSIGN OWNED BY "nova-deployment-bootstrap" TO "nova-migrate@commcare-nova.iam"',
			'DROP OWNED BY "nova-deployment-bootstrap" RESTRICT',
		]);
	});

	test("requires API-prepared role memberships and a bounded legacy dependency set", () => {
		expect(() => assertDatabaseBootstrapPreconditions(safeFacts)).not.toThrow();
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				currentUserIsCloudSqlSuperuser: false,
			}),
		).toThrow("temporary built-in Cloud SQL administrator");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				migrationRoleExists: false,
			}),
		).toThrow("must exist before bootstrap");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				currentUserCanSetLegacy: false,
			}),
		).toThrow("MEMBER and SET access to runtime, migration, capture-cleanup");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				currentUserIsCleanupMember: false,
			}),
		).toThrow("MEMBER and SET access to runtime, migration, capture-cleanup");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				migrationCanSetRuntime: false,
			}),
		).toThrow("Migration must have MEMBER and SET");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				cleanupIsRuntimeMember: true,
			}),
		).toThrow("wider than the one-way migration-to-runtime grant");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				cleanupRoleExists: false,
			}),
		).toThrow("capture-cleanup IAM database users must exist");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				cleanupRoleCanLogin: false,
			}),
		).toThrow("must remain direct LOGIN roles");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				runtimeRoleIsSuperuser: true,
			}),
		).toThrow("must not be PostgreSQL superusers");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				cleanupIsMigrationMember: true,
			}),
		).toThrow("wider than the one-way migration-to-runtime grant");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				legacyForeignOrSharedDependencyCount: 1,
			}),
		).toThrow("outside nova_cases");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				currentUserForeignOrSharedDependencyCount: 1,
			}),
		).toThrow("temporary administrator has dependencies outside nova_cases");
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				runtimeCanCreatePublicSchema: true,
			}),
		).toThrow("runtime role still has effective CREATE");
	});

	test("admits a fresh instance without a legacy role or dependencies", () => {
		expect(() =>
			assertDatabaseBootstrapPreconditions({
				...safeFacts,
				legacyRoleExists: false,
				currentUserIsLegacyMember: false,
				currentUserCanSetLegacy: false,
			}),
		).not.toThrow();
	});

	test("proves ownership, one-way membership, and complete legacy cleanup", () => {
		expect(() => assertDatabaseBootstrapResult(safeFacts)).not.toThrow();
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				pgauditPresent: false,
			}),
		).toThrow("required database extensions");
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				requiredExtensionsOwnedByMigration: 3,
			}),
		).toThrow("required database extensions");
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				runtimeIsMigrationMember: true,
			}),
		).toThrow("wider than the one-way migration-to-runtime grant");
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				runtimeRoleConnectionLimit: 17,
			}),
		).toThrow("connection limits are unsafe");
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				legacyDependencyCount: 1,
			}),
		).toThrow("legacy role still owns objects or holds privileges");
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				currentUserDependencyCount: 1,
			}),
		).toThrow("temporary administrator still owns objects");
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				runtimeCanCreateDatabase: true,
			}),
		).toThrow("effective CREATE");
	});
});
