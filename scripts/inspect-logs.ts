/**
 * Read-only inspection of the Phase-4 event log for an app.
 *
 * Sources data from two collections:
 *   - `apps/{appId}/events/{eventId}` — the unified mutation + conversation
 *     stream (`Event`). Read via `readEvents(runId)` when filtered to a run,
 *     or via a direct `collections.events(appId)` scan otherwise.
 *   - `apps/{appId}/runs/{runId}` — per-run cost/behavior summary
 *     (`RunSummaryDoc`). Read via `readRunSummary`.
 *
 * Cost analytics live on the per-run summary — the event log intentionally
 * carries no token usage (spec §5: log is supplemental, mutation +
 * conversation only). Scripts that want cost breakdowns read the summary
 * doc directly.
 *
 * Never writes to Firestore.
 *
 * Usage:
 *   npx tsx scripts/inspect-logs.ts <appId>                  # summary + event counts
 *   npx tsx scripts/inspect-logs.ts <appId> --verbose         # full event detail
 *   npx tsx scripts/inspect-logs.ts <appId> --runs            # per-run summary table
 *   npx tsx scripts/inspect-logs.ts <appId> --timeline        # event timing gaps
 *   npx tsx scripts/inspect-logs.ts <appId> --tools           # tool-call distribution
 *   npx tsx scripts/inspect-logs.ts <appId> --stages          # mutations by stage
 *   npx tsx scripts/inspect-logs.ts <appId> --run=<runId>     # filter to a run
 *   npx tsx scripts/inspect-logs.ts <appId> --last=N          # last N events only
 */
import "dotenv/config";
import { collections } from "@/lib/db/firestore";
import type { RunSummaryDoc } from "@/lib/db/types";
import { readEvents, readRunSummary } from "@/lib/log/reader";
import {
	duration,
	pct,
	printHeader,
	printKV,
	printSection,
	printTable,
	tok,
	truncate,
	usd,
} from "./lib/format";
import {
	computeEventKindCounts,
	computeMutationsByStage,
	computeTimeline,
	computeToolUsage,
	groupByRun,
} from "./lib/log-stats";
import type { ConversationPayload, Event } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

const appId = process.argv[2];
if (!appId) {
	console.error(
		"Usage: npx tsx scripts/inspect-logs.ts <appId> [--verbose] [--runs] [--timeline] [--tools] [--stages] [--run=<runId>] [--last=N]",
	);
	process.exit(1);
}

const verbose = process.argv.includes("--verbose");
const showRunsTable = process.argv.includes("--runs");
const showTimeline = process.argv.includes("--timeline");
const showTools = process.argv.includes("--tools");
const showStages = process.argv.includes("--stages");
const runFilter = process.argv
	.find((a) => a.startsWith("--run="))
	?.split("=")[1];
const lastN = Number.parseInt(
	process.argv.find((a) => a.startsWith("--last="))?.split("=")[1] ?? "0",
	10,
);

/**
 * Any analytical view flag replaces the default per-run event dump. The
 * run summary header is always shown regardless.
 */
const hasAnalyticalView =
	showRunsTable || showTimeline || showTools || showStages;

// ── Data loading ────────────────────────────────────────────────────

/**
 * Load every event for the app. If `runFilter` is set, push the filter
 * into Firestore via `readEvents` (indexed on `runId`). Otherwise scan the
 * full events subcollection ordered by `(ts, seq)` so downstream grouping
 * preserves chronological order within each run.
 */
async function loadEvents(): Promise<Event[]> {
	if (runFilter) {
		return readEvents(appId, runFilter);
	}
	const snap = await collections
		.events(appId)
		.orderBy("ts")
		.orderBy("seq")
		.get();
	return snap.docs.map((d) => d.data());
}

// ── Event display ───────────────────────────────────────────────────

/**
 * Truncated timestamp (HH:MM:SS.mmm) for single-line event output. The
 * leading date portion is redundant inside a single run — all events share
 * the same day in practice, and the run header already shows full ISO.
 */
function formatTime(ts: number): string {
	return new Date(ts).toISOString().split("T")[1]?.slice(0, 12) ?? String(ts);
}

/** One-line summary of a conversation payload. */
function summarizeConversation(payload: ConversationPayload): string {
	switch (payload.type) {
		case "user-message":
			return `user: ${truncate(payload.text, 80)}`;
		case "assistant-text":
			return `assistant: ${truncate(payload.text, 80)}`;
		case "assistant-reasoning":
			return `reasoning: ${truncate(payload.text, 80)}`;
		case "tool-call":
			return `tool-call ${payload.toolName} (${payload.toolCallId.slice(0, 8)})`;
		case "tool-result":
			return `tool-result ${payload.toolName} (${payload.toolCallId.slice(0, 8)})`;
		case "error":
			return `error [${payload.error.type}]${payload.error.fatal ? " FATAL" : ""}: ${truncate(payload.error.message, 80)}`;
	}
}

