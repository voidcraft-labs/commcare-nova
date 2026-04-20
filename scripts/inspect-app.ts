/**
 * Read-only inspection of an app document in Firestore.
 *
 * Shows app metadata, status, blueprint structure (modules/forms/fields),
 * computed analytics, and thread history. Operates on the hydrated
 * `BlueprintDoc` — `hydrateBlueprint` attaches the derived `fieldParent`
 * index so the domain walkers in `lib/doc/fieldWalk.ts` accept it.
 *
 * Never writes to Firestore. Run with `--help` for the flag reference.
 */
import { Command } from "commander";
import type { FieldWithChildren } from "@/lib/doc/fieldWalk";
import { buildFieldTree, countFieldsUnder } from "@/lib/doc/fieldWalk";
import { readRunSummary } from "@/lib/log/reader";
import { analyzeBlueprint, extractLogicFields } from "./lib/blueprint-stats";
import { db, hydrateBlueprint } from "./lib/firestore";
import {
	printHeader,
	printKV,
	printSection,
	printTable,
	truncate,
	tsToISO,
} from "./lib/format";
import { requireArg, runMain } from "./lib/main";
import type { BlueprintDoc, Form, Module, RunSummaryDoc } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

/* View flags are additive switches. All combinable except --blueprint,
 * which is standalone and short-circuits the render. */
interface InspectAppOptions {
	fields?: boolean;
	threads?: boolean;
	blueprint?: boolean;
	stats?: boolean;
	caseLists?: boolean;
	logic?: boolean;
}

const program = new Command();
program
	.name("inspect-app")
	.description(
		"Read-only inspection of an app document in Firestore. Shows metadata, blueprint structure, analytics, and chat threads.",
	)
	.argument("<appId>", "Firestore app document id (root-level apps collection)")
	.option("--fields", "include the full ordered field tree under every form")
	.option(
		"--stats",
		"include field-kind + logic-element + form-type + quality tables",
	)
	.option(
		"--logic",
		"include a flat table of fields with calculate/relevant/validate/required/etc.",
	)
	.option("--case-lists", "include every module's case list + detail columns")
	.option(
		"--blueprint",
		"dump the raw BlueprintDoc JSON (standalone; skips other views)",
	)
	.option("--threads", "include full message content of every chat thread")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/inspect-app.ts <appId>\n" +
			"  $ npx tsx scripts/inspect-app.ts <appId> --stats\n" +
			"  $ npx tsx scripts/inspect-app.ts <appId> --stats --case-lists\n" +
			"  $ npx tsx scripts/inspect-app.ts <appId> --blueprint    # raw JSON\n",
	);

program.parse();

const appId = requireArg(program.args, 0, "appId");
const opts = program.opts<InspectAppOptions>();
const showFields = opts.fields === true;
const showThreads = opts.threads === true;
const showBlueprint = opts.blueprint === true;
const showStats = opts.stats === true;
const showCaseLists = opts.caseLists === true;
const showLogic = opts.logic === true;

// ── Field tree printing ─────────────────────────────────────────────

/**
 * Print a pre-built ordered field tree. Consumes the output of
 * `buildFieldTree`, which already resolved ordering and container
 * descent — the printer just flattens it with indentation.
 *
 * `HiddenField` is the sole field kind with no `label` key; every
 * other kind carries one. The `"label" in f` guard keeps this honest
 * in the face of the discriminated union.
 */
