/**
 * WRITER: persist the finite built-in-status filter cutover as semantic
 * Blueprint mutations. Dry-run by default; production execution belongs to
 * the immutable migration image, never a human `--prod` connection.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import {
	CASE_STATUS_FILTER_REPAIR_TARGETS,
	loadCaseStatusFilterRepairSnapshot,
	planCaseStatusFilterRepair,
	runCaseStatusFilterRepair,
} from "./lib/caseStatusFilterRepair";
import { runMain } from "./lib/main";

interface Options {
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-case-status-filters")
	.description(
		"Repair the reviewed historical RDT filters through deterministic Blueprint mutations. Dry-run by default.",
	)
	.option("--execute", "write the semantic repair")
	.addHelpText(
		"after",
		"\nProduction writes run inside the explicit commcare-nova-historical-repair Job using the maintenance image. There is intentionally no --prod writer shortcut.\n",
	);
program.parse();
const options = program.opts<Options>();

async function dryRun(): Promise<void> {
	const appIds = [
		...new Set(CASE_STATUS_FILTER_REPAIR_TARGETS.map((target) => target.appId)),
	].sort();
	for (const appId of appIds) {
		const snapshot = await loadCaseStatusFilterRepairSnapshot(appId);
		if (snapshot === null) continue;
		console.log(`${appId} (${snapshot.appName || "unnamed"})`);
		for (const finding of planCaseStatusFilterRepair(snapshot.blueprint)
			.findings) {
			console.log(
				`  ${finding.moduleUuid}: ${finding.standing} — ${finding.detail}`,
			);
		}
	}
	console.log(
		"\nDRY RUN: nothing written. Pass --execute to apply the repair.",
	);
}

async function main(): Promise<void> {
	if (options.execute !== true) {
		await dryRun();
		await closeCaseStoreDatabase();
		return;
	}
	const report = await runCaseStatusFilterRepair();
	console.log(
		`Repaired ${report.repairedFilters} filter(s) across ${report.repairedApps} app(s); ` +
			`${report.cleanFilters} already clean; ${report.supersededFilters} superseded; ${report.blockedFilters} blocked.`,
	);
	await closeCaseStoreDatabase();
}

runMain(main);
