/**
 * READ-ONLY: the HQ round-trip emission cutover's advisory scan.
 *
 * Builds the cutover's plan from the documents and the ledger alone, inside
 * one `REPEATABLE READ, READ ONLY` transaction, and prints its content-free
 * report as JSON Lines: what each step would change, every blocker, every
 * holder, the private work the cutover would abandon and every deployment
 * the plan holds. It makes no HQ request and decrypts nothing, so every
 * deployment is classed `unreadable`, as the migrate script's `--without-hq`
 * classes it; a deployment no current member's key qualifies for is listed
 * as `no-credential`. It takes no row lock, so it runs as a read-only
 * identity. Production writes run only through the Job
 * `commcare-nova-hq-round-trip-cutover`, by
 * `docs/plans/hq-round-trip/2-cutover-runbook.md`.
 */

import "./lib/loadEnv";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	blockerDetails,
	readPlannedFleet,
} from "./lib/hqRoundTripCutover/plan";
import { debugDetails, readRecipients } from "./lib/hqRoundTripCutover/report";
import { runScan } from "./lib/hqRoundTripCutover/run";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	prod?: boolean;
	app?: string;
	debugDetails?: boolean;
	recipients?: boolean;
}

const program = new Command();
program
	.name("scan-hq-round-trip-cutover")
	.description(
		"Report what the HQ round-trip emission cutover would change, every blocker and every holder, from the documents and the ledger alone. Never writes, never reads CommCare HQ.",
	)
	.option("--prod", "scan production through the read-only operator identity")
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--debug-details",
		"with --app, print every place each blocker met by entity id and name; never for output that leaves your terminal",
	)
	.option(
		"--recipients",
		"print only the email of every Nova user, or with --app of every member of that app's Project",
	)
	.addHelpText(
		"after",
		"\nProduction writes run only through the Job commcare-nova-hq-round-trip-cutover, by docs/plans/hq-round-trip/2-cutover-runbook.md.\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.debugDetails === true && options.app === undefined) {
	program.error(
		"--debug-details prints one app's details, so it needs --app <appId>.",
	);
}
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	if (options.recipients === true) {
		const emails = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => readRecipients(tx, options.app));
		for (const email of emails) console.log(email);
		return;
	}
	if (options.debugDetails === true && options.app !== undefined) {
		const fleet = await readPlannedFleet(db, { appId: options.app });
		const appId = options.app;
		const details = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => blockerDetails(tx, fleet.source, fleet.build, appId));
		for (const line of debugDetails(fleet.build, appId, details)) {
			console.log(line);
		}
		return;
	}
	const result = await runScan(db, {
		...(options.app !== undefined && { appId: options.app }),
	});
	console.log(result.report.text());
	process.exitCode = result.exitCode;
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