function printFieldTree(tree: FieldWithChildren[], indent = 0): void {
	const pad = "  ".repeat(indent);
	for (const f of tree) {
		const label = "label" in f ? (f.label ?? "(no label)") : "(no label)";
		console.log(
			`${pad}  - [${f.kind}] ${f.id} — "${truncate(label, 60)}" (${f.uuid.slice(0, 8)})`,
		);
		if (f.children) {
			printFieldTree(f.children, indent + 1);
		}
	}
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	/* ── App document ─────────────────────────────────────────────── */
	const snap = await db.collection("apps").doc(appId).get();
	if (!snap.exists) {
		console.error(`App ${appId} not found.`);
		process.exit(1);
	}

	// biome-ignore lint/style/noNonNullAssertion: guarded by snap.exists check above
	const data = snap.data()!;
	/* Firestore stores the `PersistableDoc` shape (no `fieldParent`).
	 * `hydrateBlueprint` attaches the derived reverse index so the
	 * domain walkers (`buildFieldTree`, `countFieldsUnder`) accept it. */
	const doc: BlueprintDoc | undefined =
		data.blueprint !== undefined ? hydrateBlueprint(data.blueprint) : undefined;

	const moduleOrder = doc?.moduleOrder ?? [];
	const modules: Module[] = moduleOrder
		.map((uuid) => doc?.modules[uuid])
		.filter((m): m is Module => m !== undefined);

	const totalForms = modules.reduce(
		(sum, m) => sum + (doc?.formOrder[m.uuid]?.length ?? 0),
		0,
	);
	const totalFields = modules.reduce((sum, m) => {
		const formUuids = doc?.formOrder[m.uuid] ?? [];
		return (
			sum +
			formUuids.reduce(
				(s, fUuid) => s + (doc ? countFieldsUnder(doc, fUuid) : 0),
				0,
			)
		);
	}, 0);

	printHeader("APP INSPECTION (read-only)");

	printKV([
		["App ID", appId],
		["App Name", data.app_name ?? "(unnamed)"],
		["Owner", data.owner ?? "(unknown)"],
		["Status", data.status ?? "(unknown)"],
		["Error Type", data.error_type ?? "(none)"],
		["Run ID", data.run_id ?? "(none)"],
		["Connect Type", data.connect_type ?? "(none)"],
		["Created", tsToISO(data.created_at)],
		["Updated", tsToISO(data.updated_at)],
		["Modules", String(modules.length)],
		["Forms", String(totalForms)],
		["Fields", String(totalFields)],
	]);

	/* ── Blueprint JSON dump (standalone mode) ───────────────────── */
	if (showBlueprint) {
		printSection("Full Blueprint JSON");
		console.log(JSON.stringify(doc, null, 2));
		/* --blueprint is standalone — skip structure view, stats, threads. */
		return;
	}

	if (!doc) {
		console.error("\n  App has no blueprint.");
		return;
	}

	/* ── Blueprint structure ──────────────────────────────────────── */
	printSection("Blueprint Structure");

	for (const [i, mod] of modules.entries()) {
		const formUuids = doc.formOrder[mod.uuid] ?? [];
		const forms = formUuids
			.map((uuid) => doc.forms[uuid])
			.filter((f): f is Form => f !== undefined);
		const flags = [
			mod.caseType && `case: ${mod.caseType}`,
			mod.caseListOnly && "case-list-only",
		]
			.filter(Boolean)
			.join(", ");

		console.log(
			`  Module ${i}: ${mod.name ?? "(unnamed)"}${flags ? ` (${flags})` : ""}`,
		);

		for (const [j, form] of forms.entries()) {
			const fieldCount = countFieldsUnder(doc, form.uuid);
			console.log(
				`    Form ${j}: ${form.name ?? "(unnamed)"} (${form.type}) — ${fieldCount} fields`,
			);

			if (showFields) {
				printFieldTree(buildFieldTree(doc, form.uuid), 3);
			}
		}
	}

	/* ── Stats view (--stats) ────────────────────────────────────── */
	if (showStats) {
		const stats = analyzeBlueprint(doc);

		/* Field kinds breakdown. */
		printSection("Field Kinds");
		const kindEntries = Object.entries(stats.totals.fieldKinds.byKind).sort(
			(a, b) => b[1] - a[1],
		);
		printTable(
			[{ header: "Kind" }, { header: "Count", align: "right" }],
			kindEntries.map(([kind, count]) => [kind, String(count)]),
		);

		/* Logic elements summary. */
		printSection("Logic Elements");
		const logic = stats.totals.logic;
		printTable(
			[{ header: "Element" }, { header: "Count", align: "right" }],
			[
				["Calculates", String(logic.calculates)],
				["Show-whens (relevant)", String(logic.relevants)],
				["Default values", String(logic.defaults)],
				["Validations", String(logic.validations)],
				["Required fields", String(logic.requireds)],
				["Hints", String(logic.hints)],
				["Labels (info)", String(logic.labels)],
				["Fields with logic", String(logic.fieldsWithLogic)],
			],
		);

		/* Form type breakdown. */
		printSection("Form Types");
		printTable(
			[{ header: "Type" }, { header: "Count", align: "right" }],
			Object.entries(stats.totals.formsByType).map(([type, count]) => [
				type,
				String(count),
			]),
		);

		/* Case types summary. */
		if (stats.caseTypes.length > 0) {
			printSection("Case Types");
			printTable(
				[
					{ header: "Name" },
					{ header: "Properties", align: "right" },
					{ header: "Parent" },
				],
				stats.caseTypes.map((ct) => [
					ct.name,
					String(ct.propertyCount),
					ct.parentType ?? "—",
				]),
			);
		}

		/* Quality flags. */
		if (stats.qualityFlags.length > 0) {
			printSection("Quality Flags");
			for (const flag of stats.qualityFlags) {
				const icon =
					flag.severity === "error"
						? "✗"
						: flag.severity === "warn"
							? "!"
							: "·";
				const location = [flag.module, flag.form].filter(Boolean).join(" > ");
				console.log(
					`  [${icon}] ${location ? `${location}: ` : ""}${flag.message}`,
				);
			}
		}
	}

	/* ── Case list columns view (--case-lists) ───────────────────── */
	if (showCaseLists) {
		printSection("Case List Columns");
		for (const mod of modules) {
			const cols = mod.caseListColumns ?? [];
			const detailCols = mod.caseDetailColumns ?? [];
			if (cols.length === 0 && detailCols.length === 0) continue;

			console.log(`  ${mod.name} (${mod.caseType ?? "no case type"}):`);
			if (cols.length > 0) {
				console.log("    List columns:");
				printTable(
					[{ header: "    Field" }, { header: "Header" }],
					cols.map((c) => [`    ${c.field}`, c.header]),
				);
			}
			if (detailCols.length > 0) {
				console.log("    Detail columns:");
				printTable(
					[{ header: "    Field" }, { header: "Header" }],
					detailCols.map((c) => [`    ${c.field}`, c.header]),
				);
			}
			console.log();
		}
	}

	/* ── Logic fields view (--logic) ─────────────────────────────── */
	if (showLogic) {
		const logicFields = extractLogicFields(doc);
		printSection(`Logic Fields (${logicFields.length} total)`);

		if (logicFields.length === 0) {
			console.log("  (no fields with logic elements)");
		} else {
			printTable(
				[{ header: "Path" }, { header: "Kind" }, { header: "Elements" }],
				logicFields.map((lq) => [
					truncate(lq.path, 50),
					lq.kind,
					lq.has.join(", "),
				]),
			);
		}
	}

	/* ── Threads ──────────────────────────────────────────────────── */
	const threads = await db
		.collection("apps")
		.doc(appId)
		.collection("threads")
		.orderBy("created_at", "asc")
		.get();

	if (!threads.empty) {
		/* Pre-fetch per-run summary docs for every thread unconditionally.
		 * The summary doc at apps/{appId}/runs/{runId} carries prompt mode,
		 * app-ready state, cache-expiry flag, and module count — rendered
		 * per thread below. Gating the fetch on `--threads` would silently
		 * hide the "Run: ..." line in the default structure view. */
		const runIds = threads.docs
			.map((d) => d.data().run_id as string | undefined)
			.filter((id): id is string => Boolean(id));

		const summaries = await Promise.all(
			runIds.map(async (runId) => ({
				runId,
				summary: await readRunSummary(appId, runId),
			})),
		);
		const summaryByRun = new Map<string, RunSummaryDoc>();
		for (const { runId, summary } of summaries) {
			if (summary) summaryByRun.set(runId, summary);
		}

		printSection("Chat Threads");

		for (const threadDoc of threads.docs) {
			const t = threadDoc.data();
			const msgCount = t.messages?.length ?? 0;
			console.log(
				`  Thread ${threadDoc.id.slice(0, 8)}… (${t.thread_type}) — ${msgCount} messages`,
			);
			console.log(`    Created:  ${t.created_at}`);
			console.log(`    Summary:  ${truncate(t.summary ?? "", 100)}`);
			console.log(`    Run ID:   ${t.run_id}`);

			const summary = summaryByRun.get(t.run_id);
			if (summary) {
				console.log(
					`    Run:      prompt=${summary.promptMode} appReady=${summary.appReady} cacheExpired=${summary.cacheExpired} modules=${summary.moduleCount}`,
				);
			} else {
				console.log("    Run:      (no run summary doc for this run)");
			}

			/* Full message content when --threads is active. */
			if (showThreads) {
				const messages = t.messages ?? [];
				for (const msg of messages) {
					console.log();
					console.log(`    [${msg.role}]`);
					for (const part of msg.parts ?? []) {
						if (part.type === "text") {
							for (const line of part.text.split("\n")) {
								console.log(`      ${line}`);
							}
						} else if (part.type === "askQuestions") {
							console.log(`      askQuestions: "${part.header}"`);
							for (const qa of part.questions ?? []) {
								console.log(`        Q: ${truncate(qa.question, 120)}`);
								console.log(`        A: ${truncate(qa.answer, 120)}`);
							}
						}
					}
				}
			}

			if (showThreads) console.log();
		}
	} else {
		console.log("\n  (no threads)");
	}
}

runMain(main);