/** Print a single event on one line. Used in the default and --last views. */
function printEventSummary(event: Event): void {
	const prefix = `  [seq=${String(event.seq).padStart(4)}] ${formatTime(event.ts)}`;
	if (event.kind === "mutation") {
		const stage = event.stage ? ` (${event.stage})` : "";
		/* Mutation discriminator is `kind` (see `mutationSchema` in lib/doc/types). */
		const mutationKind = event.mutation.kind;
		console.log(`${prefix}  [mutation:${event.actor}]${stage} ${mutationKind}`);
		return;
	}
	console.log(
		`${prefix}  [conversation] ${summarizeConversation(event.payload)}`,
	);
}

/** Multi-line verbose rendering of a single event. */
function printEventVerbose(event: Event): void {
	console.log(
		`\n  ┌─ seq=${event.seq} kind=${event.kind} ts=${new Date(event.ts).toISOString()}`,
	);

	if (event.kind === "mutation") {
		console.log(`  │ actor:    ${event.actor}`);
		if (event.stage) console.log(`  │ stage:    ${event.stage}`);
		console.log(`  │ mutation: ${event.mutation.kind}`);
		console.log(
			`  │ payload:  ${truncate(JSON.stringify(event.mutation), 300)}`,
		);
		console.log("  └─");
		return;
	}

	const p = event.payload;
	console.log(`  │ payload.type: ${p.type}`);
	switch (p.type) {
		case "user-message":
		case "assistant-text":
		case "assistant-reasoning":
			console.log(`  │ text: ${truncate(p.text, 400)}`);
			break;
		case "tool-call":
			console.log(`  │ toolCallId: ${p.toolCallId}`);
			console.log(`  │ toolName:   ${p.toolName}`);
			console.log(`  │ input:      ${truncate(JSON.stringify(p.input), 400)}`);
			break;
		case "tool-result":
			console.log(`  │ toolCallId: ${p.toolCallId}`);
			console.log(`  │ toolName:   ${p.toolName}`);
			console.log(`  │ output:     ${truncate(JSON.stringify(p.output), 400)}`);
			break;
		case "error":
			console.log(`  │ error.type:    ${p.error.type}`);
			console.log(`  │ error.fatal:   ${p.error.fatal}`);
			console.log(`  │ error.message: ${truncate(p.error.message, 400)}`);
			break;
	}
	console.log("  └─");
}

// ── Per-run summary rendering ───────────────────────────────────────

/**
 * Render the per-run summary doc as a KV block. This is the canonical
 * replacement for the old per-step cost table — all cost data lives here
 * now, keyed by runId.
 */
function printRunSummary(summary: RunSummaryDoc): void {
	const cacheHitRate = pct(summary.cacheReadTokens, summary.inputTokens);
	const durMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
	printKV([
		["Model", summary.model],
		["Prompt mode", summary.promptMode],
		["Fresh edit", String(summary.freshEdit)],
		["App ready", String(summary.appReady)],
		["Cache expired", String(summary.cacheExpired)],
		["Module count", String(summary.moduleCount)],
		["Started", summary.startedAt],
		["Finished", summary.finishedAt],
		["Duration", duration(durMs)],
		["Steps", String(summary.stepCount)],
		["Tool calls", String(summary.toolCallCount)],
		["Input tokens", tok(summary.inputTokens)],
		["Output tokens", tok(summary.outputTokens)],
		["Cache read", tok(summary.cacheReadTokens)],
		["Cache write", tok(summary.cacheWriteTokens)],
		["Cache hit rate", cacheHitRate],
		["Total cost", usd(summary.costEstimate)],
	]);
}

/** Event-kind distribution one-liner for the run header. */
function formatEventCounts(events: Event[]): string {
	const counts = computeEventKindCounts(events);
	const parts = [`${counts.total} events`, `mutations: ${counts.mutation}`];
	for (const [type, count] of Object.entries(counts.conversation)) {
		parts.push(`${type}: ${count}`);
	}
	return parts.join(" | ");
}

// ── Analytical views ────────────────────────────────────────────────

/**
 * Render the --runs per-run summary table. One row per run, sourced from
 * the `runs` subcollection (not the events collection). Runs without a
 * summary doc (e.g. migrated historical runs before summaries existed)
 * show "—" in cost/token columns.
 */
