/**
 * READ-ONLY — inventory persisted hidden fields that carry BOTH a `calculate`
 * and a `default_value`, the pair the validator rule
 * `HIDDEN_VALUE_BOTH_SOURCES` refuses one release from now.
 *
 * Evidence for the repair and its postcondition, never a repair. Output names
 * only stable app/form/field identities and aggregate counts; it never prints
 * an authored label or expression. Every `apps` row is scanned, soft-deleted
 * included: the deploy migration probe audits deleted rows too, so a deleted
 * offender would fail the release exactly like a live one.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	buildHiddenValueBothSourcesScanReport,
	type HiddenValueBothSourcesObservation,
	renderHiddenValueBothSourcesScanReport,
	scanHiddenValueBothSources,
} from "./lib/hiddenValueBothSourcesScan";
import { loadPersistedBlueprintReadOnly } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-hidden-value-both-sources")
	.description(
		"Report persisted hidden fields carrying both a calculate and a default_value (read-only).",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--prod",
		"scan production Cloud SQL through your read-only gcloud IAM identity",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-hidden-value-both-sources.ts\n" +
			"  $ npx tsx scripts/scan-hidden-value-both-sources.ts --app <appId>\n" +
			"  $ npx tsx scripts/scan-hidden-value-both-sources.ts --prod\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	// No `deleted_at` filter: the migration probe audits deleted rows.
	let query = db.selectFrom("apps").select("id");
	if (options.app !== undefined) query = query.where("id", "=", options.app);
	const rows = await query.orderBy("id").execute();
	if (options.app !== undefined && rows.length === 0) {
		throw new Error("No app matched --app.");
	}

	const observations: HiddenValueBothSourcesObservation[] = [];
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
				findings: scanHiddenValueBothSources(
					hydratePersistedBlueprint(blueprint),
				),
			});
		} catch {
			unreadableAppIds.push(id);
		}
	}

	const report = buildHiddenValueBothSourcesScanReport(
		observations,
		unreadableAppIds,
	);
	console.log(renderHiddenValueBothSourcesScanReport(report));
	process.exitCode = report.exitCode;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
