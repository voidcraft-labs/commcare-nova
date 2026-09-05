/**
 * WRITER: rewrite every persisted old-shape language spelling into the
 * structured-identity form, in place, across all four stores. Dry-run by
 * default; production execution belongs to the immutable migration image,
 * never a human `--prod` connection.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { getAppDb } from "../lib/db/pg";
import {
	languageIdentityPlanHasRewrites,
	loadLanguageIdentityRepairSource,
	planLanguageIdentityRepair,
	runLanguageIdentityRepair,
} from "./lib/languageIdentityRepair";
import { runMain } from "./lib/main";

interface Options {
	app?: string;
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-language-identity")
	.description(
		"Rewrite stored language state to the structured-identity shape, one proved transaction per app. Dry-run by default.",
	)
	.option("--app <appId>", "scope the repair to one app")
	.option("--execute", "write the rewrites")
	.addHelpText(
		"after",
		"\nProduction writes run inside the explicit commcare-nova-historical-repair Job using the maintenance image. There is intentionally no --prod writer shortcut.\n",
	);
program.parse();
const options = program.opts<Options>();

async function selectedAppIds(): Promise<string[]> {
	const db = await getAppDb();
	if (options.app !== undefined) {
		const row = await db
			.selectFrom("apps")
			.select("id")
			.where("id", "=", options.app)
			.executeTakeFirst();
		if (row === undefined) throw new Error(`App ${options.app} not found.`);
		return [options.app];
	}
	const rows = await db.selectFrom("apps").select("id").orderBy("id").execute();
	return rows.map((row) => row.id);
}

async function dryRun(appIds: readonly string[]): Promise<void> {
	let appsNeedingRewrites = 0;
	for (const appId of appIds) {
		const source = await loadLanguageIdentityRepairSource(appId);
		if (source === null) continue;
		const plan = planLanguageIdentityRepair(source);
		if (
			!languageIdentityPlanHasRewrites(plan) &&
			plan.blocked.length === 0 &&
			plan.neededMappings.length === 0
		) {
			continue;
		}
		appsNeedingRewrites += 1;
		console.log(`${appId} (${source.appName || "unnamed"})`);
		for (const finding of plan.findings) {
			console.log(
				`  ${finding.store} ${finding.ref}: ${finding.classification} — ${finding.detail}`,
			);
		}
		if (plan.neededMappings.length > 0) {
			console.log(
				`  NEEDS EXPLICIT MAPPINGS: ${plan.neededMappings.join(", ")}`,
			);
		}
	}
	console.log(
		`\nDRY RUN: nothing written. ${appsNeedingRewrites} app(s) would be rewritten. Pass --execute to apply.`,
	);
}

async function main(): Promise<void> {
	const appIds = await selectedAppIds();
	if (options.execute !== true) {
		await dryRun(appIds);
		return;
	}
	const report = await runLanguageIdentityRepair(
		options.app === undefined ? undefined : appIds,
	);
	console.log(
		`Rewrote ${report.rewrittenApps} of ${report.scannedApps} app(s): ` +
			`${report.rewrittenRoots} root(s), ${report.rewrittenChangeRows} change row(s) ` +
			`(${report.replacedEmptiedBatches} emptied batch(es) replaced), ${report.rewrittenBaselines} baseline(s), ` +
			`${report.rewrittenAttempts} attempt intent(s), ${report.rewrittenBatchRows} batch row(s); ` +
			`${report.canonicalRootApps} root(s) already canonical, ${report.nullRootApps} NULL root(s) untouched; ` +
			`${report.refoldProvenApps} app(s) proved by re-fold; ${report.verifiedApps} app(s) passed the fleet postcondition.`,
	);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
