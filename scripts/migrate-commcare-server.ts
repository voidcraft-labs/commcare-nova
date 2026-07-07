/**
 * Backfill `commcare_server: "production"` onto pre-server `user_settings`
 * rows. Dry run by default — pass `--apply` to write.
 *
 * One-time migration, paired with `scan-commcare-server.ts` (run that
 * first). The CommCare HQ connection now stores which HQ deployment
 * (US / India / EU) it was verified against, and every settings reader
 * collapses a row missing it to "not configured" — an un-migrated user's
 * connection looks disconnected until this backfill runs. Every row written
 * before the field existed was verified against www.commcarehq.org — the
 * only host the HQ client ever called — so `production` is the
 * historically-correct value for all of them, not a guess.
 *
 * Only rows carrying `commcare_username` and missing `commcare_server`
 * are touched; the write is a merge of that one field.
 *
 * Run with `--help` for flags.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import { runMain } from "./lib/main";

interface MigrateOptions {
	project: string;
	apply?: boolean;
}

const program = new Command();
program
	.name("migrate-commcare-server")
	.description(
		'Backfill commcare_server: "production" onto user_settings rows that predate the per-server HQ connection. ' +
			"Defaults to a dry run — pass --apply to write. Run scan-commcare-server.ts first.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to migrate (e.g. "commcare-nova-dev") — explicit so a write can never land on an unintended project',
	)
	.option("--apply", "actually write the backfill (default: dry run)")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-commcare-server.ts --project commcare-nova-dev          # dry run\n" +
			"  $ npx tsx scripts/migrate-commcare-server.ts --project commcare-nova-dev --apply  # write\n",
	);

program.parse();
const { project, apply } = program.opts<MigrateOptions>();

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(
		`${apply ? "Backfilling" : "Dry run over"} user_settings in project "${project}"…\n`,
	);

	const settings = await db.collection("user_settings").get();
	let backfilled = 0;

	for (const snap of settings.docs) {
		const data = snap.data();
		if (!data.commcare_username || data.commcare_server) continue;

		backfilled++;
		console.log(
			`${snap.id}: ${data.commcare_username} → commcare_server: "production"`,
		);
		if (apply) {
			await snap.ref.set({ commcare_server: "production" }, { merge: true });
		}
	}

	console.log(
		`\n${settings.size} row(s) scanned; ${backfilled} ${apply ? "backfilled" : "would be backfilled"}.`,
	);
	if (!apply && backfilled > 0) {
		console.log("Re-run with --apply to write.");
	}
}

runMain(main);
