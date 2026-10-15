/**
 * WRITER: the HQ round-trip emission cutover, the entrypoint of the Job
 * `commcare-nova-hq-round-trip-cutover`. A dry run unless told otherwise.
 *
 * Every mode first counts the apps that already carry the cutover's marker:
 * all of them prints `already-applied`; some of them refuses, since no run of
 * this writer leaves that state. Then:
 *
 *   (none)                    the dry run: builds the whole plan and prints
 *                             its report and digest. Writes nothing.
 *   --settle-holders          settles every lapsed or paused run holder
 *                             through the production reapers.
 *   --prove-decrypt           decrypts one stored key the run would send and
 *                             prints `ok`, never the key.
 *   --rehearse                applies the ledgered DDL, builds the plan and
 *                             runs the whole fleet transaction, ending it in
 *                             a sentinel rollback.
 *   --execute --expect-plan-digest <sha256>
 *                             applies the ledgered DDL, rebuilds the plan,
 *                             refuses when its digest is not the expected
 *                             one, then writes and commits.
 *
 * The report is content-free JSON Lines (`./lib/hqRoundTripCutover/report.ts`).
 * Its runbook is `docs/plans/hq-round-trip/2-cutover-runbook.md`.
 */

import "./lib/loadEnv";
import { Command, Option } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { defaultKmsTransport } from "./lib/hqRoundTripCutover/kmsDecrypt";
import type { MigrateMode } from "./lib/hqRoundTripCutover/run";
import { runMigrate } from "./lib/hqRoundTripCutover/run";
import { runMain } from "./lib/main";

interface Options {
	settleHolders?: boolean;
	proveDecrypt?: boolean;
	rehearse?: boolean;
	execute?: boolean;
	expectPlanDigest?: string;
	transientAsUnreadable?: boolean;
	withoutHq?: boolean;
}

const program = new Command();
program
	.name("migrate-hq-round-trip-cutover")
	.description(
		"Run the HQ round-trip emission cutover: the dry run by default, or one of its explicit modes.",
	)
	.addOption(
		new Option(
			"--settle-holders",
			"settle every lapsed or paused run holder, then stop",
		).conflicts(["proveDecrypt", "rehearse", "execute"]),
	)
	.addOption(
		new Option(
			"--prove-decrypt",
			"decrypt one stored key a run would send, as proof the grant stands",
		).conflicts(["settleHolders", "rehearse", "execute"]),
	)
	.addOption(
		new Option(
			"--rehearse",
			"apply the ledgered DDL and run the whole write, then roll it back",
		).conflicts(["settleHolders", "proveDecrypt", "execute"]),
	)
	.addOption(
		new Option(
			"--execute",
			"apply the ledgered DDL and write, when the plan's digest is the expected one",
		).conflicts(["settleHolders", "proveDecrypt", "rehearse"]),
	)
	.option(
		"--expect-plan-digest <sha256>",
		"with --execute, the planDigest the rehearsal printed",
	)
	.option(
		"--transient-as-unreadable",
		"in a second window only, with --rehearse or --execute: class a read still transient as unreadable",
	)
	.option(
		"--without-hq",
		"local databases and tests only: read no CommCare HQ and decrypt nothing",
	)
	.addHelpText(
		"after",
		"\nProduction runs only through the Job commcare-nova-hq-round-trip-cutover, by docs/plans/hq-round-trip/2-cutover-runbook.md. There is no --prod writer.\n",
	);
program.parse();
const options = program.opts<Options>();

if (options.execute === true) {
	if (
		options.expectPlanDigest === undefined ||
		!/^[0-9a-f]{64}$/.test(options.expectPlanDigest)
	) {
		program.error(
			"--execute writes only the plan a rehearsal printed, so it needs --expect-plan-digest <sha256> with that planDigest.",
		);
	}
} else if (options.expectPlanDigest !== undefined) {
	program.error("--expect-plan-digest is read only by --execute.");
}
if (
	options.transientAsUnreadable === true &&
	options.rehearse !== true &&
	options.execute !== true
) {
	program.error(
		"--transient-as-unreadable changes what a rehearsal or an execute run writes, so it goes with --rehearse or --execute.",
	);
}

const mode: MigrateMode =
	options.settleHolders === true
		? "settle-holders"
		: options.proveDecrypt === true
			? "prove-decrypt"
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
		transientAsUnreadable: options.transientAsUnreadable === true,
		withoutHq: options.withoutHq === true,
		kms: defaultKmsTransport,
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
