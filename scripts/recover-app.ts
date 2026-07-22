/**
 * ⚠️  WRITES — Recover an app stuck in error/generating status.
 *
 * Sets status to "complete" and clears error_type. Only works if the
 * blueprint has modules (i.e. the data is intact). Requires an explicit
 * `--confirm` flag; omit it for a dry run. Recovering a proven build holder
 * settles its reservation as kept; an edit holder retains its lock and marker.
 * Writes to whatever database the env provides (`NOVA_DB_LOCAL_URL` locally,
 * the Cloud SQL connector in the migrate-job image).
 *
 * Run with `--help` for flags.
 */
import { Command, Option } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadApp, recoverAppStatus } from "@/lib/db/apps";
import {
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	toExactRunHolderIdentity,
} from "@/lib/db/runHolderWrites";
import { runLeaseState } from "@/lib/db/runLiveness";
import { tsToISO } from "./lib/format";
import { requireArg, runMain } from "./lib/main";

interface RecoverAppOptions {
	confirm?: boolean;
	holderMode?: "build" | "edit";
	holderRunId?: string;
	holderNonce?: string;
}

const program = new Command();
program
	.name("recover-app")
	.description(
		"Recover an app stuck in error/generating status. Defaults to a dry run — pass --confirm to actually write.",
	)
	.argument("<appId>", "app id (apps.id)")
	.option("--confirm", "actually write the status change (default: dry run)")
	.addOption(
		new Option(
			"--holder-mode <mode>",
			"exact present-holder mode required to recover a held app",
		).choices(["build", "edit"]),
	)
	.option(
		"--holder-run-id <runId>",
		"exact present-holder run id required to recover a held app",
	)
	.option(
		"--holder-nonce <uuid>",
		"exact present-holder nonce required to recover a held app",
	)
	.addHelpText(
		"after",
		"\nWhat this does:\n" +
			"  • Sets status → 'complete'\n" +
			"  • Clears error_type\n" +
			"  • Bumps updated_at\n" +
			"  • Settles a proven build holder's reservation as a kept charge\n" +
			"  • Requires all three exact holder flags when a run currently holds the app\n" +
			"\nRefuses to run if the blueprint has zero modules (nothing to recover).\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/recover-app.ts <appId>             # dry run\n" +
			"  $ npx tsx scripts/recover-app.ts <appId> --confirm    # write a free app\n" +
			"  $ npx tsx scripts/recover-app.ts <appId> --confirm --holder-mode build --holder-run-id <runId> --holder-nonce <uuid>\n",
	);

program.parse();

const appId = requireArg(program.args, 0, "appId");
const options = program.opts<RecoverAppOptions>();
const confirmed = options.confirm === true;
const holderFlagCount = [
	options.holderMode,
	options.holderRunId,
	options.holderNonce,
].filter((value) => value !== undefined).length;
if (holderFlagCount !== 0 && holderFlagCount !== 3) {
	console.error(
		"--holder-mode, --holder-run-id, and --holder-nonce are required together; none is a wildcard.",
	);
	process.exit(1);
}
if (options.holderRunId !== undefined && options.holderRunId.length === 0) {
	console.error("--holder-run-id must be non-empty.");
	process.exit(1);
}
if (
	options.holderNonce !== undefined &&
	!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		options.holderNonce,
	)
) {
	console.error("--holder-nonce must be a valid UUID.");
	process.exit(1);
}
const expectedHolder: ExactRunHolderIdentity | null =
	options.holderMode !== undefined &&
	options.holderRunId !== undefined &&
	options.holderNonce !== undefined
		? {
				mode: options.holderMode,
				runId: options.holderRunId,
				nonce: options.holderNonce,
			}
		: null;

