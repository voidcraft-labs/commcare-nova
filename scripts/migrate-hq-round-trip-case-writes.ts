import "./lib/loadEnv";

/**
 * WRITER: the HQ round-trip case-writes cutover, the entrypoint of the Job
 * `commcare-nova-hq-round-trip-case-writes` as `hq-round-trip-case-writes.cjs`.
 * A dry run unless told otherwise.
 *
 * Every mode first reads the migration ledger and counts the apps carrying
 * the cutover's horizon marker: the horizon migration present with every app
 * marked prints `already-applied` and exits 0, and any state between that and
 * neither present stops as `partially-applied` before any other read.
 *
 *   (none)                    the dry run: reads the fleet, builds the whole
 *                             plan and prints its report and `planDigest`.
 *                             Writes nothing and applies no DDL.
 *   --settle-holders          settles every lapsed or paused run holder
 *                             through the production reapers, prints the
 *                             counts and stops.
 *   --rehearse                runs the whole fleet transaction, the ledger
 *                             inside it, ending in a sentinel rollback.
 *                             Local databases and tests only: the Job does
 *                             not admit it.
 *   --execute --expect-plan-digest <sha256>
 *                             builds the plan, refuses with nothing written
 *                             when its digest is not the expected one, then
 *                             runs the fleet transaction and commits.
 *
 * It reads Nova's database alone: no media bucket, no KMS key and no CommCare
 * HQ state. The report is content-free JSON Lines
 * (`./lib/hqRoundTripCaseWrites/report.ts`), each line printed as it is made
 * and always ending in an `outcome` line. Its runbook is
 * `docs/plans/hq-round-trip/5-cutover-runbook.md`.
 */

import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import type { ReportLine } from "./lib/hqRoundTripCaseWrites/report";
import {
	errorTextOf,
	type MigrateArguments,
	type MigrateOptions,
	migrateCommand,
	migrateInvocationOf,
	runMigrate,
} from "./lib/hqRoundTripCaseWrites/run";
import { runMain } from "./lib/main";

const program = migrateCommand();
program.parse();
const invocation = migrateInvocationOf(program.opts<MigrateArguments>());
if (!invocation.ok) program.error(invocation.message);

/* Each report line is printed as it is made, so a run that throws has
 * already printed its lines and ends with a `stopped` outcome naming the
 * error's class. A refusal reached without throwing (a wrong digest, an
 * unreviewed ledger, a check under the writer's locks) prints its own
 * sentence on stderr. A database error's own text can quote stored content,
 * so only this cutover's own messages reach stderr (`errorTextOf`). */
async function main(): Promise<void> {
	if (!invocation.ok) return;
	const onLine = (line: ReportLine) => console.log(JSON.stringify(line));
	const options: MigrateOptions =
		invocation.mode === "execute"
			? {
					mode: "execute",
					expectPlanDigest: invocation.expectPlanDigest,
					onLine,
				}
			: { mode: invocation.mode, onLine };
	try {
		const result = await runMigrate(await getAppDb(), options);
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
