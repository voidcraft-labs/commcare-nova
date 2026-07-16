/**
 * READ-ONLY — report cases that carry a closure timestamp but not the
 * canonical built-in `status = "closed"` value.
 *
 * This detects rows written by Nova's former preview close path, which
 * stamped `closed_on` but left registration's `status = "open"` unchanged.
 * Run before `migrate-case-lifecycle-status.ts`, and again after it; the
 * re-scan must report zero rows. `--prod` uses the repository's read-only
 * production inspection connection.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import {
	type ClosedStatusMismatchGroup,
	scanClosedStatusMismatches,
} from "./lib/caseLifecycleStatus";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-lifecycle-status")
	.description(
		"Report closed cases whose built-in lifecycle status is not `closed` (read-only). Run before and after migrate-case-lifecycle-status.ts.",
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
			"  $ npx tsx scripts/scan-case-lifecycle-status.ts\n" +
			"  $ npx tsx scripts/scan-case-lifecycle-status.ts --prod\n" +
			"  $ npx tsx scripts/scan-case-lifecycle-status.ts --app <appId> --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

function printGroup(group: ClosedStatusMismatchGroup): void {
	console.log(
		`${group.appId} / ${group.caseType} / stored status ${JSON.stringify(group.storedStatus)}: ${group.rowCount} row(s)`,
	);
}

async function main(): Promise<void> {
	const db = await getCaseStoreDatabase();
	try {
		const groups = await scanClosedStatusMismatches(db, {
			appId: opts.app,
		});
		const total = groups.reduce((sum, group) => sum + group.rowCount, 0);
		console.log("Scanning closed-case lifecycle status (read-only)…\n");
		for (const group of groups) printGroup(group);
		console.log(
			`\n${total} mismatched closed row(s) across ${groups.length} app/type/status group(s).`,
		);
		if (total > 0) {
			console.log(
				"\nNext: run scripts/migrate-case-lifecycle-status.ts as a dry run, execute it in the target environment, then re-scan to zero.",
			);
			process.exitCode = 1;
		}
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
