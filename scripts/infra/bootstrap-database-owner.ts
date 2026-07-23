#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
	AuthTypes,
	Connector,
	IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";
import { Client } from "pg";
import {
	assertDatabaseBootstrapPreconditions,
	assertDatabaseBootstrapResult,
	type DatabaseBootstrapFacts,
	DEPLOYMENT_DATABASE,
	databaseOwnerBootstrapStatements,
	MIGRATION_DATABASE_ROLE,
	RUNTIME_DATABASE_ROLE,
} from "./databaseOwnerBootstrap";

const INSTANCE_CONNECTION_NAME = "commcare-nova:us-central1:nova-cases";

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`Required environment variable ${name} is missing.`);
	}
	return value;
}

async function readFacts(client: Client): Promise<DatabaseBootstrapFacts> {
	const result = await client.query<{
		current_user: string;
		current_user_can_create_role: boolean;
		current_user_can_create_database: boolean;
		current_user_is_cloudsqlsuperuser: boolean;
		database_owner: string;
		public_schema_owner: string;
		migration_role_exists: boolean;
		runtime_role_exists: boolean;
		migration_can_use_runtime: boolean;
		runtime_can_use_migration: boolean;
		current_user_can_use_migration: boolean;
	}>(
		`SELECT
			current_user,
			current_role.rolcreaterole AS current_user_can_create_role,
			current_role.rolcreatedb AS current_user_can_create_database,
			pg_has_role(current_user, 'cloudsqlsuperuser', 'MEMBER')
				AS current_user_is_cloudsqlsuperuser,
			pg_get_userbyid(database.datdba) AS database_owner,
			pg_get_userbyid(namespace.nspowner) AS public_schema_owner,
			to_regrole($1) IS NOT NULL AS migration_role_exists,
			to_regrole($2) IS NOT NULL AS runtime_role_exists,
			CASE WHEN to_regrole($1) IS NULL OR to_regrole($2) IS NULL THEN false
				ELSE pg_has_role($1, $2, 'USAGE') END AS migration_can_use_runtime,
			CASE WHEN to_regrole($1) IS NULL OR to_regrole($2) IS NULL THEN false
				ELSE pg_has_role($2, $1, 'USAGE') END AS runtime_can_use_migration,
			CASE WHEN to_regrole($1) IS NULL THEN false
				ELSE pg_has_role(current_user, $1, 'USAGE') END
				AS current_user_can_use_migration
		FROM pg_catalog.pg_roles AS current_role
		JOIN pg_catalog.pg_database AS database
			ON database.datname = current_database()
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.nspname = 'public'
		WHERE current_role.rolname = current_user`,
		[MIGRATION_DATABASE_ROLE, RUNTIME_DATABASE_ROLE],
	);
	const row = result.rows[0];
	if (!row) throw new Error("Database bootstrap fact query returned no row.");
	return {
		currentUser: row.current_user,
		currentUserCanCreateRole: row.current_user_can_create_role,
		currentUserCanCreateDatabase: row.current_user_can_create_database,
		currentUserIsCloudSqlSuperuser: row.current_user_is_cloudsqlsuperuser,
		databaseOwner: row.database_owner,
		publicSchemaOwner: row.public_schema_owner,
		migrationRoleExists: row.migration_role_exists,
		runtimeRoleExists: row.runtime_role_exists,
		migrationCanUseRuntime: row.migration_can_use_runtime,
		runtimeCanUseMigration: row.runtime_can_use_migration,
		currentUserCanUseMigration: row.current_user_can_use_migration,
	};
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			apply: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
	});
	if (values.help) {
		process.stdout.write(
			`${[
				"Usage: npx tsx scripts/infra/bootstrap-database-owner.ts [--apply]",
				"",
				"Required environment:",
				"  NOVA_DB_BOOTSTRAP_USER      temporary built-in Cloud SQL user",
				"  NOVA_DB_BOOTSTRAP_PASSWORD  its password",
				"",
				"Without --apply, validates and prints the exact SQL only.",
			].join("\n")}\n`,
		);
		return;
	}

	const connector = new Connector();
	const clientOptions = await connector.getOptions({
		instanceConnectionName: INSTANCE_CONNECTION_NAME,
		ipType: IpAddressTypes.PUBLIC,
		authType: AuthTypes.PASSWORD,
	});
	const client = new Client({
		...clientOptions,
		user: requiredEnvironment("NOVA_DB_BOOTSTRAP_USER"),
		password: requiredEnvironment("NOVA_DB_BOOTSTRAP_PASSWORD"),
		database: DEPLOYMENT_DATABASE,
		connectionTimeoutMillis: 10_000,
	});

	try {
		await client.connect();
		await client.query("SET search_path = pg_catalog");
		const before = await readFacts(client);
		assertDatabaseBootstrapPreconditions(before);
		const statements = databaseOwnerBootstrapStatements(before.currentUser);
		if (!values.apply) {
			process.stdout.write(
				`${JSON.stringify({ before, statements }, null, 2)}\n`,
			);
			return;
		}
		for (const statement of statements) await client.query(statement);
		const after = await readFacts(client);
		assertDatabaseBootstrapResult(after);
		process.stdout.write(`${JSON.stringify({ after }, null, 2)}\n`);
	} finally {
		await client.end().catch(() => undefined);
		connector.close();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exitCode = 1;
});
