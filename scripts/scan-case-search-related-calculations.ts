/**
 * READ-ONLY — inventory persisted apps that the stricter Case Search
 * related-calculation validator would refuse.
 *
 * This is evidence for deciding whether a repair is necessary, not a repair.
 * Output names only stable app/module/column identities and aggregate counts;
 * it never prints authored labels, formulas, or case-data values.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	buildCaseSearchRelatedCalculationScanReport,
	type CaseSearchRelatedCalculationObservation,
	renderCaseSearchRelatedCalculationScanReport,
	scanCaseSearchRelatedCalculations,
} from "./lib/caseSearchRelatedCalculationScan";
import { loadPersistedBlueprintReadOnly } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-search-related-calculations")
	.description(
		"Report persisted apps that save a related-case calculation the effective Search projection cannot represent consistently (read-only).",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-case-search-related-calculations.ts\n" +
			"  $ npx tsx scripts/scan-case-search-related-calculations.ts --app <appId>\n" +
			"  $ npx tsx scripts/scan-case-search-related-calculations.ts --prod\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.orderBy("id").execute();
	if (options.app !== undefined && rows.length === 0) {
		throw new Error("No app matched --app.");
	}

	const observations: CaseSearchRelatedCalculationObservation[] = [];
	const unreadableAppIds: string[] = [];
	for (const { id } of rows) {
		try {
			const blueprint = await db
				.transaction()
				.setIsolationLevel("repeatable read")
				.setAccessMode("read only")
				.execute((tx) => loadPersistedBlueprintReadOnly(tx, id));
			if (blueprint === null) {
				unreadableAppIds.push(id);
				continue;
			}
			observations.push({
				appId: id,
				findings: scanCaseSearchRelatedCalculations(
					hydratePersistedBlueprint(blueprint),
				),
			});
		} catch {
			unreadableAppIds.push(id);
		}
	}

	const report = buildCaseSearchRelatedCalculationScanReport(
		observations,
		unreadableAppIds,
	);
	console.log(renderCaseSearchRelatedCalculationScanReport(report));
	process.exitCode = report.exitCode;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
