/**
 * READ-ONLY — size the `commcare_server` backfill across `user_settings`.
 *
 * One-time migration pair: the CommCare HQ connection now stores which HQ
 * deployment (US / India / EU) it was verified against, and every settings
 * reader collapses a row missing it to "not configured" — so an un-migrated
 * user's connection looks disconnected until this backfill runs. Every row
 * written before the field existed was verified against www.commcarehq.org —
 * the only host the HQ client ever called — so `production` is the
 * historically-correct value for all of them, not a guess. Run this scan
 * against production when deploying the per-server connection code over old
 * data, then `migrate-commcare-server.ts` (dry-run first, then `--apply`).
 *
 * Reports, per row: whether it carries credentials, whether it already has
 * `commcare_server`, and the total needing the backfill.
 *
 * Run with `--help` for flags.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import { runMain } from "./lib/main";

interface ScanOptions {
	project: string;
}

const program = new Command();
program
	.name("scan-commcare-server")
	.description(
		"Report which user_settings rows need the commcare_server backfill (read-only). " +
			"One-time: run against production when deploying the per-server HQ connection over pre-server data, before migrate-commcare-server.ts.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to scan (e.g. "commcare-nova-dev") — explicit so a scan can never land on an unintended project',
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-commcare-server.ts --project commcare-nova-dev\n",
	);

program.parse();
const { project } = program.opts<ScanOptions>();

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(`Scanning user_settings in project "${project}"…\n`);

	const settings = await db.collection("user_settings").get();
	let needsBackfill = 0;
	let alreadyMigrated = 0;
	let noCredentials = 0;

	for (const snap of settings.docs) {
		const data = snap.data();
		if (!data.commcare_username) {
			noCredentials++;
			console.log(`${snap.id}: no HQ credentials — nothing to backfill`);
		} else if (data.commcare_server) {
			alreadyMigrated++;
			console.log(`${snap.id}: already carries "${data.commcare_server}"`);
		} else {
			needsBackfill++;
			console.log(
				`${snap.id}: ${data.commcare_username} — needs commcare_server: "production"`,
			);
		}
	}

	console.log(
		`\n${settings.size} row(s) scanned; ${needsBackfill} need the backfill; ` +
			`${alreadyMigrated} already migrated; ${noCredentials} without credentials.`,
	);
	console.log(
		`Backfill with: npx tsx scripts/migrate-commcare-server.ts --project ${project} (dry run; add --apply to write)`,
	);
}

runMain(main);
