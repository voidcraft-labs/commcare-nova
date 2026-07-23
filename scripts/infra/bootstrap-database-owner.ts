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
				"Cloud SQL Admin API prerequisite:",
				"  migration MEMBER+SET runtime; bootstrap user MEMBER+SET migration",
				"  and legacy (when present); runtime must no longer inherit legacy.",
				"",
				"Without --apply, validates and prints the exact ownership SQL only.",
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
