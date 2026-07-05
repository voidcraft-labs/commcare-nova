/**
 * Delete the retired `blueprint_token` field from every app doc that
 * still carries it.
 *
 * One-time migration pair with `scan-blueprint-token.ts` (run the scan
 * first). `blueprint_token` was the single-editor optimistic-concurrency
 * basis; the guarded commit (re-apply-on-fresh + `mutation_seq`) replaced
 * it and no code reads or writes the field any more — this strip is pure
 * data hygiene so old rows match the current `appDocSchema` shape.
 *
 * The write is a single-field `FieldValue.delete()` update: no other
 * field moves, `updated_at` is untouched (this is not a content write,
 * and stamping it would re-arm build-staleness inference on `generating`
 * rows), and live tabs are unaffected (nothing reads the field).
 *
 * `batchDedup` latches that recorded a `basisToken` need no migration —
 * every latch carries an `expireAt` TTL and self-deletes.
 *
 * Dry run by default — pass `--apply` to write. Idempotent: a stripped
 * doc no longer matches the scan predicate on a re-run.
 *
 * Run with `--help` for flags.
 */
import { FieldValue, Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import { runMain } from "./lib/main";

interface StripOptions {
	project: string;
	apply?: boolean;
}

const program = new Command();
program
	.name("strip-blueprint-token")
	.description(
		"Delete the retired blueprint_token field from app docs that still carry it. " +
			"Dry run by default; --apply writes.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to migrate (e.g. "commcare-nova-dev") — explicit so a write can never land on an unintended project',
	)
	.option("--apply", "Write the deletions (omit for a dry run)")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/strip-blueprint-token.ts --project commcare-nova-dev\n" +
			"  $ npx tsx scripts/strip-blueprint-token.ts --project commcare-nova-dev --apply\n",
	);

program.parse();
const { project, apply } = program.opts<StripOptions>();

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(
		`${apply ? "Stripping" : "DRY RUN — would strip"} blueprint_token in project "${project}"…\n`,
	);

	const apps = await db.collection("apps").get();
	let carrying = 0;
	for (const appSnap of apps.docs) {
		if (!("blueprint_token" in appSnap.data())) continue;
		carrying += 1;
		console.log(`  ${appSnap.id}`);
		if (apply) {
			await appSnap.ref.update({ blueprint_token: FieldValue.delete() });
		}
	}

	if (carrying === 0) {
		console.log("  (none — nothing to do)");
	}
	console.log(
		`\n${apply ? "Stripped" : "Would strip"} ${carrying} of ${apps.size} app doc(s).`,
	);
	if (!apply && carrying > 0) {
		console.log("Re-run with --apply to write.");
	}
}

runMain(main);
