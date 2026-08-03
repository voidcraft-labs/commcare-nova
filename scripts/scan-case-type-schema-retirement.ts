/**
 * READ-ONLY — find historical active schema rows for case types no longer in
 * their app's materializable Blueprint catalog. These are the pre-retirement-
 * lifecycle rows the paired migrate script marks inactive.
 */

import "dotenv/config";
import { Command } from "commander";
import {
	closeCaseStoreDatabase,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import { getAppDb, withAppTx } from "../lib/db/pg";
import { findCaseTypeSchemaRetirementFindings } from "./lib/caseTypeSchemaRetirement";
import { loadPersistedBlueprintInTransaction } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-type-schema-retirement")
	.description(
		"Report active case_type_schemas rows whose type is absent from the current Blueprint (read-only).",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--prod",
		"scan production Cloud SQL through your gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-case-type-schema-retirement.ts\n" +
			"  $ npx tsx scripts/scan-case-type-schema-retirement.ts --app <appId> --prod\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main() {
	const appDb = await getAppDb();
	const caseDb = await getCaseStoreDatabase();
	let query = appDb.selectFrom("apps").select(["id", "app_name"]);
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const apps = await query.execute();
	if (options.app !== undefined && apps.length === 0) {
		throw new Error(`App ${options.app} not found.`);
	}

	let candidateCount = 0;
	let retainedCaseCount = 0;
	let needsRetirement = false;
	let needsSchemaRepair = false;
	let needsIndexCleanup = false;
	const failedApps: string[] = [];
	for (const app of apps) {
		try {
			const blueprint = await withAppTx((tx) =>
				loadPersistedBlueprintInTransaction(tx, app.id),
			);
			if (blueprint === null) continue;
			const findings = await findCaseTypeSchemaRetirementFindings(
				caseDb,
				app.id,
				blueprint,
			);
			if (findings.length === 0) continue;
			console.log(`${app.id} (${app.app_name || "unnamed"})`);
			for (const candidate of findings) {
				candidateCount++;
				needsRetirement ||= candidate.issues.includes(
					"active-without-blueprint",
				);
				needsSchemaRepair ||= candidate.issues.includes(
					"inactive-current-blueprint",
				);
				needsIndexCleanup ||= candidate.issues.includes(
					"inactive-index-cleanup",
				);
				retainedCaseCount += candidate.caseCount;
				console.log(
					`  ${candidate.caseType}: ${candidate.issues.join(", ")}; schema seq ${candidate.syncedSeq}; ` +
						`index synced seq ${candidate.indexSyncedSeq}; ` +
						`${candidate.caseCount} retained case(s); ` +
						`${candidate.activeParkedValueCount} active + ${candidate.dismissedParkedValueCount} dismissed parked value(s); ` +
						`${candidate.expressionIndexCount} expression index(es)` +
						(candidate.pendingIndexSeq === null
							? ""
							: `; pending index seq ${candidate.pendingIndexSeq}`),
				);
			}
			console.log("");
		} catch (error) {
			failedApps.push(app.id);
			console.log(
				`${app.id}\n  FAILED TO SCAN: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
	}
	console.log(
		`${apps.length} app(s) scanned; ${candidateCount} schema retirement candidate(s); ` +
			`${retainedCaseCount} retained case row(s)` +
			(failedApps.length === 0
				? ""
				: `; ${failedApps.length} failed app(s): ${failedApps.join(", ")}`),
	);
	if (needsRetirement || needsIndexCleanup) {
		console.log(
			"\nNext: npx tsx scripts/migrate-case-type-schema-retirement.ts (dry run)\n" +
				"      npx tsx scripts/migrate-case-type-schema-retirement.ts --execute",
		);
	}
	if (needsSchemaRepair) {
		console.log(
			"\nCurrent Blueprint types with inactive schemas need schema repair:\n" +
				"      npx tsx scripts/migrate-schema-drift.ts (dry run)\n" +
				"      npx tsx scripts/migrate-schema-drift.ts --execute",
		);
	}
	if (candidateCount > 0 || failedApps.length > 0) process.exitCode = 1;
	await closeCaseStoreDatabase();
}

runMain(main);
