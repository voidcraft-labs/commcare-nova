#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
	AuthTypes,
	Connector,
	IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";
import { Client } from "pg";
import {
	DEPLOYMENT_DATABASE,
	executeDatabaseOwnerBootstrap,
	inspectDatabaseOwnerBootstrap,
} from "./databaseOwnerBootstrap";

const INSTANCE_CONNECTION_NAME = "commcare-nova:us-central1:nova-cases";

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) {
		throw new Error(`Required environment variable ${name} is missing.`);
	}
	return value;
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
				"Privileged bootstrap order:",
				"  1. Provision the runtime, migration, and capture-cleanup IAM database users.",
				"  2. Create a temporary BUILT_IN user with a strong password and NO",
				"     inline --database-roles (inline roles suppress cloudsqlsuperuser).",
				"  3. After creation, assign runtime, migration, capture-cleanup, and any",
				"     source owner the bootstrap must transfer WITHOUT",
				"     --revoke-existing-roles, preserving cloudsqlsuperuser.",
				"  4. Assign runtime as the sole custom role of migration; cleanup and",
				"     runtime have no application parent.",
				"  5. Run this LOCAL command through the Cloud SQL connector without",
				"     --apply to inspect extension owner/version/config/dependencies,",
				"     then with --apply to create missing extensions, set role limits,",
				"     transfer non-permanent ownership, and prove the exact result.",
				"     Cloud SQL Studio is optional for read-only SQL inspection; it",
				"     cannot run this repository's Node/TypeScript CLI.",
				"  6. Delete the temporary user through Cloud SQL and verify it is absent.",
				"",
				"Without --apply, validates and prints the exact role/ownership SQL.",
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
		if (!values.apply) {
			const inspection = await inspectDatabaseOwnerBootstrap(client);
			process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
			return;
		}
		const execution = await executeDatabaseOwnerBootstrap(client);
		process.stdout.write(`${JSON.stringify(execution, null, 2)}\n`);
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
