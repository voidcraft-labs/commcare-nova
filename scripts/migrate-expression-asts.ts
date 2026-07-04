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
 * the mutation originally ran — and an event is WRITTEN only after the
 * reducer advanced the doc through it. If a reducer throws (reducers
 * are total, so this should be unreachable), the app's event
 * conversion ABORTS at that event — converting past a doc that stopped
 * advancing could resolve references against a stale namespace, and
 * the round-trip gate can't see that (it prints against the same stale
 * doc). Other apps continue; the run exits non-zero. Event identity
 * and ordering are untouched — only the `mutation` payload field
 * changes.
 *
 * Dry run by default — pass `--apply` to write.
 * `scan-expression-asts.ts` is the read-only twin. Idempotent:
 * a converted slot reads as already-current on a re-run.
 *
 * The blueprint write goes through `appendSyntheticBatchTx`
 * (`lib/db/apps.ts` — the app writers' own snapshot-field shape plus a
 * `kind: "migration"` reload-sentinel stream entry), so a builder tab
 * still open across the migration window reloads onto the converted
 * row, and any straggler auto-save is a mutation delta re-applied onto
 * it by the guarded commit — never a blind PUT of its pre-AST doc
 * (which the deployed code's strict load gate would then refuse).
 *
 * One-time migration: the deployed code reads ONLY the AST shape, so
 * the owner runs this against production when deploying the
 * expression-AST representation over data written before it — scan
 * first, then dry run, then `--apply`.
 *
 * Run with `--help` for flags.
 */
import { Firestore } from "@google-cloud/firestore";
import { Command } from "commander";
import { appendSyntheticBatchTx } from "../lib/db/apps";
import {
	type DocExpressionMigrationResult,
	migrateDocExpressions,
	migrateMutationExpressions,
} from "../lib/doc/expressionMigration";
import { rebuildFieldParent, toPersistableDoc } from "../lib/doc/fieldParent";
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
		"Convert stored blueprints + event logs to the expression-AST representation. Defaults to a dry run — pass --apply to write. " +
			"One-time: run against production when deploying the expression-AST code over pre-AST data (scan-expression-asts.ts first).",
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
	const abortedApps: string[] = [];

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
					/* The app writers' snapshot-field shape plus a `kind:
					 * "migration"` reload-sentinel stream entry — a builder tab
					 * open across the migration window reloads onto the converted
					 * row instead of blind-PUTting its pre-AST doc back over it.
					 * The conversion never adds an asset reference, so the
					 * writers' media reverse-index sync has nothing to add. */
					await appendSyntheticBatchTx(
						db,
						appSnap.id,
						toPersistableDoc(migrated),
					);
					blueprintWrites++;
				}
			} else {
				reportFailures("  ", result);
			}
		}

		// ── Event log, reduced forward ───────────────────────────────
		//
		// Each event converts against the doc reduced forward from the
		// app's own stream, and is WRITTEN only after the reducer has
		// provably advanced the doc through it. A reducer throw should be
		// unreachable (reducers are total) — but if one happens, the doc
		// context stops advancing, and any later event would convert
		// against a stale namespace: a reference could resolve to the
		// WRONG identity leaf, and the per-slot round-trip check couldn't
		// catch it because it prints against the same stale doc. So the
		// only safe refusal is to abort THIS app's event conversion at the
		// throwing event — nothing at or after it is converted or written
		// — and continue with the other apps.
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
			try {
				const next = structuredClone(doc);
				applyMutations(next, [payload as unknown as Mutation]);
				doc = next;
			} catch (err) {
				console.log(
					`\n✗ ${label}: ABORTED at event ${eventSnap.id} — replaying its mutation threw:\n` +
						`    ${String(err)}\n` +
						`  Reducers are total, so this stream holds a shape the current reducers can't replay.\n` +
						`  Events before this one are ${apply ? "converted" : "reported"}; this event and everything after it were left untouched,\n` +
						`  because converting them against a doc that stopped advancing here could resolve references\n` +
						`  to the wrong fields. Fix the event (or the reducer gap it exposes), then re-run for this app.\n`,
				);
				abortedApps.push(`${label} (event ${eventSnap.id})`);
				break;
			}
			if (result.converted > 0 || result.closeRefsConverted > 0) {
				if (apply) {
					await eventSnap.ref.update({ mutation: payload });
					eventWrites++;
				}
				appEventWrites++;
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
	if (abortedApps.length > 0) {
		console.log(
			`\n✗ Event conversion ABORTED for ${abortedApps.length} app(s) — see the per-app reports above:\n` +
				abortedApps.map((entry) => `  - ${entry}`).join("\n"),
		);
		process.exitCode = 1;
	}
	if (!apply) {
		console.log("Re-run with --apply to write.");
	}
}

runMain(main);
