/**
 * READ-ONLY: count the CommCare HQ apps that more than one Nova app publishes
 * to, read from the live `app` mappings of the deployment ledger, split by
 * how many of those Nova apps are not in recently deleted. It prints the two
 * counts and nothing else: no app, Project or project space is named.
 * `--prod` reads production through the operator IAM identity.
 *
 * Exit status: 0 where no CommCare HQ app has two or more such Nova apps,
 * 1 where one does, and 2 where the scan could not run (the counts were
 * never read), so a failed read is never taken for an answer.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import { sql } from "kysely";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { targetProdDb } from "./lib/prodDb";

const program = new Command();
program
	.name("scan-hq-app-claims")
	.description(
		"Count, without writing, the CommCare HQ apps that two or more Nova apps publish to: those where two or more of them are not in recently deleted, and those where at most one is. Prints the two counts only. Exits 0 when no CommCare HQ app has two or more such Nova apps, 1 when one does, and 2 when the scan could not run.",
	)
	.option(
		"--prod",
		"read production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Reads NOVA_DB_LOCAL_URL by default. --prod targets production via\n" +
			"  scripts/lib/prodDb.ts; it grants no write permissions.\n" +
			"\nExit status:\n" +
			"  0  no CommCare HQ app has two or more Nova apps not in recently deleted\n" +
			"  1  some CommCare HQ app has two or more such Nova apps\n" +
			"  2  the scan could not run, and counted nothing\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-hq-app-claims.ts\n" +
			"  $ npx tsx scripts/scan-hq-app-claims.ts --prod\n",
	);
program.parse();
const opts = program.opts<{ prod?: boolean }>();
if (opts.prod === true) targetProdDb();

/** The exit status of a scan that could not run, apart from 1, which is an answer. */
const FATAL_EXIT = 2;

async function main(): Promise<void> {
	try {
		const db = await getCaseStoreDatabase();
		const counts = await db
			.transaction()
			.setAccessMode("read only")
			.execute(async (tx) => {
				const result = await sql<{
					several_live: string;
					at_most_one_live: string;
				}>`
					SELECT
						count(*) FILTER (WHERE claims.live_apps >= 2)::text AS several_live,
						count(*) FILTER (WHERE claims.live_apps <= 1)::text AS at_most_one_live
					FROM (
						SELECT d.server, d.domain, r.remote_id,
							count(*) FILTER (WHERE a.deleted_at IS NULL) AS live_apps,
							count(*) FILTER (WHERE a.deleted_at IS NOT NULL) AS deleted_apps
						FROM app_deployment_resources r
						JOIN app_deployments d ON d.id = r.deployment_id
						JOIN apps a ON a.id = d.app_id
						WHERE r.kind = 'app' AND r.superseded_at IS NULL
						GROUP BY d.server, d.domain, r.remote_id
						HAVING count(*) > 1
					) AS claims
				`.execute(tx);
				const row = result.rows[0];
				if (row === undefined)
					throw new Error("The claim count returned no row.");
				return {
					severalLive: Number(row.several_live),
					atMostOneLive: Number(row.at_most_one_live),
				};
			});
		console.log(
			`Checked every CommCare HQ app a Nova app publishes to. CommCare HQ apps published to by two or more Nova apps that are not in recently deleted: ${counts.severalLive}. CommCare HQ apps published to by several Nova apps of which at most one is not in recently deleted: ${counts.atMostOneLive}. The migration handles the second kind by itself, and it stops the deploy while any of the first kind is there.`,
		);
		process.exitCode = counts.severalLive > 0 ? 1 : 0;
	} finally {
		await closeCaseStoreDatabase();
	}
}

main().catch((error: unknown) => {
	console.error("Fatal:", error);
	process.exit(FATAL_EXIT);
});
