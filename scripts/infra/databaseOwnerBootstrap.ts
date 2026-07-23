export const DEPLOYMENT_DATABASE = "nova_cases";
export const MIGRATION_DATABASE_ROLE = "nova-migrate@commcare-nova.iam";
export const RUNTIME_DATABASE_ROLE = "commcare-nova@commcare-nova.iam";

export interface DatabaseBootstrapFacts {
	readonly currentUser: string;
	readonly currentUserCanCreateRole: boolean;
	readonly currentUserCanCreateDatabase: boolean;
	readonly currentUserIsCloudSqlSuperuser: boolean;
	readonly databaseOwner: string;
	readonly publicSchemaOwner: string;
	readonly migrationRoleExists: boolean;
	readonly runtimeRoleExists: boolean;
	readonly migrationCanUseRuntime: boolean;
	readonly runtimeCanUseMigration: boolean;
	readonly currentUserCanUseMigration: boolean;
}

export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export function databaseOwnerBootstrapStatements(
	currentUser: string,
): readonly string[] {
	const migration = quoteIdentifier(MIGRATION_DATABASE_ROLE);
	return Object.freeze([
		`GRANT ${quoteIdentifier(RUNTIME_DATABASE_ROLE)} TO ${migration}`,
		`GRANT ${migration} TO ${quoteIdentifier(currentUser)}`,
		`ALTER DATABASE ${quoteIdentifier(DEPLOYMENT_DATABASE)} OWNER TO ${migration}`,
		`REVOKE ${migration} FROM ${quoteIdentifier(currentUser)}`,
	]);
}

export function assertDatabaseBootstrapPreconditions(
	facts: DatabaseBootstrapFacts,
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
}

export function assertDatabaseBootstrapResult(
	facts: DatabaseBootstrapFacts,
): void {
	if (facts.databaseOwner !== MIGRATION_DATABASE_ROLE) {
		throw new Error("Migration identity does not own the Nova database.");
	}
	if (facts.publicSchemaOwner !== "pg_database_owner") {
		throw new Error("The public schema is not owned by pg_database_owner.");
	}
	if (!facts.migrationCanUseRuntime || facts.runtimeCanUseMigration) {
		throw new Error("Migration/runtime database membership is unsafe.");
	}
	if (facts.currentUserCanUseMigration) {
		throw new Error(
			"Bootstrap administrator retained migration-role membership.",
		);
	}
}
