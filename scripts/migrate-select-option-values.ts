/**
 * WRITER: rewrite every choice value the stored-value grammar refuses to the
 * slug the validator suggests, in the document (through the synthetic
 * writer, as ordinary history) and in the case rows holding the old token.
 * Dry-run by default; production execution belongs to the immutable
 * migration image, never a human `--prod` connection.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	countCaseRowsHoldingOldValues,
	describeRewrite,
	listRepairCandidateAppIds,
	loadSelectOptionValueRepairSnapshot,
	planSelectOptionValueRepair,
	runSelectOptionValueRepair,
} from "./lib/selectOptionValueRepair";

interface Options {
	execute?: boolean;
	app?: string[];
}

const program = new Command();
program
	.name("migrate-select-option-values")
	.description(
		"Repair choice values holding a space, a quote mark, or nothing (field options, the case-type catalog, the case rows, and close conditions). Dry-run by default.",
	)
	.option("--execute", "write the repair")
	.option("--app <id...>", "limit the repair to these app ids")
	.addHelpText(
		"after",
		"\nProduction writes run inside the immutable commcare-nova-migrate Cloud Run Job. There is intentionally no --prod writer shortcut.\n",
	);
program.parse();
const options = program.opts<Options>();

async function dryRun(appIds: readonly string[]): Promise<void> {
	for (const appId of appIds) {
		const snapshot = await loadSelectOptionValueRepairSnapshot(appId);
		if (snapshot === null) continue;
		const plan = planSelectOptionValueRepair(snapshot.blueprint);
		if (plan.rewrites.length === 0) continue;
		console.log(`${appId} (${snapshot.appName || "unnamed"})`);
		for (const rewrite of plan.rewrites) {
			console.log(`  ${describeRewrite(rewrite)}`);
		}
		for (const rewrite of plan.casePropertyRewrites) {
			const rows = await countCaseRowsHoldingOldValues(appId, rewrite);
			if (rows > 0) {
				console.log(
					`  ${rows} case row(s) of ${rewrite.caseType}.${rewrite.property} would be rewritten`,
				);
			}
		}
		if (plan.closeConditionRewrites > 0) {
			console.log(
				`  ${plan.closeConditionRewrites} close condition(s) would be rewritten`,
			);
		}
		for (const rewrite of plan.literalRewrites) {
			console.log(
				`  ${rewrite.carrier} ${rewrite.slot} compares against ${JSON.stringify(rewrite.value)} -> ${JSON.stringify(rewrite.to)}`,
			);
		}
		for (const reference of plan.literalReferences) {
			console.log(
				`  review: ${reference.carrier} ${reference.slot} compares against ${JSON.stringify(reference.value)}, which was renamed more than one way`,
			);
		}
	}
	console.log(
		"\nDRY RUN: nothing written. Pass --execute to apply the repair.",
	);
}

async function main(): Promise<void> {
	const appIds = options.app ?? (await listRepairCandidateAppIds());
	if (options.execute !== true) {
		await dryRun(appIds);
		await closeCaseStoreDatabase();
		return;
	}
	const report = await runSelectOptionValueRepair(appIds);
	console.log(
		`Repaired ${report.rewrittenValues} value(s) across ${report.repairedApps} of ${report.scannedApps} app(s); ` +
			`${report.rewrittenCaseRows} case row(s), ${report.rewrittenCloseConditions} close condition(s), and ${report.rewrittenLiterals} expression literal(s) rewritten; ` +
			`${report.literalReferences} ambiguous literal(s) left for review.`,
	);
	await closeCaseStoreDatabase();
}

runMain(main);
