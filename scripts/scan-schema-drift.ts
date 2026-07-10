/**
 * READ-ONLY — report every app whose stored `case_type_schemas` rows
 * differ from the schemas its blueprint derives today.
 *
 * Derived property typing (the effective case-type view) changed what
 * schemas + expression indexes are built from; stored rows for
 * pre-derivation apps were materialized from the raw catalog and stay
 * stale until an edit happens to touch their case type. This scan
 * makes the deploy-boundary delta visible; `migrate-schema-drift.ts`
 * converges it. Run this before the migrate, and again after (the
 * re-scan must report zero drift).
 *
 * `--app` scopes to one app, `--specs` expands refined properties with
 * their stored → derived spec (canonical JSON), and `--prod` targets
 * the production instance over its public IP (see `./lib/prodDb.ts`).
 * Run with `--help` for flags.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { loadApp } from "../lib/db/apps";
import { getAppDb } from "../lib/db/pg";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import { type CaseTypeDrift, computeSchemaDrift } from "./lib/schemaDrift";

interface ScanDriftOptions {
	app?: string;
	specs?: boolean;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-schema-drift")
	.description(
		"Report every app whose stored case_type_schemas rows differ from the schemas its blueprint derives today (read-only). " +
			"Run before migrate-schema-drift.ts, and again after it (the re-scan must report zero drift).",
	)
	.option("--app <appId>", "scope the scan to a single app")
	.option(
		"--specs",
		"expand each refined property with its stored → derived spec (canonical JSON) instead of names only",
	)
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.addHelpText(
		"after",
		"\nDatabase:\n" +
			"  Scans whatever the env points at — NOVA_DB_LOCAL_URL for a local\n" +
			"  Postgres, or the Cloud SQL connector env. --prod is the shorthand\n" +
			"  for the per-developer prod-read setup (see scripts/lib/prodDb.ts).\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/scan-schema-drift.ts\n" +
			"  $ npx tsx scripts/scan-schema-drift.ts --prod\n" +
			"  $ npx tsx scripts/scan-schema-drift.ts --app <appId> --specs --prod\n",
	);
program.parse();
const opts = program.opts<ScanDriftOptions>();
if (opts.prod === true) {
	targetProdDb();
}

function driftLines(drift: CaseTypeDrift, showSpecs: boolean): string {
	const parts: string[] = [];
	if (drift.missingRow)
		parts.push("    no stored schema row (re-sync creates it)");
	if (drift.added.length > 0)
		parts.push(`    added (re-sync): ${drift.added.join(", ")}`);
	if (drift.removed.length > 0)
		parts.push(`    removed (re-sync): ${drift.removed.join(", ")}`);
	if (drift.refined.length > 0) {
		if (showSpecs) {
			for (const r of drift.refined) {
				parts.push(
					`    spec refined ${r.property} (re-sync): ${r.fromSpec} → ${r.toSpec}`,
				);
			}
		} else {
			parts.push(
				`    spec refined (re-sync): ${drift.refined.map((r) => r.property).join(", ")}`,
			);
		}
	}
	for (const r of drift.retyped) {
		parts.push(
			`    RETYPE ${r.property}: ${r.fromType} → ${r.toType}  (${r.fromSpec} → ${r.toSpec})`,
		);
	}
	for (const u of drift.unresolvable) {
		parts.push(
			`    ✗ UNRESOLVABLE stored spec (needs owner): ${u.property} — stored ${u.storedSpec}`,
		);
	}
	return parts.join("\n");
}

async function main() {
	const appDb = await getAppDb();
	const caseDb = await getCaseStoreDatabase();
	console.log("Scanning stored schemas against derived blueprints…\n");

	let appQuery = appDb.selectFrom("apps").select("id");
	if (opts.app !== undefined) {
		appQuery = appQuery.where("id", "=", opts.app);
	}
	const appRows = await appQuery.execute();
	if (opts.app !== undefined && appRows.length === 0) {
		console.error(`App ${opts.app} not found.`);
		process.exit(1);
	}
	let appsWithDrift = 0;
	let retypeTotal = 0;
	let resyncOnlyTypes = 0;
	let unresolvableTotal = 0;
	const failedApps: string[] = [];

	for (const { id } of appRows) {
		const appDoc = await loadApp(id).catch((err: unknown) => {
			failedApps.push(id);
			console.log(
				`${id}\n  ✗ COULDN'T SCAN — the stored blueprint couldn't be assembled:\n` +
					`      ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return null;
		});
		if (!appDoc) continue;

		const drifts = await computeSchemaDrift(caseDb, id, appDoc.blueprint);
		if (drifts.length === 0) continue;
		appsWithDrift++;
		console.log(`${id} (${appDoc.app_name || "unnamed"})`);
		for (const drift of drifts) {
			const hasRetype = drift.retyped.length > 0;
			retypeTotal += drift.retyped.length;
			unresolvableTotal += drift.unresolvable.length;
			if (!hasRetype && drift.unresolvable.length === 0) resyncOnlyTypes++;
			console.log(`  case type "${drift.caseType}":`);
			console.log(driftLines(drift, opts.specs === true));
		}
		console.log("");
	}

	console.log(
		`${appRows.length} app(s) scanned; ${appsWithDrift} with schema drift; ` +
			`${retypeTotal} property retype(s); ${resyncOnlyTypes} case type(s) need only a plain re-sync; ` +
			`${unresolvableTotal} unresolvable spec(s)` +
			(failedApps.length > 0
				? `; ${failedApps.length} app(s) couldn't be scanned: ${failedApps.join(", ")}`
				: ""),
	);
	if (appsWithDrift > 0) {
		console.log(
			"\nNext: npx tsx scripts/migrate-schema-drift.ts        (dry-run plan)" +
				"\n      npx tsx scripts/migrate-schema-drift.ts --execute",
		);
	}
	await closeCaseStoreDatabase();
}

runMain(main);
