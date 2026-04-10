/**
 * Read-only inspection of an app document in Firestore.
 *
 * Shows app metadata, status, blueprint structure (modules/forms/questions),
 * and thread history. Never writes to Firestore.
 *
 * Usage:
 *   npx tsx scripts/inspect-app.ts <appId>
 *   npx tsx scripts/inspect-app.ts <appId> --questions   # include question-level detail
 *   npx tsx scripts/inspect-app.ts <appId> --threads     # full thread content + config events
 *   npx tsx scripts/inspect-app.ts <appId> --blueprint   # dump full blueprint JSON
 */
import { db, truncate, tsToISO } from "./lib/firestore";

const appId = process.argv[2];
const showQuestions = process.argv.includes("--questions");
const showThreads = process.argv.includes("--threads");
const showBlueprint = process.argv.includes("--blueprint");

if (!appId) {
	console.error(
		"Usage: npx tsx scripts/inspect-app.ts <appId> [--questions] [--threads] [--blueprint]",
	);
	process.exit(1);
}

/** Mirrors ConfigEvent from lib/db/types.ts — duplicated here to avoid
 *  importing app code from diagnostic scripts. */
interface ConfigEvent {
	type: "config";
	prompt_mode: string;
	fresh_edit: boolean;
	app_ready: boolean;
	cache_expired: boolean;
	module_count: number;
}

interface Question {
	id?: string;
	uuid?: string;
	type?: string;
	label?: string;
	children?: Question[];
}

interface Form {
	name?: string;
	questions?: Question[];
}

interface Module {
	name?: string;
	case_type?: string;
	case_list_only?: boolean;
	forms?: Form[];
}

/** Recursively count questions (including nested children in groups/repeats). */
function countQuestions(questions: Question[]): number {
	let count = 0;
	for (const q of questions) {
		count++;
		if (q.children?.length) {
			count += countQuestions(q.children);
		}
	}
	return count;
}

/** Print question tree with indentation. */
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

async function main() {
	/* ── App document ─────────────────────────────────────────────── */
	const snap = await db.collection("apps").doc(appId).get();
	if (!snap.exists) {
		console.error(`App ${appId} not found.`);
		process.exit(1);
	}

	// biome-ignore lint/style/noNonNullAssertion: guarded by snap.exists check above
	const data = snap.data()!;
	const bp = data.blueprint;
	const modules: Module[] = bp?.modules ?? [];
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

	console.log("╔══════════════════════════════════════════════════════════╗");
	console.log("║  APP INSPECTION (read-only)                             ║");
	console.log("╚══════════════════════════════════════════════════════════╝\n");

	console.log(`  App ID:       ${appId}`);
	console.log(`  App Name:     ${data.app_name}`);
	console.log(`  Owner:        ${data.owner}`);
	console.log(`  Status:       ${data.status}`);
	console.log(`  Error Type:   ${data.error_type ?? "(none)"}`);
	console.log(`  Run ID:       ${data.run_id ?? "(none)"}`);
	console.log(`  Connect Type: ${data.connect_type ?? "(none)"}`);
	console.log(`  Created:      ${tsToISO(data.created_at)}`);
	console.log(`  Updated:      ${tsToISO(data.updated_at)}`);
	console.log(`  Modules:      ${modules.length}`);
	console.log(`  Forms:        ${totalForms}`);
	console.log(`  Questions:    ${totalQuestions}`);

	/* ── Blueprint structure ──────────────────────────────────────── */
	console.log("\n── Blueprint Structure ──────────────────────────────────\n");

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

		console.log(
			"\n── Chat Threads ────────────────────────────────────────────\n",
		);

		for (const doc of threads.docs) {
			const t = doc.data();
			const msgCount = t.messages?.length ?? 0;
			console.log(
				`  Thread ${doc.id.slice(0, 8)}… (${t.thread_type}) — ${msgCount} messages`,
			);
			console.log(`    Created:  ${t.created_at}`);
			console.log(`    Summary:  ${truncate(t.summary ?? "", 100)}`);
			console.log(`    Run ID:   ${t.run_id}`);

			/* Show config events for this run — one per HTTP request */
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

			/* Full message content when --threads is active */
			if (showThreads) {
				const messages = t.messages ?? [];
				for (const msg of messages) {
					console.log();
					console.log(`    [${msg.role}]`);
					for (const part of msg.parts ?? []) {
						if (part.type === "text") {
							/* Indent each line of text content for readability */
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

	/* ── Full blueprint dump ──────────────────────────────────────── */
	if (showBlueprint) {
		console.log(
			"\n── Full Blueprint JSON ─────────────────────────────────────\n",
		);
		console.log(JSON.stringify(bp, null, 2));
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
