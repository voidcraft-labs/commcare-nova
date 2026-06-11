/**
 * ⚠️  WRITES — convert stored expression slots to the AST
 * representation: every app blueprint's XPath slots string → expression
 * AST, close-condition refs id → uuid, and every event-log mutation
 * payload to the same shapes (so replay reads already-migrated events
 * through the current reducers — no replay shim, no legacy reducers).
 *
 * Conversion is ROUND-TRIP-GATED per expression by the shared core
 * (`migrateDocExpressions` / `migrateMutationExpressions`): a string
 * converts only when printing its parsed AST reproduces the stored
 * bytes exactly; anything else is REPORTED and left as-is. Event
 * payloads convert against the doc reduced forward from the app's own
 * stream, so each reference resolves with the namespace it had when
 * the mutation originally ran. Event identity and ordering are
 * untouched — only the `mutation` payload field changes.
 *
 * Dry run by default — pass `--apply` to write.
 * `scan-expression-asts.ts` is the read-only twin. Idempotent:
 * a converted slot reads as already-current on a re-run.
 *
 * Run with `--help` for flags.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import {
	type DocExpressionMigrationResult,
	migrateDocExpressions,
	migrateMutationExpressions,
} from "../lib/doc/expressionMigration";
import { rebuildFieldParent } from "../lib/doc/fieldParent";
import { applyMutations } from "../lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "../lib/doc/types";
import { runMain } from "./lib/main";

interface MigrateOptions {
	project: string;
	apply?: boolean;
}

const program = new Command();
program
	.name("migrate-expression-asts")
	.description(
		"Convert stored blueprints + event logs to the expression-AST representation. Defaults to a dry run — pass --apply to write.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to migrate (e.g. "commcare-nova-dev") — explicit so a write can never land on an unintended project',
	)
	.option("--apply", "actually write the conversions (default: dry run)")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-expression-asts.ts --project commcare-nova-dev          # dry run\n" +
			"  $ npx tsx scripts/migrate-expression-asts.ts --project commcare-nova-dev --apply  # write\n",
	);

program.parse();
const { project, apply } = program.opts<MigrateOptions>();

function emptyDoc(appId: string): BlueprintDoc {
	return {
		appId,
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

function reportFailures(
	prefix: string,
	result: DocExpressionMigrationResult,
): void {
	for (const failure of result.failures) {
		console.log(
			`${prefix} ROUND-TRIP FAIL [${failure.slot} on ${failure.entityUuid}] — left as text\n` +
				`${prefix}   stored:  ${JSON.stringify(failure.text)}\n` +
				`${prefix}   printed: ${JSON.stringify(failure.printed)}`,
		);
	}
	for (const dangler of result.unresolvedCloseRefs) {
		console.log(
			`${prefix} close ref unresolved on form ${dangler.formUuid}: ${JSON.stringify(dangler.ref)} — left as text`,
		);
	}
}

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(
		`${apply ? "MIGRATING" : "Dry run over"} apps in project "${project}"…\n`,
	);

	const apps = await db.collection("apps").get();
	let blueprintWrites = 0;
	let eventWrites = 0;

	for (const appSnap of apps.docs) {
		const data = appSnap.data();
		const label = `${appSnap.id} (${data.app_name ?? "unnamed"})`;

		// ── Blueprint ────────────────────────────────────────────────
		const blueprint = data.blueprint as BlueprintDoc | undefined;
		if (blueprint) {
			const migrated = structuredClone(blueprint);
			rebuildFieldParent(migrated);
			const result = migrateDocExpressions(migrated);
			if (result.converted > 0 || result.closeRefsConverted > 0) {
				console.log(
					`${label}: blueprint — ${result.converted} slot(s) → AST, ` +
						`${result.closeRefsConverted} close ref(s) → uuid`,
				);
				reportFailures("  ", result);
				if (apply) {
					// `fieldParent` is in-memory derived state — strip before
					// the write so the stored row stays the persisted shape.
					const { fieldParent: _derived, ...persisted } =
						migrated as BlueprintDoc & { refIndex?: unknown };
					delete (persisted as { refIndex?: unknown }).refIndex;
					await appSnap.ref.update({ blueprint: persisted });
					blueprintWrites++;
				}
			} else {
				reportFailures("  ", result);
			}
		}

		// ── Event log, reduced forward ───────────────────────────────
		const events = await appSnap.ref
			.collection("events")
			.orderBy("ts")
			.orderBy("seq")
			.get();
		let doc = emptyDoc(appSnap.id);
		let appEventWrites = 0;
		for (const eventSnap of events.docs) {
			const event = eventSnap.data() as {
				kind?: unknown;
				mutation?: Record<string, unknown>;
			};
			if (event.kind !== "mutation" || !event.mutation) continue;
			const payload = structuredClone(event.mutation);
			const result = migrateMutationExpressions(doc, payload);
			reportFailures("    ", result);
			if (result.converted > 0 || result.closeRefsConverted > 0) {
				if (apply) {
					await eventSnap.ref.update({ mutation: payload });
					eventWrites++;
				}
				appEventWrites++;
			}
			try {
				const next = structuredClone(doc);
				applyMutations(next, [payload as unknown as Mutation]);
				doc = next;
			} catch (err) {
				console.log(
					`  ${label}: event ${eventSnap.id} — reducing the migrated payload threw, stream context stops advancing here: ${String(err)}`,
				);
			}
		}
		if (appEventWrites > 0) {
			console.log(
				`${label}: events — ${appEventWrites} payload(s) ${apply ? "written" : "would convert"}`,
			);
		}
	}

	console.log(
		`\n${apply ? "Wrote" : "Would write"} ${blueprintWrites} blueprint(s) and ${eventWrites} event payload(s) across ${apps.size} app(s).`,
	);
	if (!apply) {
		console.log("Re-run with --apply to write.");
	}
}

runMain(main);
