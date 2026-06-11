/**
 * ⚠️  WRITES — flip app rows from the retired `status: "draft"` to
 * `"complete"`.
 *
 * The status enum dropped `"draft"` when the draft lifecycle collapsed
 * into the single commit rule, so any row persisted with it fails the
 * Zod converter on read (`loadApp` throws). `"complete"` is the correct
 * destination: status is pure run-liveness, a draft row has no run in
 * flight, and an app's validity never keys on status — pre-existing
 * findings stay grandfathered under the commit gate either way.
 *
 * Dry run by default — pass `--apply` to write. `scan-draft-status.ts`
 * is the read-only twin. Only `status` changes: `updated_at` stays
 * untouched (the blueprint didn't change, and a fresh timestamp would
 * lie to the list ordering), and the soft-delete axis is orthogonal
 * (a soft-deleted draft row flips too, so the trash view can read it).
 *
 * Idempotent: re-running matches nothing once every row is flipped.
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
	.name("migrate-draft-status")
	.description(
		'Flip app rows from the retired status "draft" to "complete". Defaults to a dry run — pass --apply to write.',
	)
	.requiredOption(
		"--project <id>",
		'GCP project to migrate (e.g. "commcare-nova-dev") — explicit so a write can never land on an unintended project',
	)
	.option("--apply", "actually write the status changes (default: dry run)")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-draft-status.ts --project commcare-nova-dev          # dry run\n" +
			"  $ npx tsx scripts/migrate-draft-status.ts --project commcare-nova-dev --apply  # write\n",
	);

program.parse();
const { project, apply } = program.opts<MigrateOptions>();

async function main() {
	const db = new Firestore({
		projectId: project,
		preferRest: true,
	});

	const header = apply
		? `⚠️  MIGRATION (writes to "${project}")`
		: `MIGRATION — dry run (read-only) against "${project}"`;
	console.log(`${header}\n`);

	const snap = await db.collection("apps").where("status", "==", "draft").get();

	if (snap.empty) {
		console.log("No draft-status rows found. Nothing to do.");
		return;
	}

	for (const doc of snap.docs) {
		const data = doc.data();
		const label = `${doc.id} (${data.app_name ?? "(unnamed)"})`;
		if (apply) {
			await doc.ref.update({ status: "complete" });
			console.log(`  flipped ${label} → complete`);
		} else {
			console.log(`  would flip ${label} → complete`);
		}
	}

	console.log(
		`\n${snap.size} row${snap.size === 1 ? "" : "s"} ${apply ? "flipped" : "would be flipped"}.` +
			(apply ? "" : " Re-run with --apply to write."),
	);
}

runMain(main);
