/**
 * READ-ONLY — verify that every persisted app's complete structural lookup
 * target set exactly matches its complete stored reference-edge set.
 *
 * This is the scan side of the lookup-carrier scan-then-migrate workflow. It
 * intentionally walks every app row, including soft-deleted/restorable apps,
 * because those apps retain edges until physical deletion. Structural targets
 * come from the production extractor registry, so a registry change is
 * automatically visible to this durable inspector.
 *
 * The script never repairs or mutates. Any mismatch, unassemblable blueprint,
 * extractor failure, or stored-edge read failure makes the process nonzero.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { renderLookupReferenceScanReport } from "./lib/lookupReferenceEdgeScan";
import { runMain } from "./lib/main";
import { scanPersistedLookupReferences } from "./lib/persistedLookupReferenceScan";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-lookup-reference-edges")
	.description(
		"Read-only fleet audit of structural lookup targets against stored app reference edges. Scans every persisted app, including soft-deleted/restorable apps, and exits nonzero on any mismatch or scan failure.",
	)
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Scans NOVA_DB_LOCAL_URL by default. --prod targets production via\n" +
			"  scripts/lib/prodDb.ts; neither mode grants or performs writes.\n" +
			"\nWorkflow:\n" +
			"  Run before the matching lookup-edge migration and again afterward.\n" +
			"  A clean rescan is required before carrier/schema-action activation.\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-lookup-reference-edges.ts\n" +
			"  $ npx tsx scripts/scan-lookup-reference-edges.ts --prod\n",
	);
program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) targetProdDb();

async function main(): Promise<void> {
	try {
		const db = await getAppDb();
		const report = await scanPersistedLookupReferences(db);
		console.log(renderLookupReferenceScanReport(report));
		process.exitCode = report.exitCode;
	} finally {
		await closeCaseStoreDatabase();
	}
}

runMain(main);
