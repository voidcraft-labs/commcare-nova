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
				"Mandatory one-time cutover order:",
				"  1. Provision the capture-cleanup IAM database user.",
				"  2. Create a temporary BUILT_IN user with a strong password and NO",
				"     inline --database-roles (inline roles suppress cloudsqlsuperuser).",
				"  3. After creation, assign runtime, migration, capture-cleanup, and",
				"     legacy when present to the temporary user WITHOUT",
				"     --revoke-existing-roles, preserving cloudsqlsuperuser.",
				"  4. Assign runtime as the sole custom role of migration and cleanup;",
				"     remove all reverse and legacy application-role memberships.",
				"  5. Run this command without --apply to audit, then with --apply to",
				"     transactionally set role limits and transfer ownership.",
				"  6. Delete the temporary user through Cloud SQL and verify it is absent.",
				"  7. Set Cloud Run global/revision maxima to 4, wait for runtime",
				"     sessions to drain to <=16, then run migration/cleanup Jobs.",
				"",
				"Without --apply, validates and prints the exact capacity/ownership SQL.",
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
