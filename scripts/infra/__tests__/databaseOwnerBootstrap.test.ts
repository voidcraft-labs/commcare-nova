import { describe, expect, test } from "vitest";
import {
	assertDatabaseBootstrapPreconditions,
	assertDatabaseBootstrapResult,
	type DatabaseBootstrapFacts,
	databaseOwnerBootstrapStatements,
	quoteIdentifier,
} from "../databaseOwnerBootstrap";

const safeFacts: DatabaseBootstrapFacts = {
	currentUser: "nova-deployment-bootstrap",
	currentUserCanCreateRole: true,
	currentUserCanCreateDatabase: true,
	currentUserIsCloudSqlSuperuser: true,
	databaseOwner: "nova-migrate@commcare-nova.iam",
	publicSchemaOwner: "pg_database_owner",
	migrationRoleExists: true,
	runtimeRoleExists: true,
	migrationCanUseRuntime: true,
	runtimeCanUseMigration: false,
	currentUserCanUseMigration: false,
};

describe("deployment database owner bootstrap", () => {
	test("quotes identifiers and emits the bounded four-statement transfer", () => {
		expect(quoteIdentifier('role"name')).toBe('"role""name"');
		expect(databaseOwnerBootstrapStatements(safeFacts.currentUser)).toEqual([
			'GRANT "commcare-nova@commcare-nova.iam" TO "nova-migrate@commcare-nova.iam"',
			'GRANT "nova-migrate@commcare-nova.iam" TO "nova-deployment-bootstrap"',
			'ALTER DATABASE "nova_cases" OWNER TO "nova-migrate@commcare-nova.iam"',
			'REVOKE "nova-migrate@commcare-nova.iam" FROM "nova-deployment-bootstrap"',
		]);
	});

	test("requires an administrative built-in user and both IAM database roles", () => {
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
	});

	test("proves ownership and one-way migration-to-runtime membership", () => {
		expect(() => assertDatabaseBootstrapResult(safeFacts)).not.toThrow();
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				runtimeCanUseMigration: true,
			}),
		).toThrow("membership is unsafe");
		expect(() =>
			assertDatabaseBootstrapResult({
				...safeFacts,
				currentUserCanUseMigration: true,
			}),
		).toThrow("retained migration-role membership");
	});
});