async function printRunsTableView(runIds: string[]): Promise<void> {
	printSection("Per-Run Summaries");

	const summaries = await Promise.all(
		runIds.map(async (runId) => {
			const summary = await readRunSummary(appId, runId);
			return { runId, summary };
		}),
	);

	printTable(
		[
			{ header: "Run" },
			{ header: "Mode" },
			{ header: "Model" },
			{ header: "Steps", align: "right" },
			{ header: "Tool calls", align: "right" },
			{ header: "Input", align: "right" },
			{ header: "Output", align: "right" },
			{ header: "Cache%", align: "right" },
			{ header: "Cost", align: "right" },
		],
		summaries.map(({ runId, summary }) => {
			if (!summary) {
				return [
					`${runId.slice(0, 8)}…`,
					"—",
					"—",
					"—",
					"—",
					"—",
					"—",
					"—",
					"—",
				];
			}
			return [
				`${runId.slice(0, 8)}…`,
				summary.promptMode,
				summary.model,
				String(summary.stepCount),
				String(summary.toolCallCount),
				tok(summary.inputTokens),
				tok(summary.outputTokens),
				pct(summary.cacheReadTokens, summary.inputTokens),
				usd(summary.costEstimate),
			];
		}),
	);
}

/** Render the --timeline inter-event gap table. */
function printTimelineView(events: Event[]): void {
	const timeline = computeTimeline(events);
	if (timeline.length === 0) {
		console.log("  (no events)");
		return;
	}

	printSection("Timeline");
	printTable(
		[{ header: "Time" }, { header: "Gap", align: "right" }, { header: "Kind" }],
		timeline.map((row) => [
			formatTime(row.ts),
			row.gapMs > 0 ? `${(row.gapMs / 1000).toFixed(2)}s` : "—",
			row.kind,
		]),
	);
}

/** Render the --tools tool-call distribution table. */
function printToolsView(events: Event[]): void {
	const tools = computeToolUsage(events);
	if (tools.length === 0) {
		console.log("  (no tool calls)");
		return;
	}

	printSection("Tool Usage");
	printTable(
		[{ header: "Tool" }, { header: "Calls", align: "right" }],
		tools.map((t) => [t.tool, String(t.calls)]),
	);
}

/** Render the --stages mutations-by-stage table. */
function printStagesView(events: Event[]): void {
	const stages = computeMutationsByStage(events);
	if (stages.length === 0) {
		console.log("  (no mutation events)");
		return;
	}

	printSection("Mutations by Stage");
	printTable(
		[{ header: "Stage" }, { header: "Mutations", align: "right" }],
		stages.map((s) => [s.stage, String(s.count)]),
	);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	const allEvents = await loadEvents();
	const trimmed = lastN > 0 ? allEvents.slice(-lastN) : allEvents;

	if (trimmed.length === 0) {
		printHeader("LOG INSPECTION (read-only)");
		console.log(
			`  App: ${appId}${runFilter ? ` (run=${runFilter})` : ""}\n  No events found.`,
		);
		return;
	}

	const runs = groupByRun(trimmed);
	const runIds = [...runs.keys()];

	printHeader("LOG INSPECTION (read-only)");
	/* Build the KV block incrementally so optional filter rows stay plain mutable
	 * tuples — `as const` would make them readonly and fail `printKV`'s signature. */
	const headerRows: Array<[string, string]> = [
		["App", appId],
		["Events", String(trimmed.length)],
		["Runs", String(runs.size)],
	];
	if (runFilter) headerRows.push(["Filter", `run=${runFilter}`]);
	if (lastN > 0) headerRows.push(["Filter", `last ${lastN} events`]);
	printKV(headerRows);

	/* --runs prints one table for all runs up front — no per-run event dump
	 * below, since the analytical-view flag is set. */
	if (showRunsTable) {
		await printRunsTableView(runIds);
	}

	/* Per-run section: summary doc + (optional) analytical views or event list. */
	for (const [runId, runEvents] of runs) {
		const summary = await readRunSummary(appId, runId);

		console.log(
			`\n── Run ${runId.slice(0, 8)}… ─────────────────────────────────────`,
		);
		console.log(`  ${formatEventCounts(runEvents)}`);

		if (summary) {
			console.log();
			printRunSummary(summary);
		} else {
			console.log("  (no run summary doc)");
		}

		if (showTimeline) printTimelineView(runEvents);
		if (showTools) printToolsView(runEvents);
		if (showStages) printStagesView(runEvents);

		/* Default view: dump every event unless an analytical-only view was
		 * requested. --runs is treated as analytical because the table up top
		 * already summarises every run. */
		if (!hasAnalyticalView) {
			console.log();
			for (const event of runEvents) {
				if (verbose) printEventVerbose(event);
				else printEventSummary(event);
			}
		}
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
