/**
 * READ-ONLY — find app rows still carrying the retired `status: "draft"`.
 *
 * The status enum dropped `"draft"` when the draft lifecycle collapsed
 * into the single commit rule, so any row persisted with it now fails
 * the Zod converter on read (`loadApp` throws). This scan lists every
 * such row in the named project; `migrate-draft-status.ts` is the
 * paired writer that flips them to `"complete"`.
 *
 * Run with `--help` for flags.
 */
import { Firestore, type Timestamp } from "@google-cloud/firestore";
import { Command } from "commander";
import { tsToISO } from "./lib/format";
import { runMain } from "./lib/main";

interface ScanOptions {
	project: string;
}

const program = new Command();
program
	.name("scan-draft-status")
	.description(
		'List app rows whose status is the retired "draft" value (read-only).',
	)
	.requiredOption(
		"--project <id>",
		'GCP project to scan (e.g. "commcare-nova-dev") — explicit so a scan can never land on an unintended project',
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-draft-status.ts --project commcare-nova-dev\n",
	);

program.parse();
const { project } = program.opts<ScanOptions>();

async function main() {
	const db = new Firestore({
		projectId: project,
		preferRest: true,
	});

	console.log(`Scanning apps in project "${project}" for status "draft"…\n`);

	const snap = await db.collection("apps").where("status", "==", "draft").get();

	if (snap.empty) {
		console.log("No draft-status rows found. Nothing to migrate.");
		return;
	}

	for (const doc of snap.docs) {
		const data = doc.data();
		console.log(`  ${doc.id}`);
		console.log(`    name:       ${data.app_name ?? "(unnamed)"}`);
		console.log(`    owner:      ${data.owner ?? "(none)"}`);
		console.log(`    updated_at: ${tsToISO(data.updated_at as Timestamp)}`);
		console.log(
			`    deleted_at: ${data.deleted_at ?? "null (live)"}` +
				(data.deleted_at ? " (soft-deleted — still migrated)" : ""),
		);
	}

	console.log(
		`\n${snap.size} draft-status row${snap.size === 1 ? "" : "s"} found.`,
	);
	console.log(
		`Flip them with: npx tsx scripts/migrate-draft-status.ts --project ${project} (dry run; add --apply to write)`,
	);
}

runMain(main);
