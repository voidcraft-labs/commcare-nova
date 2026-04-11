/**
 * Read-only inspection of event logs for an app.
 *
 * Shows all events grouped by run_id, with filtering by event type and run.
 * Cost summary is always shown in the run header. Analytical views (--steps,
 * --timeline, --tools) replace the default event list for focused analysis.
 * Never writes to Firestore.
 *
 * Usage:
 *   npx tsx scripts/inspect-logs.ts <appId>                  # events + cost in header
 *   npx tsx scripts/inspect-logs.ts <appId> --verbose         # full event detail
 *   npx tsx scripts/inspect-logs.ts <appId> --steps           # per-step breakdown table
 *   npx tsx scripts/inspect-logs.ts <appId> --timeline        # step timing analysis
 *   npx tsx scripts/inspect-logs.ts <appId> --tools           # tool usage distribution
 *   npx tsx scripts/inspect-logs.ts <appId> --steps --tools   # combinable
 *   npx tsx scripts/inspect-logs.ts <appId> --type=error      # only error events
 *   npx tsx scripts/inspect-logs.ts <appId> --type=step       # only step events
 *   npx tsx scripts/inspect-logs.ts <appId> --run=<runId>     # filter to specific run
 *   npx tsx scripts/inspect-logs.ts <appId> --last=20         # last N events only
 */
import { db } from "./lib/firestore";
import {
	duration,
	pct,
	printHeader,
	printSection,
	printTable,
	tok,
	truncate,
	usd,
} from "./lib/format";
import {
	analyzeRun,
	computeStepBreakdown,
	computeTimeline,
	computeToolUsage,
	groupByRun,
} from "./lib/log-stats";
import type { StoredEvent } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

const appId = process.argv[2];
if (!appId) {
	console.error(
		"Usage: npx tsx scripts/inspect-logs.ts <appId> [--verbose] [--steps] [--timeline] [--tools] [--type=<type>] [--run=<runId>] [--last=N]",
	);
	process.exit(1);
}

const verbose = process.argv.includes("--verbose");
const showSteps = process.argv.includes("--steps");
const showTimeline = process.argv.includes("--timeline");
const showTools = process.argv.includes("--tools");
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

/** Whether any analytical view was requested (replaces default event list). */
const hasAnalyticalView = showSteps || showTimeline || showTools;

// ── Event display ───────────────────────────────────────────────────

/** Print a single event in summary mode (one-line-per-event). */
function printEventSummary(e: StoredEvent) {
	const evt = e.event;
	const ts = e.timestamp.split("T")[1]?.slice(0, 12) ?? e.timestamp;
	const prefix = `  [seq=${String(e.sequence).padStart(3)} req=${e.request}] ${ts}`;

	switch (evt.type) {
		case "config":
			console.log(
				`${prefix}  ⚙️  config: prompt=${evt.prompt_mode} freshEdit=${evt.fresh_edit} appReady=${evt.app_ready} cacheExpired=${evt.cache_expired} modules=${evt.module_count}`,
			);
			break;

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
			console.log(
				`${prefix}  ❓ unknown type: ${(evt as { type: string }).type}`,
			);
	}
}

