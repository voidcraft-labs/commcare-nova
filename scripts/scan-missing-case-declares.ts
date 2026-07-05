/**
 * READ-ONLY — size the missing-case-declare event-log migration.
 *
 * P2 removed `ensureCatalogProperty`'s auto-mint, so a pre-P2 event log that
 * created a case type via a field write (the subcase / child-case pattern) —
 * with no `declareCaseType` event — reconstructs a doc MISSING that type on a
 * from-events replay (the admin replay/inspect view; live apps hydrate from
 * the snapshot and are unaffected). This reports, per app, the synthetic
 * `declareCaseType` events `migrate-missing-case-declares.ts` would ADD.
 *
 * The migration is APPEND-ONLY: each synthetic declare is one new event doc;
 * no existing event is modified. So the write volume equals the declare count.
 *
 * `migrate-missing-case-declares.ts` is the paired writer. Run with `--help`.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import type { Event } from "@/lib/log/types";
import { eventSchema } from "@/lib/log/types";
import { injectMissingCaseTypeDeclarations } from "./lib/injectCaseTypeDeclarations";
import { runMain } from "./lib/main";

interface ScanOptions {
	project: string;
}

const program = new Command();
program
	.name("scan-missing-case-declares")
	.description(
		"Report the synthetic declareCaseType events the missing-case-declare " +
			"migration would add per app (read-only). One-time: run against " +
			"production when deploying the auto-mint removal over pre-P2 event logs, " +
			"before migrate-missing-case-declares.ts.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to scan (e.g. "commcare-nova-dev") — explicit so a scan can never land on an unintended project',
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-missing-case-declares.ts --project commcare-nova-dev\n",
	);

program.parse();
const { project } = program.opts<ScanOptions>();

/** Read an app's events in `(ts, seq)` order, dropping any that fail the
 *  schema (a degenerate historical event must not block sizing the rest). */
async function readEvents(
	appRef: FirebaseFirestore.DocumentReference,
): Promise<{ events: Event[]; total: number; skipped: number }> {
	const snap = await appRef
		.collection("events")
		.orderBy("ts")
		.orderBy("seq")
		.get();
	const events: Event[] = [];
	let skipped = 0;
	for (const doc of snap.docs) {
		const parsed = eventSchema.safeParse(doc.data());
		if (parsed.success) events.push(parsed.data);
		else skipped++;
	}
	return { events, total: snap.size, skipped };
}

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(`Scanning apps in project "${project}"…\n`);

	const apps = await db.collection("apps").get();
	let appsTouched = 0;
	let totalInjections = 0;
	let totalSkipped = 0;

	for (const appSnap of apps.docs) {
		const { events, skipped } = await readEvents(appSnap.ref);
		totalSkipped += skipped;
		if (events.length === 0) continue;
		const { injections } = injectMissingCaseTypeDeclarations(events);
		if (injections.length === 0) continue;
		appsTouched++;
		totalInjections += injections.length;
		const detail = injections
			.map((i) => `${i.caseType} [${i.trigger}]`)
			.join(", ");
		console.log(
			`${appSnap.id} (${appSnap.data().app_name ?? "unnamed"}): ` +
				`${injections.length} declare(s) → ${detail}`,
		);
	}

	console.log(
		`\n${apps.size} app(s) scanned; ${appsTouched} need injection; ` +
			`${totalInjections} synthetic declareCaseType event(s) to add ` +
			`(append-only — no existing event modified).`,
	);
	if (totalSkipped > 0) {
		console.log(
			`${totalSkipped} event(s) skipped as unparseable (degenerate historical shape).`,
		);
	}
	console.log(
		`Apply with: npx tsx scripts/migrate-missing-case-declares.ts --project ${project} --write`,
	);
}

runMain(main);
