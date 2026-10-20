import "./lib/loadEnv";

/**
 * WRITER: the HQ round-trip expressions cutover, the entrypoint of the Job
 * `commcare-nova-historical-repair` as `hq-round-trip-expressions.cjs`. A dry
 * run unless told otherwise.
 *
 * Every mode first counts the apps that already carry the cutover's marker:
 * all of them prints `already-applied`; some of them refuses, since no run of
 * this writer leaves that state. Then:
 *
 *   (none)                    the dry run: builds the whole plan and prints
 *                             its report and `planDigest`. Writes nothing and
 *                             applies no DDL.
 *   --settle-holders          settles every lapsed or paused run holder
 *                             through the production reapers, prints the
 *                             counts and stops.
 *   --rehearse                builds the plan and runs the whole fleet
 *                             transaction, the ledgered DDL inside it, ending
 *                             it in a sentinel rollback that leaves nothing.
 *                             Local databases and tests only: the Job does
 *                             not admit it.
 *   --execute --expect-plan-digest <sha256>
 *                             builds the plan, refuses with nothing written
 *                             when its digest is not the expected one, then
 *                             runs the fleet transaction, which applies the
 *                             ledgered DDL only after its own checks pass and
 *                             commits it with the fleet.
 *
 * It reads no CommCare HQ state and decrypts nothing. The report is
 * content-free JSON Lines (`./lib/hqRoundTripExpressions/report.ts`), each
 * line printed as it is made and always ending in an `outcome` line. Its
 * runbook is `docs/plans/hq-round-trip/3-cutover-runbook.md`.
 */

import { Command, Option } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	errorTextOf,
	type MigrateMode,
	runMigrate,
} from "./lib/hqRoundTripExpressions/run";
import { runMain } from "./lib/main";

interface Options {
	settleHolders?: boolean;
	rehearse?: boolean;
	execute?: boolean;
	expectPlanDigest?: string;
}

const program = new Command();
program
	.name("migrate-hq-round-trip-expressions")
	.description(
		"Run the HQ round-trip expressions cutover: the dry run by default, or one of its explicit modes.",
	)
	.addOption(
		new Option(
			"--settle-holders",
			"settle every lapsed or paused run holder, then stop",
		).conflicts(["rehearse", "execute"]),
	)
	.addOption(
		new Option(
			"--rehearse",
			"local databases only: run the whole write, the ledgered DDL inside it, then roll it all back",
		).conflicts(["settleHolders", "execute"]),
	)
	.addOption(
		new Option(
			"--execute",
			"write, with the ledgered DDL in the same transaction, when the plan's digest is the expected one",
		).conflicts(["settleHolders", "rehearse"]),
	)
	.option(
		"--expect-plan-digest <sha256>",
		"with --execute, the planDigest the dry run printed",
	)
	.addHelpText(
		"after",
		"\nProduction runs only through the Job commcare-nova-historical-repair, by docs/plans/hq-round-trip/3-cutover-runbook.md. There is no --prod writer.\n",
	);
program.parse();
const options = program.opts<Options>();

if (options.execute === true) {
	if (
		options.expectPlanDigest === undefined ||
		!/^[0-9a-f]{64}$/.test(options.expectPlanDigest)
	) {
		program.error(
			"--execute writes only the plan a dry run printed, so it needs --expect-plan-digest <sha256> with that planDigest.",
		);
	}
} else if (options.expectPlanDigest !== undefined) {
	program.error("--expect-plan-digest is read only by --execute.");
}

const mode: MigrateMode =
	options.settleHolders === true
		? "settle-holders"
		: options.rehearse === true
			? "rehearse"
			: options.execute === true
				? "execute"
				: "dry-run";

/* Each report line is printed as it is made, so a run that throws has
 * already printed its fleet line and ends with a `stopped` outcome naming
 * the error's class. A database error's own text can quote stored content,
 * so only this cutover's own messages reach stderr (`errorTextOf`). */
async function main(): Promise<void> {
	try {
		const result = await runMigrate(await getAppDb(), {
			mode,
			...(options.expectPlanDigest !== undefined && {
				expectPlanDigest: options.expectPlanDigest,
			}),
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
