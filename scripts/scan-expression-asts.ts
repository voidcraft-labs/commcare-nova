/**
 * READ-ONLY — size the expression-AST migration across every app's
 * stored blueprint AND event log.
 *
 * One-time migration pair: the deployed code reads ONLY the AST shape,
 * so the owner runs this scan against production when deploying the
 * expression-AST representation over data written before it, then
 * `migrate-expression-asts.ts` (dry-run first, then `--apply`).
 *
 * For each app this runs the shared converter (`migrateDocExpressions`
 * / `migrateMutationExpressions`) on CLONES and reports, per app:
 *
 *   - blueprint slots that would convert string → AST, slots already in
 *     the new shape, close-condition refs that would convert id → uuid;
 *   - event-log mutation payloads that would convert, reduced forward
 *     so each payload resolves against the doc as of its event;
 *   - every ROUND-TRIP FAILURE verbatim (a stored text whose parsed
 *     AST prints differently — the parser/printer law says this set is
 *     empty; anything here is a bug to look at, never auto-fixed);
 *   - every close-condition ref nothing answers to (left as text, the
 *     validator's dangling signal).
 *
 * `migrate-expression-asts.ts` is the paired writer.
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

interface ScanOptions {
	project: string;
}

const program = new Command();
program
	.name("scan-expression-asts")
	.description(
		"Report what the expression-AST migration would change per app (read-only). " +
			"One-time: run against production when deploying the expression-AST code over pre-AST data, before migrate-expression-asts.ts.",
	)
	.requiredOption(
		"--project <id>",
		'GCP project to scan (e.g. "commcare-nova-dev") — explicit so a scan can never land on an unintended project',
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/scan-expression-asts.ts --project commcare-nova-dev\n",
	);

program.parse();
const { project } = program.opts<ScanOptions>();

/** Empty doc shell event reduction starts from — apps are born by
 *  their first run's events. */
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

function mergeInto(
	total: DocExpressionMigrationResult,
	part: DocExpressionMigrationResult,
): void {
	total.converted += part.converted;
	total.skipped += part.skipped;
	total.closeRefsConverted += part.closeRefsConverted;
	total.failures.push(...part.failures);
	total.unresolvedCloseRefs.push(...part.unresolvedCloseRefs);
}

async function main() {
	const db = new Firestore({ projectId: project, preferRest: true });
	console.log(`Scanning apps in project "${project}"…\n`);

	const apps = await db.collection("apps").get();
	let appsWithConversions = 0;
	let totalFailures = 0;
	let totalUnresolved = 0;

	for (const appSnap of apps.docs) {
		const data = appSnap.data();
		const lines: string[] = [];

		// ── Blueprint ────────────────────────────────────────────────
		const blueprint = data.blueprint as BlueprintDoc | undefined;
		if (blueprint) {
			const clone = structuredClone(blueprint);
			rebuildFieldParent(clone);
			const result = migrateDocExpressions(clone);
			if (
				result.converted > 0 ||
				result.closeRefsConverted > 0 ||
				result.failures.length > 0 ||
				result.unresolvedCloseRefs.length > 0
			) {
				lines.push(
					`  blueprint: ${result.converted} expression slot(s) → AST, ` +
						`${result.closeRefsConverted} close ref(s) → uuid, ` +
						`${result.skipped} already current`,
				);
				for (const failure of result.failures) {
					lines.push(
						`    ROUND-TRIP FAIL [${failure.slot} on ${failure.entityUuid}]\n` +
							`      stored:  ${JSON.stringify(failure.text)}\n` +
							`      printed: ${JSON.stringify(failure.printed)}`,
					);
				}
				for (const dangler of result.unresolvedCloseRefs) {
					lines.push(
						`    close ref unresolved on form ${dangler.formUuid}: ${JSON.stringify(dangler.ref)} (left as text; validator flags it)`,
					);
				}
				totalFailures += result.failures.length;
				totalUnresolved += result.unresolvedCloseRefs.length;
			}
		} else {
			lines.push("  blueprint: none on the row");
		}

		// ── Event log, reduced forward ───────────────────────────────
		const events = await appSnap.ref
			.collection("events")
			.orderBy("ts")
			.orderBy("seq")
			.get();
		if (!events.empty) {
			let doc = emptyDoc(appSnap.id);
			const eventTotal: DocExpressionMigrationResult = {
				converted: 0,
				skipped: 0,
				failures: [],
				closeRefsConverted: 0,
				unresolvedCloseRefs: [],
			};
			let mutationEvents = 0;
			for (const eventSnap of events.docs) {
				const event = eventSnap.data() as {
					kind?: unknown;
					mutation?: Record<string, unknown>;
				};
				if (event.kind !== "mutation" || !event.mutation) continue;
				mutationEvents++;
				const payload = structuredClone(event.mutation);
				mergeInto(eventTotal, migrateMutationExpressions(doc, payload));
				try {
					const next = structuredClone(doc);
					applyMutations(next, [payload as unknown as Mutation]);
					doc = next;
				} catch (err) {
					lines.push(
						`    event ${eventSnap.id}: reducing the migrated payload threw — ${String(err)}`,
					);
				}
			}
			if (
				eventTotal.converted > 0 ||
				eventTotal.closeRefsConverted > 0 ||
				eventTotal.failures.length > 0
			) {
				lines.push(
					`  events: ${mutationEvents} mutation event(s); ` +
						`${eventTotal.converted} payload slot(s) → AST, ` +
						`${eventTotal.closeRefsConverted} close ref(s) → uuid`,
				);
				for (const failure of eventTotal.failures) {
					lines.push(
						`    ROUND-TRIP FAIL [${failure.slot} on ${failure.entityUuid}]\n` +
							`      stored:  ${JSON.stringify(failure.text)}\n` +
							`      printed: ${JSON.stringify(failure.printed)}`,
					);
				}
				totalFailures += eventTotal.failures.length;
			}
		}

		if (lines.length > 0) {
			appsWithConversions++;
			console.log(`${appSnap.id} (${data.app_name ?? "unnamed"})`);
			for (const line of lines) console.log(line);
		}
	}

	console.log(
		`\n${apps.size} app(s) scanned; ${appsWithConversions} with work to do; ` +
			`${totalFailures} round-trip failure(s); ${totalUnresolved} unresolved close ref(s).`,
	);
	console.log(
		`Convert with: npx tsx scripts/migrate-expression-asts.ts --project ${project} (dry run; add --apply to write)`,
	);
}

runMain(main);
