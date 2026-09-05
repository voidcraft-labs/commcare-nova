/**
 * WRITER: converge Better Auth 1.7 OAuth clients and protected-resource links.
 * Dry-run by default. Production execution belongs to the immutable migrate
 * image.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	finalizeBetterAuth17OauthClients,
	migrateBetterAuthOauthClients,
	renderBetterAuthOauthClientReport,
	scanBetterAuthOauthClients,
} from "@/scripts/lib/betterAuthOauthClientMigration";
import { runMain } from "@/scripts/lib/main";

interface Options {
	readonly execute?: boolean;
	readonly finalize?: boolean;
}

const program = new Command();
program
	.name("migrate-better-auth-oauth-clients")
	.description(
		"Backfill reviewed native/web client types, empty client-credential scopes, and MCP resource links for Better Auth 1.7. Dry-run by default.",
	)
	.option(
		"--execute",
		"write the 1.7 client backfill, protected-resource links, and rolling-deploy guards",
	)
	.option(
		"--finalize",
		"remove retired columns and rolling-deploy guards after old requests drain; requires --execute to write",
	)
	.addHelpText(
		"after",
		"\nProduction writes run inside the explicit commcare-nova-historical-repair Job using the maintenance image. There is intentionally no --prod writer shortcut.\n",
	);
program.parse();
const options = program.opts<Options>();

async function main(): Promise<void> {
	try {
		const pool = await getCaseStorePool();
		const report =
			options.execute === true
				? options.finalize === true
					? await finalizeBetterAuth17OauthClients(pool)
					: await migrateBetterAuthOauthClients(pool)
				: await scanBetterAuthOauthClients(pool);
		console.log(renderBetterAuthOauthClientReport(report));
		if (options.execute !== true) {
			console.log(
				"\nDRY RUN: nothing written. Pass --execute to apply locally.",
			);
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
