import "./lib/loadEnv";

/**
 * READ-ONLY: the HQ round-trip case-writes cutover's advisory scan.
 *
 * Builds the cutover's plan from the database alone, inside one
 * `REPEATABLE READ, READ ONLY` transaction of plain `SELECT`s, and prints its
 * content-free report as JSON Lines: the structure and semantic steps each
 * app would take, the placements held for its published deployments, the
 * path moves, the notice reasons, the planned case-schema differences, every
 * holder, the private work, and every blocker. It prints no digest; only the
 * Job's dry run does. It takes no row lock and writes nothing, so it runs as
 * a read-only identity.
 *
 *   (none) / --prod             the plan over the local database or production
 *   --app <id>                  one app
 *   --app <id> --debug-details  that app's blocker places by entity id and
 *                               name with each finding's message, and its
 *                               planned changes with names, for the
 *                               operator's terminal only, never archived
 *
 * Production writes run only through the Job
 * `commcare-nova-hq-round-trip-case-writes`, by
 * `docs/plans/hq-round-trip/5-cutover-runbook.md`.
 */

import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	errorTextOf,
	runDebugDetails,
	runScan,
	type ScanArguments,
	scanCommand,
	scanInvocationOf,
} from "./lib/hqRoundTripCaseWrites/run";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const program = scanCommand();
program.parse();
const invocation = scanInvocationOf(program.opts<ScanArguments>());
if (!invocation.ok) program.error(invocation.message);
if (invocation.ok && invocation.prod) targetProdDb();

async function main(): Promise<void> {
	if (!invocation.ok) return;
	try {
		const db = await getAppDb();
		if (invocation.debugDetails && invocation.appId !== undefined) {
			for (const line of await runDebugDetails(db, invocation.appId)) {
				console.log(line);
			}
			return;
		}
		const result = await runScan(db, {
			...(invocation.appId !== undefined && { appId: invocation.appId }),
			onLine: (line) => console.log(JSON.stringify(line)),
		});
		if (result.refusal !== undefined) console.error(result.refusal);
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
