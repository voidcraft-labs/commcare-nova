import "./lib/loadEnv";

/**
 * WRITER: the HQ round-trip platforms cutover, the entrypoint of the Job
 * `commcare-nova-hq-round-trip-platforms` as `hq-round-trip-platforms.cjs`.
 * A dry run unless told otherwise.
 *
 * Every mode but `--prove-media-read` first reads the migration ledger: where
 * it holds the validation migration, which only the cutover's own commit
 * applies, the run prints `already-applied` and exits before any other read.
 *
 *   (none)                    the dry run: reads the fleet, classifies the
 *                             media (reading stored bytes only for a row whose
 *                             MIME cannot give its format), builds the whole
 *                             plan and prints its report and `planDigest`.
 *                             Writes nothing and applies no DDL.
 *   --prove-media-read        reads the metadata of one stored object of a
 *                             ready row that needs its bytes read, retrying a
 *                             refusal for up to ten minutes, and prints `ok`,
 *                             `no-media` or `failed`.
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
 * It reads Nova's database and media bucket and no CommCare HQ state. The
 * report is content-free JSON Lines (`./lib/hqRoundTripPlatforms/report.ts`),
 * each line printed as it is made and always ending in an `outcome` line.
 * Its runbook is `docs/plans/hq-round-trip/4-cutover-runbook.md`.
 */

import { Command, Option } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	errorTextOf,
	type MigrateMode,
	runMigrate,
} from "./lib/hqRoundTripPlatforms/run";
import { runMain } from "./lib/main";

interface Options {
	proveMediaRead?: boolean;
	settleHolders?: boolean;
	rehearse?: boolean;
	execute?: boolean;
	expectPlanDigest?: string;
}

const program = new Command();
program
	.name("migrate-hq-round-trip-platforms")
	.description(
		"Run the HQ round-trip platforms cutover: the dry run by default, or one of its explicit modes.",
	)
	.addOption(
		new Option(
			"--prove-media-read",
			"check this identity can read one stored media object that the backfill must read, then stop",
		).conflicts(["settleHolders", "rehearse", "execute"]),
	)
	.addOption(
		new Option(
			"--settle-holders",
			"settle every lapsed or paused run holder, then stop",
		).conflicts(["proveMediaRead", "rehearse", "execute"]),
	)
	.addOption(
		new Option(
			"--rehearse",
			"local databases only: run the whole write, the ledger inside it, then roll it all back",
		).conflicts(["proveMediaRead", "settleHolders", "execute"]),
	)
	.addOption(
		new Option(
			"--execute",
			"write, with the ledger in the same transaction, when the plan's digest is the expected one",
		).conflicts(["proveMediaRead", "settleHolders", "rehearse"]),
	)
	.option(
		"--expect-plan-digest <sha256>",
		"with --execute, the planDigest the dry run printed",
	)
	.addHelpText(
		"after",
		"\nProduction runs only through the Job commcare-nova-hq-round-trip-platforms, by docs/plans/hq-round-trip/4-cutover-runbook.md. There is no --prod writer.\n",
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
	options.proveMediaRead === true
		? "prove-media-read"
		: options.settleHolders === true
			? "settle-holders"
			: options.rehearse === true
				? "rehearse"
				: options.execute === true
					? "execute"
					: "dry-run";

/* Each report line is printed as it is made, so a run that throws has
 * already printed its lines and ends with a `stopped` outcome naming the
 * error's class. A database error's own text can quote stored content, so
 * only this cutover's own messages reach stderr (`errorTextOf`). */
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
