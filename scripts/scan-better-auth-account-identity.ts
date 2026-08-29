/** READ ONLY: preflight Better Auth 1.7's account identity cutover. */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	renderBetterAuthAccountIdentityReport,
	scanBetterAuthAccountIdentity,
} from "@/scripts/lib/betterAuthAccountIdentity";
import { runMain } from "@/scripts/lib/main";
import { targetProdDb } from "@/scripts/lib/prodDb";

interface Options {
	readonly prod?: boolean;
}

const program = new Command();
program
	.name("scan-better-auth-account-identity")
	.description(
		"Inspect the Better Auth account issuer cutover without returning account or user identifiers.",
	)
	.option("--prod", "scan production through the read-only operator identity")
	.addHelpText(
		"after",
		"\nA legacy-ready result is the expected pre-deploy state and exits nonzero. Re-run after deployment; current is the required postcondition.\n",
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
			const report = await scanBetterAuthAccountIdentity(client);
			await client.query("COMMIT");
			console.log(renderBetterAuthAccountIdentityReport(report));
			if (report.state === "legacy-ready" || report.state === "blocked") {
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
