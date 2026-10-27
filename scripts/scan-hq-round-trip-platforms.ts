import "./lib/loadEnv";

/**
 * READ-ONLY: the HQ round-trip platforms cutover's advisory scan.
 *
 * Builds the cutover's plan from the database alone, inside one
 * `REPEATABLE READ, READ ONLY` transaction of plain `SELECT`s, and prints its
 * content-free report as JSON Lines: each app's declaration, the questions
 * the split reaches, the stored reads step 4 retypes, each app's case schema
 * drift, every blocker that needs no media bytes, every holder, and the
 * ready media rows with `needsBytes`, the rows whose stored bytes the Job
 * must read (which decides whether the window grants the Job the media
 * bucket). It reads no media bytes, so its plan removes no media reference
 * and prints no digest. It takes no row lock, so it runs as a read-only
 * identity.
 *
 *   (none) / --prod             the plan over the local database or production
 *   --app <id>                  one app
 *   --app <id> --debug-details  that app's blocker places by entity id and
 *                               name with each finding's message, and its
 *                               planned changes with names, for the
 *                               operator's terminal only, never archived
 *
 * Production writes run only through the Job
 * `commcare-nova-hq-round-trip-platforms`, by
 * `docs/plans/hq-round-trip/4-cutover-runbook.md`.
 */

import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	errorTextOf,
	runDebugDetails,
	runScan,
} from "./lib/hqRoundTripPlatforms/run";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	prod?: boolean;
	app?: string;
	debugDetails?: boolean;
}

const program = new Command();
program
	.name("scan-hq-round-trip-platforms")
	.description(
		"Report what the HQ round-trip platforms cutover would change, every blocker and every holder, from the database alone. Never writes.",
	)
	.option("--prod", "scan production through the read-only operator identity")
	.option("--app <appId>", "scope the scan to one app")
	.option(
		"--debug-details",
		"with --app, print each blocker's places by entity id and name; never for output that leaves your terminal",
	)
	.addHelpText(
		"after",
		"\nProduction writes run only through the Job commcare-nova-hq-round-trip-platforms, by docs/plans/hq-round-trip/4-cutover-runbook.md.\n",
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
	if (options.debugDetails === true && options.app !== undefined) {
		for (const line of await runDebugDetails(db, options.app)) {
			console.log(line);
		}
		return;
	}
	try {
		const result = await runScan(db, {
			...(options.app !== undefined && { appId: options.app }),
			onLine: (line) => console.log(JSON.stringify(line)),
		});
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(errorTextOf(error));
		process.exitCode = 1;
	}
}

runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
