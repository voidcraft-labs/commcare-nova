/**
 * READ-ONLY — size the `blueprint_token` field removal across app docs.
 *
 * One-time migration pair: `blueprint_token` was the single-editor
 * optimistic-concurrency basis; the guarded commit (re-apply-on-fresh +
 * `mutation_seq`) replaced it and no code reads or writes the field any
 * more. This scan reports which app docs still carry the leftover key,
 * then `strip-blueprint-token.ts` deletes it (dry-run first, then
 * `--apply`).
 *
 * `batchDedup` latches that recorded a `basisToken` need no migration —
 * every latch carries an `expireAt` TTL and self-deletes.
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
	.name("scan-blueprint-token")
	.description(
		"Report which app docs still carry the retired blueprint_token field (read-only). " +
			"One-time: run against production before strip-blueprint-token.ts.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to scan (e.g. "commcare-nova-dev") — explicit so a scan can never land on an unintended project',
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-blueprint-token.ts --project commcare-nova-dev\n",
	);

program.parse();
const { project } = program.opts<ScanOptions>();

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(`Scanning apps in project "${project}"…\n`);

	const apps = await db.collection("apps").get();
	let carrying = 0;
	for (const appSnap of apps.docs) {
		const data = appSnap.data();
		if ("blueprint_token" in data) {
			carrying += 1;
			console.log(
				`  ${appSnap.id}  (${data.app_name ?? "(unnamed)"})  token=${JSON.stringify(data.blueprint_token)}`,
			);
		}
	}

	console.log(
		`\n${carrying} of ${apps.size} app doc(s) carry blueprint_token.`,
	);
	if (carrying > 0) {
		console.log(
			"Next: npx tsx scripts/strip-blueprint-token.ts --project " +
				`${project} (dry run), then add --apply.`,
		);
	}
}

runMain(main);
