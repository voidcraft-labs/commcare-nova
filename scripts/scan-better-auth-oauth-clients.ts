/** READ ONLY: preflight Better Auth 1.7's OAuth client application types. */

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
		"Classify OAuth clients for Better Auth 1.7 without returning redirect URIs or client identifiers.",
	)
	.option("--prod", "scan production through the read-only operator identity");
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
