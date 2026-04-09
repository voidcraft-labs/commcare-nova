/**
 * ⚠️  WRITES TO PRODUCTION — Recover an app stuck in error/generating status.
 *
 * Sets status to "complete" and clears error_type. Only works if the blueprint
 * has modules (i.e. the data is intact). Requires explicit --confirm flag.
 *
 * Usage:
 *   npx tsx scripts/recover-app.ts <appId>              # dry run (shows what would change)
 *   npx tsx scripts/recover-app.ts <appId> --confirm     # actually writes
 */
import { FieldValue } from "@google-cloud/firestore";
import { db, tsToISO } from "./lib/firestore";

const appId = process.argv[2];
const confirmed = process.argv.includes("--confirm");

if (!appId) {
	console.error("Usage: npx tsx scripts/recover-app.ts <appId> [--confirm]");
	process.exit(1);
}

async function main() {
	const ref = db.collection("apps").doc(appId);
	const snap = await ref.get();

	if (!snap.exists) {
		console.error(`App ${appId} not found.`);
		process.exit(1);
	}

	// biome-ignore lint/style/noNonNullAssertion: guarded by snap.exists check above
	const data = snap.data()!;
	const modules = data.blueprint?.modules ?? [];
	const formCount = modules.reduce(
		(sum: number, m: { forms?: unknown[] }) => sum + (m.forms?.length ?? 0),
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
	console.log(`  Modules:   ${modules.length}`);
	console.log(`  Forms:     ${formCount}`);

	/* Pre-flight checks */
	if (data.status === "complete" && !data.error_type) {
		console.log(`\n  Status:    ${data.status}`);
		console.log(
			"\n✓ App is already in 'complete' status with no error. Nothing to do.",
		);
		return;
	}

	if (modules.length === 0) {
		console.log(`\n  Status:    ${data.status}`);
		console.error(
			"\n✗ Blueprint has no modules — cannot recover an empty app.",
		);
		process.exit(1);
	}

	/* Show the planned transition only when there's something to change */
	console.log(`  Status:    ${data.status} → complete`);
	console.log(`  Error:     ${data.error_type ?? "(none)"} → (cleared)`);

	if (!confirmed) {
		console.log("\n  This is a DRY RUN. Add --confirm to write.");
		return;
	}

	/* Write */
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

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
