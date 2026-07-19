/**
 * READ-ONLY — find every stored app the case-workspace SCHEMA tightenings
 * would make unloadable: date patterns (date columns / `format-date`)
 * outside `COMMCARE_DATE_PATTERN_REGEX`, and `within-distance` filters
 * with a non-positive or meters-overflowing distance. These fail
 * `blueprintDocSchema.parse` on every read — builder, preview, chat,
 * export — so they can NOT wait for the validator repair pipeline.
 *
 * Deploy choreography: run this first, then
 * `migrate-case-list-tightening.ts` (dry-run, then `--execute`), then this
 * scan again — which must report ZERO apps. Validator-level strands (the
 * broadened column rule, excluded-owner case-data reads, on-device
 * expression gates) are scan-legacy-findings.ts's job, not this one's.
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL`
 * locally, the Cloud SQL connector env otherwise); `--prod` targets the
 * production instance over its public IP (see `./lib/prodDb.ts`). Never
 * writes. Run with `--help` for flags.
 */
import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { getAppDb } from "../lib/db/pg";
import { planTightening } from "./lib/caseListTightening";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-list-tightening")
	.description(
		"Report every stored app the tightened date-pattern / within-distance schemas would refuse to load (read-only). " +
			"Run before migrate-case-list-tightening.ts, and again after it (the re-scan must report zero apps).",
	)
	.option("--app <appId>", "scope the scan to a single app")
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-case-list-tightening.ts\n" +
			"  $ npx tsx scripts/scan-case-list-tightening.ts --prod\n",
	);

program.parse();
const opts = program.opts<ScanOptions>();
if (opts.prod === true) {
	targetProdDb();
}

async function main() {
	const db = await getAppDb();
	console.log("Scanning stored apps for schema-tightening strands…\n");
	const reports = await planTightening(db, { appId: opts.app });

	for (const report of reports) {
		console.log(
			`${report.appId} (${report.appName}) — ${report.fixes.length} strand(s)`,
		);
		for (const fix of report.fixes) {
			console.log(
				`  [${fix.kind}] ${fix.path}\n      stored: ${JSON.stringify(fix.stored)}`,
			);
		}
		if (report.parseError !== null) {
			console.log(
				`  ✗ NOT AUTO-MIGRATABLE — the repaired doc still fails parse:\n      ${report.parseError}\n` +
					"      Fix this app by hand (scripts/recover-app.ts), then re-scan.",
			);
		}
		console.log("");
	}

	if (reports.length === 0) {
		console.log(
			"No strands — every stored app loads under the tightened schemas.",
		);
		return;
	}
	console.log(
		`${reports.length} app(s) carry strands. Migrate with: npx tsx scripts/migrate-case-list-tightening.ts (dry run; add --execute to write).`,
	);
	process.exitCode = 1;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
