/**
 * WRITER: converge Better Auth 1.6 account identity onto the 1.7 issuer key.
 * Dry-run by default. Production execution belongs to the immutable migrate
 * image, never a human `--prod` connection.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	migrateBetterAuthAccountIdentity,
	renderBetterAuthAccountIdentityReport,
	scanBetterAuthAccountIdentity,
} from "@/scripts/lib/betterAuthAccountIdentity";
import { runMain } from "@/scripts/lib/main";

interface Options {
	readonly execute?: boolean;
}

const program = new Command();
program
	.name("migrate-better-auth-account-identity")
	.description(
		"Converge the reviewed Google and credential account identities for Better Auth 1.7. Dry-run by default.",
	)
	.option(
		"--execute",
		"write the issuer backfill, constraint, index, and rolling-deploy trigger",
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
				? await migrateBetterAuthAccountIdentity(pool)
				: await scanBetterAuthAccountIdentity(pool);
		console.log(renderBetterAuthAccountIdentityReport(report));
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
