/**
 * READ-ONLY — report cases whose JSONB property document holds a
 * `location_id` key, which the case's own location column replaced
 * (`scripts/lib/caseLocationProperties.ts`).
 *
 * Run before `migrate-case-location-properties.ts`, and again after it; the
 * re-scan must report zero rows. `--prod` uses the repository's read-only
 * production inspection connection.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { scanCaseLocationProperties } from "./lib/caseLocationProperties";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-location-properties")
	.description(
		"Report cases whose property document holds location_id, which the case's location column replaced (read-only). Run before and after migrate-case-location-properties.ts.",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Scans NOVA_DB_LOCAL_URL by default. --prod targets production via\n" +
			"  scripts/lib/prodDb.ts; it grants no write permissions.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-case-location-properties.ts\n" +
			"  $ npx tsx scripts/scan-case-location-properties.ts --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();
	try {
		const groups = await scanCaseLocationProperties(db, { appId: opts.app });
		console.log(
			"Scanning case property documents for location_id (read-only)…\n",
		);
		for (const group of groups)
			console.log(
				`${group.appId} / ${group.caseType}: ${group.rowCount} row(s), ${group.columnHeld} whose location column already holds a value`,
			);
		const total = groups.reduce((sum, group) => sum + group.rowCount, 0);
		console.log(
			`\n${total} row(s) across ${groups.length} app/type group(s) hold location_id in their property document.`,
		);
		if (total > 0) {
			console.log(
				"\nNext: run scripts/migrate-case-location-properties.ts as a dry run, execute it in the target environment, then re-scan to zero.",
			);
			process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
