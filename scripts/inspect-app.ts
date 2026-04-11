/**
 * Read-only inspection of an app document in Firestore.
 *
 * Shows app metadata, status, blueprint structure (modules/forms/questions),
 * computed analytics, and thread history. Never writes to Firestore.
 *
 * Usage:
 *   npx tsx scripts/inspect-app.ts <appId>                        # structure overview
 *   npx tsx scripts/inspect-app.ts <appId> --stats                # structure + analytics
 *   npx tsx scripts/inspect-app.ts <appId> --questions            # structure + question tree
 *   npx tsx scripts/inspect-app.ts <appId> --logic                # structure + logic questions
 *   npx tsx scripts/inspect-app.ts <appId> --case-lists           # structure + case list columns
 *   npx tsx scripts/inspect-app.ts <appId> --blueprint            # header + raw JSON only
 *   npx tsx scripts/inspect-app.ts <appId> --threads              # structure + thread content
 *   npx tsx scripts/inspect-app.ts <appId> --stats --case-lists   # combinable
 */
import {
	analyzeBlueprint,
	countQuestions,
	extractLogicQuestions,
} from "./lib/blueprint-stats";
import { db } from "./lib/firestore";
import {
	printHeader,
	printKV,
	printSection,
	printTable,
	truncate,
	tsToISO,
} from "./lib/format";
import type {
	AppBlueprint,
	BlueprintModule,
	ConfigEvent,
	Question,
} from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

const appId = process.argv[2];
const showQuestions = process.argv.includes("--questions");
const showThreads = process.argv.includes("--threads");
const showBlueprint = process.argv.includes("--blueprint");
const showStats = process.argv.includes("--stats");
const showCaseLists = process.argv.includes("--case-lists");
const showLogic = process.argv.includes("--logic");

if (!appId) {
	console.error(
		"Usage: npx tsx scripts/inspect-app.ts <appId> [--questions] [--threads] [--blueprint] [--stats] [--case-lists] [--logic]",
	);
	process.exit(1);
}

// ── Question tree printing ──────────────────────────────────────────

