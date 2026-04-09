/**
 * Read-only inspection of event logs for an app.
 *
 * Shows all events grouped by run_id, with filtering by event type and run.
 * Useful for diagnosing generation failures, understanding cost, and tracing
 * edit-mode errors. Never writes to Firestore.
 *
 * Usage:
 *   npx tsx scripts/inspect-logs.ts <appId>                  # all events, summary view
 *   npx tsx scripts/inspect-logs.ts <appId> --verbose         # full event detail
 *   npx tsx scripts/inspect-logs.ts <appId> --type=error      # only error events
 *   npx tsx scripts/inspect-logs.ts <appId> --type=step       # only step events
 *   npx tsx scripts/inspect-logs.ts <appId> --run=<runId>     # filter to specific run
 *   npx tsx scripts/inspect-logs.ts <appId> --cost            # cost breakdown per run
 *   npx tsx scripts/inspect-logs.ts <appId> --last=20         # last N events only
 */
import { db, tok, truncate } from "./lib/firestore";

const appId = process.argv[2];
if (!appId) {
	console.error(
		"Usage: npx tsx scripts/inspect-logs.ts <appId> [--verbose] [--type=<type>] [--run=<runId>] [--cost] [--last=N]",
	);
	process.exit(1);
}

const verbose = process.argv.includes("--verbose");
const costOnly = process.argv.includes("--cost");
const typeFilter = process.argv
	.find((a) => a.startsWith("--type="))
	?.split("=")[1];
const runFilter = process.argv
	.find((a) => a.startsWith("--run="))
	?.split("=")[1];
const lastN = Number.parseInt(
	process.argv.find((a) => a.startsWith("--last="))?.split("=")[1] ?? "0",
	10,
);

interface TokenUsage {
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost: number;
}

interface ToolCall {
	name: string;
	args: unknown;
	output: unknown;
	generation: TokenUsage | null;
	reasoning: string;
}

interface LogEvent {
	type: string;
	/* Step fields */
	step_index?: number;
	text?: string;
	reasoning?: string;
	tool_calls?: ToolCall[];
	usage?: TokenUsage;
	/* Emission fields */
	emission_type?: string;
	emission_data?: unknown;
	/* Error fields */
	error_type?: string;
	error_message?: string;
	error_raw?: string;
	error_fatal?: boolean;
	error_context?: string;
	/* Message fields */
	id?: string;
}

interface StoredEvent {
	run_id: string;
	sequence: number;
	request: number;
	timestamp: string;
	event: LogEvent;
}

