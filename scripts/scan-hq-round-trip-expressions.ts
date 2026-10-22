import "./lib/loadEnv";

/**
 * READ-ONLY: the HQ round-trip expressions cutover's advisory scan.
 *
 * Builds the cutover's plan from the database alone, inside one
 * `REPEATABLE READ, READ ONLY` transaction of plain `SELECT`s, and prints its
 * content-free report as JSON Lines: what each step and class would change,
 * every no-write line, every planned schema change with the stored values it
 * meets, every blocker, every holder and the private work the cutover would
 * abandon. It takes no row lock, so it runs as a read-only identity.
 *
 *   (none) / --prod             the plan over the local database or production
 *   --base-digests <file>       adds the census's head half against the base
 *                               emitter's JSON Lines
 *   --app <id>                  one app
 *   --app <id> --debug-details  that app's blocker places by entity id and
 *                               name with the expression, for the operator's
 *                               terminal only, never archived
 *   --recipients [--app <id>]   the announcement's addresses, on the terminal
 *                               only
 *
 * Production writes run only through the Job
 * `commcare-nova-historical-repair`, by
 * `docs/plans/hq-round-trip/3-cutover-runbook.md`.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	errorTextOf,
	runDebugDetails,
	runRecipients,
	runScan,
} from "./lib/hqRoundTripExpressions/run";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	prod?: boolean;
	baseDigests?: string;
	app?: string;
	debugDetails?: boolean;
	recipients?: boolean;
}

const program = new Command();
program
	.name("scan-hq-round-trip-expressions")
	.description(
		"Report what the HQ round-trip expressions cutover would change, every blocker and every holder, from the database alone. Never writes.",
	)
	.option("--prod", "scan production through the read-only operator identity")
	.option(
		"--base-digests <file>",
		"compare the head emission with the base emitter's output (the census)",
	)
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
		"\nProduction writes run only through the Job commcare-nova-historical-repair, by docs/plans/hq-round-trip/3-cutover-runbook.md.\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.debugDetails === true && options.app === undefined) {
	program.error(
		"--debug-details prints one app's details, so it needs --app <appId>.",
	);
}
if (
	options.recipients === true &&
	(options.debugDetails === true || options.baseDigests !== undefined)
) {
	program.error(
		"--recipients prints only addresses, so it goes with --app alone.",
	);
}
if (options.debugDetails === true && options.baseDigests !== undefined) {
	program.error(
		"--debug-details prints one app's blocker places; run the census with --base-digests on its own.",
	);
}
if (options.prod === true) targetProdDb();

async function main(): Promise<void> {
	const db = await getAppDb();
	if (options.recipients === true) {
		for (const email of await runRecipients(db, options.app)) {
			console.log(email);
		}
		return;
	}
	if (options.debugDetails === true && options.app !== undefined) {
		for (const line of await runDebugDetails(db, options.app)) {
			console.log(line);
		}
		return;
	}
	const baseDigests =
		options.baseDigests === undefined
			? undefined
			: readFileSync(options.baseDigests, "utf8");
	try {
		const result = await runScan(db, {
			...(options.app !== undefined && { appId: options.app }),
			...(baseDigests !== undefined && { baseDigests }),
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
