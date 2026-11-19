/**
 * READ-ONLY: count the grants the `nova.hq.import` repair would change.
 *
 * Which rows, and why, is `lib/hqImportScope.ts`'s; its writer is
 * `migrate-hq-import-scope.ts`. The scan reads every kind in one read-only
 * snapshot and prints, per kind, how many rows the repair would change and how
 * many it leaves. It prints counts only, and writes nothing. `--prod` uses the
 * repository's read-only production inspection connection.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import {
	IMPORT_SCOPE,
	repairImportScope,
	repairLines,
} from "./lib/hqImportScope";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-hq-import-scope")
	.description(
		`Count the OAuth clients, consents, refresh tokens and API keys the ${IMPORT_SCOPE} repair would change (read-only).`,
	)
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Scans NOVA_DB_LOCAL_URL by default. --prod targets production via\n" +
			"  scripts/lib/prodDb.ts; it grants no write permissions. The\n" +
			"  maintenance image carries it as hq-import-scope-scan.cjs.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-hq-import-scope.ts\n" +
			"  $ npx tsx scripts/scan-hq-import-scope.ts --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

async function main(): Promise<void> {
	try {
		const repair = await repairImportScope(await getCaseStoreDatabase(), {
			execute: false,
		});
		console.log(`Grants and ${IMPORT_SCOPE} (read-only)\n`);
		for (const line of repairLines(repair)) console.log(line);
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
