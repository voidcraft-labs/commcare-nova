/**
 * ⚠️  WRITES TO PRODUCTION — Recover an app stuck in error/generating status.
 *
 * Sets status to "complete" and clears error_type. Only works if the
 * blueprint has modules (i.e. the data is intact). Requires an explicit
 * `--confirm` flag; omit it for a dry run.
 *
 * Run with `--help` for flags.
 */
import { FieldValue } from "@google-cloud/firestore";
import { Command } from "commander";
import { db } from "./lib/firestore";
import { tsToISO } from "./lib/format";
import { requireArg, runMain } from "./lib/main";
import type { PersistableDoc } from "./lib/types";

interface RecoverAppOptions {
	confirm?: boolean;
}

const program = new Command();
program
	.name("recover-app")
	.description(
		"Recover an app stuck in error/generating status. Defaults to a dry run — pass --confirm to actually write.",
	)
	.argument("<appId>", "Firestore app document id")
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
	const ref = db.collection("apps").doc(appId);
	const snap = await ref.get();

	if (!snap.exists) {
		console.error(`App ${appId} not found.`);
		process.exit(1);
	}

	// biome-ignore lint/style/noNonNullAssertion: guarded by snap.exists check above
	const data = snap.data()!;
	/* Blueprint is persisted as `PersistableDoc` (no `fieldParent` —
	 * that's rebuilt on hydration). Recovery only needs the order maps
	 * to produce module / form counts, so we don't hydrate here. */
	const doc = data.blueprint as PersistableDoc | undefined;
	const moduleCount = doc?.moduleOrder.length ?? 0;
	const formCount = (doc?.moduleOrder ?? []).reduce(
		(sum, modUuid) => sum + (doc?.formOrder[modUuid]?.length ?? 0),
		0,
	);

	const header = confirmed
		? "⚠️  RECOVERY TOOL (writes to production)"
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

	/* Write. */
	await ref.set(
		{
			status: "complete",
			error_type: null,
			updated_at: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
	console.log("\n✓ Done. Status set to 'complete', error_type cleared.");
}

runMain(main);