/** Format a cost value as USD string. */
function usd(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

/** Print a single event in summary mode. */
function printEventSummary(e: StoredEvent) {
	const evt = e.event;
	const ts = e.timestamp.split("T")[1]?.slice(0, 12) ?? e.timestamp;
	const prefix = `  [seq=${String(e.sequence).padStart(3)} req=${e.request}] ${ts}`;

	switch (evt.type) {
		case "message":
			console.log(`${prefix}  📨 message: ${truncate(evt.text ?? "", 80)}`);
			break;

		case "step": {
			const tools =
				evt.tool_calls?.map((t) => t.name).join(", ") || "(no tools)";
			const cost = evt.usage ? ` ${usd(evt.usage.cost)}` : "";
			const text = evt.text ? ` — ${truncate(evt.text, 60)}` : "";
			console.log(
				`${prefix}  🔧 step ${evt.step_index}: [${tools}]${cost}${text}`,
			);
			break;
		}

		case "emission":
			console.log(
				`${prefix}  📡 emission: ${evt.emission_type} (step ${evt.step_index})`,
			);
			break;

		case "error":
			console.log(
				`${prefix}  ❌ ERROR [${evt.error_type}]: ${truncate(evt.error_message ?? "", 80)}`,
			);
			if (evt.error_context) {
				console.log(`           context: ${evt.error_context}`);
			}
			break;

		default:
			console.log(`${prefix}  ❓ unknown type: ${evt.type}`);
	}
}

/** Print a single event in verbose mode. */
function printEventVerbose(e: StoredEvent) {
	const evt = e.event;
	console.log(
		`\n  ┌─ seq=${e.sequence} req=${e.request} type=${evt.type} @ ${e.timestamp}`,
	);

	switch (evt.type) {
		case "message":
			console.log(`  │ text: ${evt.text}`);
			break;

		case "step": {
			if (evt.reasoning) {
				console.log(`  │ reasoning: ${truncate(evt.reasoning, 200)}`);
			}
			if (evt.text) {
				console.log(`  │ text: ${truncate(evt.text, 200)}`);
			}
			if (evt.usage) {
				const u = evt.usage;
				console.log(
					`  │ usage: ${tok(u.input_tokens)} in / ${tok(u.output_tokens)} out / ${tok(u.cache_read_tokens)} cached / ${usd(u.cost)}`,
				);
			}
			for (const tc of evt.tool_calls ?? []) {
				console.log(`  │ tool: ${tc.name}`);
				console.log(`  │   args: ${truncate(JSON.stringify(tc.args), 200)}`);
				const output = JSON.stringify(tc.output);
				console.log(`  │   output: ${truncate(output ?? "null", 200)}`);
				if (tc.generation) {
					console.log(
						`  │   inner-llm: ${tok(tc.generation.input_tokens)} in / ${tok(tc.generation.output_tokens)} out / ${usd(tc.generation.cost)}`,
					);
				}
				if (tc.reasoning) {
					console.log(`  │   reasoning: ${truncate(tc.reasoning, 200)}`);
				}
			}
			break;
		}

		case "emission":
			console.log(`  │ emission_type: ${evt.emission_type}`);
			console.log(
				`  │ data: ${truncate(JSON.stringify(evt.emission_data) ?? "", 300)}`,
			);
			break;

		case "error":
			console.log(`  │ error_type: ${evt.error_type}`);
			console.log(`  │ message: ${evt.error_message}`);
			console.log(`  │ fatal: ${evt.error_fatal}`);
			console.log(`  │ context: ${evt.error_context}`);
			if (evt.error_raw) {
				console.log(`  │ raw: ${truncate(evt.error_raw, 500)}`);
			}
			break;
	}

	console.log("  └─");
}

/** Print cost breakdown for a set of events. */
function printCostBreakdown(events: StoredEvent[]) {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let stepCount = 0;

	/* Also track inner tool LLM calls separately */
	let innerInput = 0;
	let innerOutput = 0;
	let innerCost = 0;

	for (const e of events) {
		if (e.event.type !== "step") continue;
		stepCount++;
		const u = e.event.usage;
		if (u) {
			totalInput += u.input_tokens;
			totalOutput += u.output_tokens;
			totalCacheRead += u.cache_read_tokens;
			totalCacheWrite += u.cache_write_tokens;
			totalCost += u.cost;
		}
		for (const tc of e.event.tool_calls ?? []) {
			if (tc.generation) {
				innerInput += tc.generation.input_tokens;
				innerOutput += tc.generation.output_tokens;
				innerCost += tc.generation.cost;
			}
		}
	}

	console.log(`    Steps:          ${stepCount}`);
	console.log(`    Agent input:    ${tok(totalInput)} tokens`);
	console.log(`    Agent output:   ${tok(totalOutput)} tokens`);
	console.log(`    Cache reads:    ${tok(totalCacheRead)} tokens`);
	console.log(`    Cache writes:   ${tok(totalCacheWrite)} tokens`);
	console.log(`    Agent cost:     ${usd(totalCost)}`);
	if (innerCost > 0) {
		console.log(`    Tool LLM in:    ${tok(innerInput)} tokens`);
		console.log(`    Tool LLM out:   ${tok(innerOutput)} tokens`);
		console.log(`    Tool LLM cost:  ${usd(innerCost)}`);
	}
	console.log(`    TOTAL cost:     ${usd(totalCost + innerCost)}`);
}

async function main() {
	/* Fetch log events — push filters into the Firestore query where possible
	 * to reduce read costs on production data. */
	let query: FirebaseFirestore.Query = db
		.collection("apps")
		.doc(appId)
		.collection("logs")
		.orderBy("sequence", "asc");

	/* run_id is a top-level field, so it can be a Firestore where() clause. */
	if (runFilter) {
		query = query.where("run_id", "==", runFilter);
	}

	const snap = await query.get();

	if (snap.empty) {
		console.log(`No log events found for app ${appId}.`);
		return;
	}

	let events: StoredEvent[] = snap.docs.map((d) => d.data() as StoredEvent);

	/* event.type is nested inside the event map — must filter client-side. */
	if (typeFilter) {
		events = events.filter((e) => e.event.type === typeFilter);
	}
	if (lastN > 0) {
		events = events.slice(-lastN);
	}

	/* Group by run_id */
	const runs = new Map<string, StoredEvent[]>();
	for (const e of events) {
		const group = runs.get(e.run_id) ?? [];
		group.push(e);
		runs.set(e.run_id, group);
	}

	console.log("╔══════════════════════════════════════════════════════════╗");
	console.log("║  LOG INSPECTION (read-only)                             ║");
	console.log("╚══════════════════════════════════════════════════════════╝\n");

	console.log(
		`  App:    ${appId}\n  Events: ${events.length} total across ${runs.size} run(s)\n`,
	);
	if (typeFilter) console.log(`  Filter: type=${typeFilter}`);
	if (runFilter) console.log(`  Filter: run=${runFilter}`);
	if (lastN) console.log(`  Filter: last ${lastN} events`);

	for (const [runId, runEvents] of runs) {
		const types = new Map<string, number>();
		for (const e of runEvents) {
			types.set(e.event.type, (types.get(e.event.type) ?? 0) + 1);
		}
		const typeSummary = [...types.entries()]
			.map(([t, c]) => `${t}:${c}`)
			.join(" ");
		const timeRange = `${runEvents[0].timestamp.split("T")[1]?.slice(0, 8)} → ${runEvents[runEvents.length - 1].timestamp.split("T")[1]?.slice(0, 8)}`;
		const hasError = runEvents.some((e) => e.event.type === "error");

		console.log(
			`\n── Run ${runId.slice(0, 8)}… ${hasError ? "❌" : "✓"} ──────────────────────────────`,
		);
		console.log(`  ${runEvents.length} events (${typeSummary}) | ${timeRange}`);

		if (costOnly) {
			printCostBreakdown(runEvents);
		} else {
			console.log();
			for (const e of runEvents) {
				if (verbose) {
					printEventVerbose(e);
				} else {
					printEventSummary(e);
				}
			}
		}
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
