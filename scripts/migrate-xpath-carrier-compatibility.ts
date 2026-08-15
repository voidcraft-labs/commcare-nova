/**
 * WRITER: clear the finite set of scan-proven legacy `here()` geopoint
 * defaults. Dry-run by default; production execution belongs to the immutable
 * migration image, never a human `--prod` connection.
 */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	loadXPathCarrierCompatibilityRepairSnapshot,
	planXPathCarrierCompatibilityRepair,
	runXPathCarrierCompatibilityRepair,
	xpathCarrierCompatibilityRepairAppIds,
} from "./lib/xpathCarrierCompatibilityRepair";

interface Options {
	app?: string;
	execute?: boolean;
}

const program = new Command();
program
	.name("migrate-xpath-carrier-compatibility")
	.description(
		"Clear the reviewed legacy here() geopoint defaults through deterministic Blueprint mutations. Dry-run by default.",
	)
	.option("--app <appId>", "scope the repair to one reviewed app")
	.option("--execute", "write the semantic repair")
	.addHelpText(
		"after",
		"\nProduction writes run inside the immutable commcare-nova-migrate Cloud Run Job. There is intentionally no --prod writer shortcut.\n",
	);
program.parse();
const options = program.opts<Options>();

function selectedAppIds(): string[] {
	const known = xpathCarrierCompatibilityRepairAppIds();
	if (options.app === undefined) return known;
	if (!known.includes(options.app)) {
		throw new Error(`App ${options.app} is not a reviewed repair target.`);
	}
	return [options.app];
}

async function dryRun(appIds: readonly string[]): Promise<void> {
	for (const appId of appIds) {
		const snapshot = await loadXPathCarrierCompatibilityRepairSnapshot(appId);
		if (snapshot === null) continue;
		console.log(`${appId} (${snapshot.appName || "unnamed"})`);
		for (const finding of planXPathCarrierCompatibilityRepair(
			snapshot.blueprint,
		).findings) {
			console.log(
				`  ${finding.fieldUuid}: ${finding.standing} — ${finding.detail}`,
			);
		}
	}
	console.log(
		"\nDRY RUN: nothing written. Pass --execute to apply the repair.",
	);
}

async function main(): Promise<void> {
	const appIds = selectedAppIds();
	if (options.execute !== true) {
		await dryRun(appIds);
		return;
	}
	const report = await runXPathCarrierCompatibilityRepair(appIds);
	console.log(
		`Repaired ${report.repairedDefaults} default(s) across ${report.repairedApps} app(s); ` +
			`${report.cleanDefaults} already clean; ${report.supersededDefaults} superseded; ${report.blockedDefaults} blocked; ` +
			`${report.verifiedApps} app(s) passed the post-repair JavaRosa scan.`,
	);
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