async function main() {
	const data = await loadApp(appId);

	if (!data) {
		console.error(`App ${appId} not found.`);
		process.exit(1);
	}

	/* The blueprint is the assembled `PersistableDoc`. Recovery only needs
	 * the order maps to produce module / form counts. */
	const doc = data.blueprint;
	const moduleCount = doc.moduleOrder.length;
	const formCount = doc.moduleOrder.reduce(
		(sum, modUuid) => sum + (doc.formOrder[modUuid]?.length ?? 0),
		0,
	);

	const header = confirmed
		? "⚠️  RECOVERY TOOL (writes to the app-state database)"
		: "RECOVERY TOOL — dry run (read-only)";
	console.log(`${header}\n`);
	console.log(`  App ID:    ${appId}`);
	console.log(`  App Name:  ${data.app_name}`);
	console.log(`  Owner:     ${data.owner}`);
	console.log(`  Updated:   ${tsToISO(data.updated_at)}`);
	console.log(`  Modules:   ${moduleCount}`);
	console.log(`  Forms:     ${formCount}`);

	/* Pre-flight checks. */
	const holder = runLeaseState(data).holderIdentity;
	if (holder !== null) {
		console.log(
			`  Holder:    ${holder.mode}:${holder.runId ?? "(missing run id)"}:${holder.nonce ?? "(missing nonce)"}`,
		);
		const exactHolder = toExactRunHolderIdentity(holder);
		if (exactHolder === null || exactHolder.nonce === null) {
			console.error(
				"\n✗ The app has a corrupt present holder with no exact run id and nonce. This tool cannot prove ownership and will not write it; repair the holder data explicitly first.",
			);
			process.exit(1);
		}
		if (expectedHolder === null) {
			console.error(
				`\n✗ A run currently holds this app. Re-run with --holder-mode ${exactHolder.mode} --holder-run-id ${exactHolder.runId} --holder-nonce ${exactHolder.nonce} only after independently confirming that exact run may be recovered.`,
			);
			process.exit(1);
		}
		if (!exactRunHolderMatches(holder, expectedHolder, true)) {
			console.error(
				`\n✗ Holder token mismatch. Expected ${expectedHolder.mode}:${expectedHolder.runId}:${expectedHolder.nonce}, but the locked snapshot is ${exactHolder.mode}:${exactHolder.runId}:${exactHolder.nonce}. Nothing was written.`,
			);
			process.exit(1);
		}
	} else if (expectedHolder !== null) {
		console.error(
			`\n✗ Holder token ${expectedHolder.mode}:${expectedHolder.runId}:${expectedHolder.nonce} does not match this currently free app. Nothing was written.`,
		);
		process.exit(1);
	}

	if (data.status === "complete" && !data.error_type) {
		console.log(`\n  Status:    ${data.status}`);
		console.log(
			"\n✓ App is already in 'complete' status with no error. Nothing to do.",
		);
		return;
	}

	if (moduleCount === 0) {
		console.log(`\n  Status:    ${data.status}`);
		console.error(
			"\n✗ Blueprint has no modules — cannot recover an empty app.",
		);
		process.exit(1);
	}

	/* Show the planned transition only when there's something to change. */
	console.log(`  Status:    ${data.status} → complete`);
	console.log(`  Error:     ${data.error_type ?? "(none)"} → (cleared)`);

	if (!confirmed) {
		console.log("\n  This is a DRY RUN. Add --confirm to write.");
		return;
	}

	/* Write. Nothing here protects open builder tabs: an open tab's next
	 * auto-save is a MUTATION DELTA re-applied onto whatever this recovery
	 * wrote (the guarded commit's re-apply-on-fresh), so run a recovery while
	 * the app's members are offline, or their next edits will layer onto the
	 * recovered state. This lifecycle recovery issues no stream poke, so open
	 * tabs won't see the change until they next reload. */
	const outcome = await recoverAppStatus(appId, expectedHolder);
	switch (outcome.kind) {
		case "recovered":
			console.log("\n✓ Done. Status set to 'complete', error_type cleared.");
			return;
		case "already_complete":
			console.log("\n✓ App became complete before the write. Nothing to do.");
			return;
		case "not_found":
			console.error(
				"\n✗ App disappeared before the write. Nothing was written.",
			);
			break;
		case "empty_blueprint":
			console.error(
				"\n✗ Blueprint became empty before the write. Nothing was written.",
			);
			break;
		case "holder_token_required":
		case "holder_token_mismatch":
			console.error(
				`\n✗ Holder changed before the write to ${outcome.holder.mode}:${outcome.holder.runId ?? "(missing run id)"}:${outcome.holder.nonce ?? "(missing nonce)"}. Nothing was written.`,
			);
			break;
		case "holder_state_changed":
			console.error(
				"\n✗ Holder state changed before the conditional write. Nothing was written.",
			);
			break;
	}
	process.exit(1);
}

// Close the shared case-store pool so the process exits promptly — an open
// pool keeps the event loop alive.
runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
