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
 *   --rehearse                applies the ledgered DDL, builds the plan and
 *                             runs the whole fleet transaction, ending it in
 *                             a sentinel rollback. Local databases and tests
 *                             only: the Job does not admit it.
 *   --execute --expect-plan-digest <sha256>
 *                             applies the ledgered DDL, builds the plan,
 *                             refuses with nothing written when its digest
 *                             is not the expected one, then writes and
 *                             commits.
 *
 * It reads no CommCare HQ state and decrypts nothing. The report is
 * content-free JSON Lines (`./lib/hqRoundTripExpressions/report.ts`). Its
 * runbook is `docs/plans/hq-round-trip/3-cutover-runbook.md`.
 */

import { Command, Option } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { type MigrateMode, runMigrate } from "./lib/hqRoundTripExpressions/run";
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
			"local databases only: apply the ledgered DDL and run the whole write, then roll it back",
		).conflicts(["settleHolders", "execute"]),
	)
	.addOption(
		new Option(
			"--execute",
			"apply the ledgered DDL and write, when the plan's digest is the expected one",
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

async function main(): Promise<void> {
	const result = await runMigrate(await getAppDb(), {
		mode,
		...(options.expectPlanDigest !== undefined && {
			expectPlanDigest: options.expectPlanDigest,
		}),
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