/** Print a single event in verbose mode (multi-line detail). */
function printEventVerbose(e: StoredEvent) {
	const evt = e.event;
	console.log(
		`\n  ┌─ seq=${e.sequence} req=${e.request} type=${evt.type} @ ${e.timestamp}`,
	);

	switch (evt.type) {
		case "config":
			console.log(`  │ prompt_mode: ${evt.prompt_mode}`);
			console.log(`  │ fresh_edit:  ${evt.fresh_edit}`);
			console.log(`  │ app_ready:   ${evt.app_ready}`);
			console.log(`  │ cache_expired: ${evt.cache_expired}`);
			console.log(`  │ module_count: ${evt.module_count}`);
			break;

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

// ── Analytical views ────────────────────────────────────────────────

/** Print the --steps per-step breakdown table. */
function printStepsView(events: StoredEvent[]) {
	const steps = computeStepBreakdown(events);
	if (steps.length === 0) {
		console.log("  (no steps)");
		return;
	}

	printSection("Per-Step Breakdown");

	printTable(
		[
			{ header: "Step", align: "right" },
			{ header: "Tools" },
			{ header: "Input", align: "right" },
			{ header: "Output", align: "right" },
			{ header: "Cache%", align: "right" },
			{ header: "Cost", align: "right" },
			{ header: "Reasoning" },
		],
		steps.map((s) => [
			String(s.stepIndex),
			s.tools.join(", ") || "(none)",
			tok(s.inputTokens),
			tok(s.outputTokens),
			pct(s.cacheReadTokens, s.inputTokens),
			usd(s.totalCost),
			truncate(s.reasoningSnippet || s.textSnippet, 50),
		]),
	);
}

/** Print the --timeline step timing table. */
function printTimelineView(events: StoredEvent[]) {
	const timeline = computeTimeline(events);
	if (timeline.length === 0) {
		console.log("  (no steps)");
		return;
	}

	printSection("Step Timeline");

	printTable(
		[
			{ header: "Step", align: "right" },
			{ header: "Time" },
			{ header: "Delta", align: "right" },
			{ header: "Tools" },
			{ header: "Cost", align: "right" },
		],
		timeline.map((t) => [
			String(t.stepIndex),
			t.timestamp.split("T")[1]?.slice(0, 12) ?? t.timestamp,
			t.deltaMs > 0 ? `${(t.deltaMs / 1000).toFixed(1)}s` : "—",
			t.tools.join(", ") || "(none)",
			usd(t.cost),
		]),
	);
}

/** Print the --tools tool usage distribution table. */
function printToolsView(events: StoredEvent[]) {
	const tools = computeToolUsage(events);
	if (tools.length === 0) {
		console.log("  (no tool calls)");
		return;
	}

	printSection("Tool Usage");

	printTable(
		[
			{ header: "Tool" },
			{ header: "Calls", align: "right" },
			{ header: "Inner LLM", align: "right" },
		],
		tools.map((t) => [
			t.name,
			String(t.callCount),
			t.innerLLMCost > 0 ? usd(t.innerLLMCost) : "—",
		]),
	);
}

// ── Main ────────────────────────────────────────────────────────────

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

	/* Group by run_id. */
	const runs = groupByRun(events);

	printHeader("LOG INSPECTION (read-only)");

	console.log(
		`  App:    ${appId}\n  Events: ${events.length} total across ${runs.size} run(s)\n`,
	);
	if (typeFilter) console.log(`  Filter: type=${typeFilter}`);
	if (runFilter) console.log(`  Filter: run=${runFilter}`);
	if (lastN) console.log(`  Filter: last ${lastN} events`);

	for (const [runId, runEvents] of runs) {
		/* Run header — always includes cost summary. */
		const analysis = analyzeRun(runId, runEvents);
		const typeSummary = Object.entries(analysis.eventTypes)
			.map(([t, c]) => `${t}:${c}`)
			.join(" ");
		const start = analysis.timeRange.start.split("T")[1]?.slice(0, 8) ?? "";
		const end = analysis.timeRange.end.split("T")[1]?.slice(0, 8) ?? "";

		console.log(
			`\n── Run ${runId.slice(0, 8)}… ${analysis.hasError ? "❌" : "✓"} ──────────────────────────────`,
		);
		console.log(
			`  ${analysis.eventCount} events (${typeSummary}) | ${start} → ${end}`,
		);

		/* Cost summary is always shown — this was the --cost bug fix. */
		const c = analysis.cost;
		console.log(
			`    Steps: ${c.stepCount}  |  Duration: ${duration(analysis.durationMs)}  |  Input: ${tok(c.agentInputTokens)}  |  Output: ${tok(c.agentOutputTokens)}  |  Cache: ${pct(c.cacheReadTokens, c.agentInputTokens)}  |  Cost: ${usd(c.totalCost)}`,
		);
		if (c.toolLLM.cost > 0) {
			console.log(
				`    Tool LLM: ${tok(c.toolLLM.inputTokens)} in / ${tok(c.toolLLM.outputTokens)} out / ${usd(c.toolLLM.cost)}`,
			);
		}

		/* Analytical views replace the event list when requested. */
		if (showSteps) printStepsView(runEvents);
		if (showTimeline) printTimelineView(runEvents);
		if (showTools) printToolsView(runEvents);

		/* Default: show event list when no analytical view was requested. */
		if (!hasAnalyticalView) {
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