/** Print question tree with indentation (for --questions flag). */
function printQuestions(questions: Question[], indent = 0) {
	const pad = "  ".repeat(indent);
	for (const q of questions) {
		const label = truncate(q.label ?? "(no label)", 60);
		console.log(
			`${pad}  - [${q.type ?? "?"}] ${q.id ?? "?"} — "${label}" (${q.uuid?.slice(0, 8) ?? "no-uuid"})`,
		);
		if (q.children?.length) {
			printQuestions(q.children, indent + 1);
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
	const bp: AppBlueprint | undefined = data.blueprint;
	const modules: BlueprintModule[] = bp?.modules ?? [];
	const totalForms = modules.reduce(
		(sum, m) => sum + (m.forms?.length ?? 0),
		0,
	);
	const totalQuestions = modules.reduce(
		(sum, m) =>
			sum +
			(m.forms ?? []).reduce(
				(fSum, f) => fSum + countQuestions(f.questions ?? []),
				0,
			),
		0,
	);

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
		["Questions", String(totalQuestions)],
	]);

	/* ── Blueprint JSON dump (standalone mode) ───────────────────── */
	if (showBlueprint) {
		printSection("Full Blueprint JSON");
		console.log(JSON.stringify(bp, null, 2));
		/* --blueprint is standalone — skip structure view, stats, threads. */
		return;
	}

	/* ── Blueprint structure ──────────────────────────────────────── */
	printSection("Blueprint Structure");

	for (const [i, mod] of modules.entries()) {
		const modForms = mod.forms ?? [];
		const flags = [
			mod.case_type && `case: ${mod.case_type}`,
			mod.case_list_only && "case-list-only",
		]
			.filter(Boolean)
			.join(", ");

		console.log(
			`  Module ${i}: ${mod.name ?? "(unnamed)"}${flags ? ` (${flags})` : ""}`,
		);

		for (const [j, form] of modForms.entries()) {
			const qCount = countQuestions(form.questions ?? []);
			console.log(
				`    Form ${j}: ${form.name ?? "(unnamed)"} — ${qCount} questions`,
			);

			if (showQuestions && form.questions?.length) {
				printQuestions(form.questions, 3);
			}
		}
	}

	/* ── Stats view (--stats) ────────────────────────────────────── */
	if (showStats && bp) {
		const stats = analyzeBlueprint(bp);

		/* Question types breakdown. */
		printSection("Question Types");
		const typeEntries = Object.entries(stats.totals.questionTypes.byType).sort(
			(a, b) => b[1] - a[1],
		);
		printTable(
			[{ header: "Type" }, { header: "Count", align: "right" }],
			typeEntries.map(([type, count]) => [type, String(count)]),
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
				["Questions with logic", String(logic.questionsWithLogic)],
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
			const cols = mod.case_list_columns ?? [];
			const detailCols = mod.case_detail_columns ?? [];
			if (cols.length === 0 && detailCols.length === 0) continue;

			console.log(`  ${mod.name} (${mod.case_type ?? "no case type"}):`);
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

	/* ── Logic questions view (--logic) ──────────────────────────── */
	if (showLogic && bp) {
		const logicQs = extractLogicQuestions(bp);
		printSection(`Logic Questions (${logicQs.length} total)`);

		if (logicQs.length === 0) {
			console.log("  (no questions with logic elements)");
		} else {
			printTable(
				[{ header: "Path" }, { header: "Type" }, { header: "Elements" }],
				logicQs.map((lq) => [
					truncate(lq.path, 50),
					lq.type,
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
		/* Pre-fetch config events for all thread runs so we can show prompt mode.
		 * Config events have event.type = "config" — we filter client-side since
		 * Firestore can't query nested map fields efficiently. */
		const runIds = threads.docs.map((d) => d.data().run_id).filter(Boolean);
		const configByRun = new Map<string, ConfigEvent[]>();

		if (showThreads && runIds.length > 0) {
			const logSnap = await db
				.collection("apps")
				.doc(appId)
				.collection("logs")
				.where("run_id", "in", runIds.slice(0, 30))
				.orderBy("sequence", "asc")
				.get();

			for (const logDoc of logSnap.docs) {
				const stored = logDoc.data();
				if (stored.event?.type === "config") {
					const arr = configByRun.get(stored.run_id) ?? [];
					arr.push(stored.event as ConfigEvent);
					configByRun.set(stored.run_id, arr);
				}
			}
		}

		printSection("Chat Threads");

		for (const doc of threads.docs) {
			const t = doc.data();
			const msgCount = t.messages?.length ?? 0;
			console.log(
				`  Thread ${doc.id.slice(0, 8)}… (${t.thread_type}) — ${msgCount} messages`,
			);
			console.log(`    Created:  ${t.created_at}`);
			console.log(`    Summary:  ${truncate(t.summary ?? "", 100)}`);
			console.log(`    Run ID:   ${t.run_id}`);

			/* Show config events for this run — one per HTTP request. */
			const configs = configByRun.get(t.run_id);
			if (configs?.length) {
				for (let i = 0; i < configs.length; i++) {
					const c = configs[i];
					const label = configs.length > 1 ? ` (request ${i + 1})` : "";
					console.log(
						`    Config${label}: prompt=${c.prompt_mode} appReady=${c.app_ready} cacheExpired=${c.cache_expired} modules=${c.module_count}`,
					);
				}
			} else if (showThreads) {
				console.log("    Config:   (no config events found for this run)");
			}

			/* Full message content when --threads is active. */
			if (showThreads) {
				const messages = t.messages ?? [];
				for (const msg of messages) {
					console.log();
					console.log(`    [${msg.role}]`);
					for (const part of msg.parts ?? []) {
						if (part.type === "text") {
							/* Indent each line of text content for readability. */
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

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
