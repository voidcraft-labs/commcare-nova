/**
 * ⚠️  WRITES — Recover an app stuck in error/generating status.
 *
 * Sets status to "complete" and clears error_type. Only works if the
 * blueprint has modules (i.e. the data is intact). Requires an explicit
 * `--confirm` flag; omit it for a dry run. Writes to whatever database the env
 * provides (`NOVA_DB_LOCAL_URL` locally, the Cloud SQL connector in the
 * migrate-job image).
 *
 * Run with `--help` for flags.
 */
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { loadApp } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { tsToISO } from "./lib/format";
import { requireArg, runMain } from "./lib/main";

interface RecoverAppOptions {
	confirm?: boolean;
}

const program = new Command();
program
	.name("recover-app")
	.description(
		"Recover an app stuck in error/generating status. Defaults to a dry run — pass --confirm to actually write.",
	)
	.argument("<appId>", "app id (apps.id)")
	.option("--confirm", "actually write the status change (default: dry run)")
	.addHelpText(
		"after",
		"\nWhat this does:\n" +
			"  • Sets status → 'complete'\n" +
			"  • Clears error_type\n" +
			"  • Bumps updated_at\n" +
			"\nRefuses to run if the blueprint has zero modules (nothing to recover).\n" +
			"\nExamples:\n" +
			"  $ npx tsx scripts/recover-app.ts <appId>             # dry run\n" +
			"  $ npx tsx scripts/recover-app.ts <appId> --confirm    # write\n",
	);

program.parse();

const appId = requireArg(program.args, 0, "appId");
const confirmed = program.opts<RecoverAppOptions>().confirm === true;

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
	 * recovered state. A raw status update issues no stream poke, so open tabs
	 * won't see the change until they next reload. */
	const db = await getAppDb();
	await db
		.updateTable("apps")
		.set({ status: "complete", error_type: null, updated_at: new Date() })
		.where("id", "=", appId)
		.execute();
	console.log("\n✓ Done. Status set to 'complete', error_type cleared.");
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
