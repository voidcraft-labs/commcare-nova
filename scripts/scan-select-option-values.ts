/** READ ONLY: find every choice value the stored-value grammar refuses. */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { evaluateCommit } from "../lib/commcare/validator/gate";
import { hydratePersistedBlueprint } from "../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lib/doc/lookupReferences";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import {
	countCaseRowsHoldingOldValues,
	describeRewrite,
	listRepairCandidateAppIds,
	loadSelectOptionValueRepairSnapshot,
	planSelectOptionValueRepair,
} from "./lib/selectOptionValueRepair";

interface Options {
	prod?: boolean;
	verbose?: boolean;
	app?: string[];
}

const program = new Command();
program
	.name("scan-select-option-values")
	.description(
		"List every app holding a choice value with a space, a quote mark, or nothing in it (field options and the case-type catalog), the slug the repair would write, the case rows and close conditions holding the old token, and the expressions that still spell it (read-only).",
	)
	.option("--prod", "scan production through the read-only operator identity")
	.option("--verbose", "print every rewrite, not only the per-app totals")
	.option("--app <id...>", "limit the scan to these app ids")
	.addHelpText(
		"after",
		"\nRun before the paired migration and independently afterward. An app needing repair exits nonzero.\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const appIds = options.app ?? (await listRepairCandidateAppIds());
	let scanned = 0;
	let needingRepair = 0;
	let values = 0;
	let caseRows = 0;
	let closeConditions = 0;
	let literals = 0;
	let stillBlocked = 0;
	for (const appId of appIds) {
		const snapshot = await loadSelectOptionValueRepairSnapshot(appId);
		if (snapshot === null) {
			if (options.app !== undefined) {
				console.log(`${appId}: absent (nothing to migrate)`);
			}
			continue;
		}
		scanned++;
		const plan = planSelectOptionValueRepair(snapshot.blueprint);
		if (plan.rewrites.length === 0) continue;
		needingRepair++;
		values += plan.rewrites.length;
		closeConditions += plan.closeConditionRewrites;
		literals += plan.literalReferences.length;
		let appRows = 0;
		for (const rewrite of plan.casePropertyRewrites) {
			appRows += await countCaseRowsHoldingOldValues(appId, rewrite);
		}
		caseRows += appRows;
		/* Whether the repaired document would land: the synthetic writer
		 * refuses a target with any other gating finding. Lookup findings
		 * are excluded because this scan has no Project definition
		 * snapshot; the writer evaluates them for real. */
		const verdict = evaluateCommit({
			nextDoc: hydratePersistedBlueprint(plan.targetDoc),
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		});
		const otherFindings = verdict.ok
			? []
			: verdict.findings.filter(
					(finding) => !finding.code.startsWith("LOOKUP_"),
				);
		if (otherFindings.length > 0) stillBlocked++;
		console.log(
			`${appId} (${snapshot.appName || "unnamed"}): ${plan.rewrites.length} value(s), ${appRows} case row(s), ${plan.closeConditionRewrites} close condition(s), ${plan.literalReferences.length} expression literal(s)${
				otherFindings.length > 0
					? `, and ${otherFindings.length} other finding(s) that would still refuse the repaired document`
					: ""
			}`,
		);
		if (options.verbose === true) {
			for (const rewrite of plan.rewrites) {
				console.log(`  ${describeRewrite(rewrite)}`);
			}
			for (const reference of plan.literalReferences) {
				console.log(
					`  review: ${reference.carrier} ${reference.slot} still compares against ${JSON.stringify(reference.value)}`,
				);
			}
			for (const finding of otherFindings) {
				console.log(`  blocks: ${finding.code}: ${finding.message}`);
			}
		}
	}
	console.log(
		`\nscanned=${scanned} needing_repair=${needingRepair} values=${values} case_rows=${caseRows} close_conditions=${closeConditions} expression_literals=${literals} still_blocked_by_other_findings=${stillBlocked}`,
	);
	if (needingRepair > 0) process.exitCode = 1;
	await closeCaseStoreDatabase();
}

runMain(main);
