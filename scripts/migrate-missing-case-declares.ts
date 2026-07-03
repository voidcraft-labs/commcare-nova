/**
 * WRITER — inject the missing `declareCaseType` events pre-P2 event logs need
 * so a from-events replay reconstructs the case types their runs created.
 *
 * Paired with the read-only `scan-missing-case-declares.ts` (run that first).
 * Dry-run by DEFAULT; pass `--write` to persist. `--app-id=<id>` targets one
 * app.
 *
 * Each synthetic declare is APPEND-ONLY: one new event doc, no existing event
 * touched. Its doc id is `!nova-decl-<ts>-<seq>-<caseType>` — the `!` prefix
 * sorts before every Firestore auto-id, so at the trigger's identical
 * `(ts, seq)` the reader's implicit `__name__` tiebreak places the declare
 * immediately BEFORE its triggering field-write. Deterministic id ⇒ a re-run
 * `set()`s the identical doc (idempotent), and the transform re-injects
 * nothing once the declares are present.
 *
 * Run with `--help`.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import type { Event, MutationEvent } from "@/lib/log/types";
import { eventSchema } from "@/lib/log/types";
import { injectMissingCaseTypeDeclarations } from "./lib/injectCaseTypeDeclarations";
import { runMain } from "./lib/main";

interface MigrateOptions {
	project: string;
	write?: boolean;
	appId?: string;
}

const program = new Command();
program
	.name("migrate-missing-case-declares")
	.description(
		"Inject synthetic declareCaseType events into pre-P2 event logs so replay " +
			"reconstructs the case types their runs created. Dry-run by default; " +
			"--write persists. Run scan-missing-case-declares.ts first.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to migrate (e.g. "commcare-nova-dev") — explicit so a write can never land on an unintended project',
	)
	.option(
		"--write",
		"Opt INTO live writes. Without it the script is a dry run (prints what it would add).",
	)
	.option(
		"--app-id <id>",
		"Target one app by id; otherwise every app is scanned.",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-missing-case-declares.ts --project commcare-nova-dev            # dry run\n" +
			"  $ npx tsx scripts/migrate-missing-case-declares.ts --project commcare-nova-dev --write    # live\n" +
			"  $ npx tsx scripts/migrate-missing-case-declares.ts --project commcare-nova-dev --app-id abc123 --write\n",
	);

program.parse();
const { project, write, appId } = program.opts<MigrateOptions>();

/** A Firestore-safe, deterministic id that sorts before every auto-id (the
 *  `!` prefix) so the synthetic declare reads back just before its trigger. */
function syntheticDocId(event: MutationEvent, caseType: string): string {
	const safeType = caseType.replace(/[^A-Za-z0-9_-]/g, "_");
	return `!nova-decl-${event.ts}-${event.seq}-${safeType}`;
}

async function readEvents(
	appRef: FirebaseFirestore.DocumentReference,
): Promise<Event[]> {
	const snap = await appRef
		.collection("events")
		.orderBy("ts")
		.orderBy("seq")
		.get();
	const events: Event[] = [];
	for (const doc of snap.docs) {
		const parsed = eventSchema.safeParse(doc.data());
		if (parsed.success) events.push(parsed.data);
	}
	return events;
}

async function migrateApp(
	appRef: FirebaseFirestore.DocumentReference,
	label: string,
): Promise<number> {
	const events = await readEvents(appRef);
	if (events.length === 0) return 0;
	const { events: injected, injections } =
		injectMissingCaseTypeDeclarations(events);
	if (injections.length === 0) return 0;

	const eventsCol = appRef.collection("events");
	for (const injection of injections) {
		const declEvent = injected[injection.index] as MutationEvent;
		const docId = syntheticDocId(declEvent, injection.caseType);
		if (write) {
			await eventsCol.doc(docId).set(declEvent);
		}
		console.log(
			`  ${write ? "wrote" : "would add"} ${docId} → declareCaseType(${injection.caseType}) [${injection.trigger}]`,
		);
	}
	console.log(
		`${label}: ${injections.length} synthetic declare(s) ${write ? "written" : "(dry-run)"}`,
	);
	return injections.length;
}

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(
		`${write ? "Writing" : "Dry-run"} against project "${project}"` +
			`${appId ? ` (app ${appId})` : ""}…\n`,
	);

	let total = 0;
	if (appId) {
		const appSnap = await db.collection("apps").doc(appId).get();
		if (!appSnap.exists) throw new Error(`app "${appId}" not found`);
		total += await migrateApp(appSnap.ref, appSnap.id);
	} else {
		const apps = await db.collection("apps").get();
		for (const appSnap of apps.docs) {
			total += await migrateApp(appSnap.ref, appSnap.id);
		}
	}

	console.log(
		`\n${write ? "Wrote" : "Would write"} ${total} synthetic declareCaseType event(s).`,
	);
	if (!write && total > 0) {
		console.log("Re-run with --write to persist.");
	}
}

runMain(main);
