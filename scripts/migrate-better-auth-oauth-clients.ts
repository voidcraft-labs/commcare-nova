/**
 * WRITER: backfill Better Auth 1.7 OAuth application types. Dry-run by
 * default. Production execution belongs to the immutable migrate image.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	migrateBetterAuthOauthClients,
	renderBetterAuthOauthClientReport,
	scanBetterAuthOauthClients,
} from "@/scripts/lib/betterAuthOauthClientMigration";
import { runMain } from "@/scripts/lib/main";

interface Options {
	readonly execute?: boolean;
}

const program = new Command();
program
	.name("migrate-better-auth-oauth-clients")
	.description(
		"Backfill reviewed native/web client types for Better Auth 1.7. Dry-run by default.",
	)
	.option(
		"--execute",
		"write the application-type backfill and rolling-deploy trigger",
	)
	.addHelpText(
		"after",
		"\nProduction writes run inside the immutable commcare-nova-migrate Cloud Run Job. There is intentionally no --prod writer shortcut.\n",
	);
program.parse();
const options = program.opts<Options>();

async function main(): Promise<void> {
	try {
		const pool = await getCaseStorePool();
		const report =
			options.execute === true
				? await migrateBetterAuthOauthClients(pool)
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
