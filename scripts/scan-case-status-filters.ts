/** READ ONLY: classify the finite built-in-status filter cutover repair. */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import {
	CASE_STATUS_FILTER_REPAIR_TARGETS,
	loadCaseStatusFilterRepairSnapshot,
	planCaseStatusFilterRepair,
} from "./lib/caseStatusFilterRepair";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-status-filters")
	.description(
		"Classify the three historical RDT filters exposed by the built-in case-status lifecycle gate (read-only).",
	)
	.option("--prod", "scan production through the read-only operator identity")
	.addHelpText(
		"after",
		"\nRun before the paired migration and independently afterward. Repairable or blocked findings exit nonzero.\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const appIds = [
		...new Set(CASE_STATUS_FILTER_REPAIR_TARGETS.map((target) => target.appId)),
	].sort();
	let repairable = 0;
	let clean = 0;
	let superseded = 0;
	let blocked = 0;
	for (const appId of appIds) {
		const snapshot = await loadCaseStatusFilterRepairSnapshot(appId);
		if (snapshot === null) {
			console.log(`${appId}: absent (nothing to migrate)`);
			continue;
		}
		console.log(`${appId} (${snapshot.appName || "unnamed"})`);
		for (const finding of planCaseStatusFilterRepair(snapshot.blueprint)
			.findings) {
			console.log(
				`  ${finding.moduleUuid}: ${finding.standing} — ${finding.detail}`,
			);
			switch (finding.standing) {
				case "repairable":
					repairable++;
					break;
				case "clean":
					clean++;
					break;
				case "superseded":
					superseded++;
					break;
				case "blocked":
					blocked++;
					break;
			}
		}
	}
	console.log(
		`\nrepairable=${repairable} clean=${clean} superseded=${superseded} blocked=${blocked}`,
	);
	if (repairable > 0 && options.prod === true) {
		console.log(
			"\nThe next deploy's immutable migrate Job runs the paired semantic repair before its runtime database probe. Re-run this scan afterward; repairable and blocked must both be zero.",
		);
	}
	if (repairable > 0 || blocked > 0) process.exitCode = 1;
	await closeCaseStoreDatabase();
}

runMain(main);
