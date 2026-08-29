/** READ ONLY: preflight Better Auth 1.7's complete OAuth client cutover. */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	renderBetterAuthOauthClientReport,
	scanBetterAuthOauthClients,
} from "@/scripts/lib/betterAuthOauthClientMigration";
import { runMain } from "@/scripts/lib/main";
import { targetProdDb } from "@/scripts/lib/prodDb";

interface Options {
	readonly prod?: boolean;
}

const program = new Command();
program
	.name("scan-better-auth-oauth-clients")
	.description(
		"Verify OAuth client types, scopes, protected-resource links, and retired columns for Better Auth 1.7 without returning client data.",
	)
	.option("--prod", "scan production through the read-only operator identity")
	.addHelpText(
		"after",
		"\nA legacy-ready result is expected before deployment. After traffic drains and finalization runs, current with both legacy column fields false and rollingDeployTriggerCount 0 is the required postcondition.\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	try {
		const pool = await getCaseStorePool();
		const client = await pool.connect();
		try {
			await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
			const report = await scanBetterAuthOauthClients(client);
			await client.query("COMMIT");
			console.log(renderBetterAuthOauthClientReport(report));
			if (
				report.state === "legacy-ready" ||
				report.state === "blocked" ||
				report.legacyPublicColumnPresent ||
				report.legacyTypeColumnPresent ||
				report.rollingDeployTriggerCount !== 0
			) {
				process.exitCode = 1;
			}
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
