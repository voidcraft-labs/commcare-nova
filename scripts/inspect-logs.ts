/**
 * Read-only inspection of the event log for an app.
 *
 * Sources data from two tables:
 *   - `events` — the unified mutation + conversation stream (`Event`, in the
 *     `event` jsonb column). Read via `readEvents(runId)` when filtered to a
 *     run, or via a direct `events`-table scan otherwise.
 *   - `run_summaries` — per-run cost/behavior summary (`RunSummaryDoc`). Read
 *     via `readRunSummary`.
 *
 * Where cost data lives — read this before concluding "the log can't answer X":
 * the per-run summary carries the token TOTALS (input/output/cache read+write,
 * aggregate per run). The event log carries no token COUNTS, but it DOES carry
 * the full tool I/O — every `tool-result.output` verbatim — whose serialized
 * SIZE is the per-TOOL context-cost proxy. So "how many tokens did this run
 * cost" → the summary; "WHICH tool's results inflated it" → the event log
 * (`--tools` reports per-tool result sizes). Don't mistake "no token counts in
 * the log" for "no cost signal in the log."
 *
 * Reads the app-state database the env provides (`NOVA_DB_LOCAL_URL` locally,
 * the Cloud SQL connector in the migrate-job image). Never writes. Run with
 * `--help` for the flag reference.
 */
import "dotenv/config";
import { Command, InvalidArgumentError } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import type { RunSummaryDoc } from "@/lib/db/types";
import {
	decodeEventsLenient,
	readEvents,
	readRunSummary,
} from "@/lib/log/reader";
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
import { requireArg, runMain } from "./lib/main";
import type { ConversationPayload, Event } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

interface InspectLogsOptions {
	verbose?: boolean;
	runs?: boolean;
	timeline?: boolean;
	tools?: boolean;
	stages?: boolean;
	run?: string;
	last?: number;
}

/**
 * Commander coerces `--last=N` through this function. We enforce
 * "positive integer, no trailing junk" up-front so "--last=5abc" is
 * rejected rather than silently parsed as 5. Throwing
 * `InvalidArgumentError` makes commander print a clean error + usage hint
 * rather than leaking a stack trace.
 */
function parsePositiveInt(raw: string): number {
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw) {
		throw new InvalidArgumentError(`expected a positive integer, got "${raw}"`);
	}
	return parsed;
}

const program = new Command();
program
	.name("inspect-logs")
	.description(
		"Read-only inspection of the event log + per-run summary docs for an app.",
	)
	.argument("<appId>", "app id (apps.id)")
	.option(
		"--verbose",
		"multi-line rendering of every event (default: one-line)",
	)
	.option(
		"--runs",
		"show the per-run summary table (skips the event scan when used alone)",
	)
	.option("--timeline", "per-run event-time-gap table")
	.option("--tools", "per-run tool-call distribution")
	.option("--stages", "per-run mutations-by-stage counts")
	.option("--run <runId>", "only show events for this run")
	.option(
		"--last <n>",
		"trim the event stream to the last N events (positive integer)",
		parsePositiveInt,
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/inspect-logs.ts <appId>\n" +
			"  $ npx tsx scripts/inspect-logs.ts <appId> --runs\n" +
			"  $ npx tsx scripts/inspect-logs.ts <appId> --timeline --tools\n" +
			"  $ npx tsx scripts/inspect-logs.ts <appId> --run=<runId> --verbose\n" +
			"  $ npx tsx scripts/inspect-logs.ts <appId> --last=50\n",
	);

program.parse();

const appId = requireArg(program.args, 0, "appId");
const opts = program.opts<InspectLogsOptions>();

const verbose = opts.verbose === true;
const showRunsTable = opts.runs === true;
const showTimeline = opts.timeline === true;
const showTools = opts.tools === true;
const showStages = opts.stages === true;
/* `opts.run` already widens from `InspectLogsOptions`; no annotation needed.
 * `lastN` keeps its explicit `number` annotation because the ?? 0 collapses
 * `number | undefined` to `number`, and the annotation documents the coercion. */
const runFilter = opts.run;
const lastN: number = opts.last ?? 0;

/**
 * Any analytical view flag replaces the default per-run event dump. The
 * run summary header is always shown regardless.
 */
const hasAnalyticalView =
	showRunsTable || showTimeline || showTools || showStages;

/**
 * `--runs` is the only view that can render without touching the events
 * table at all — it reads `run_summaries` directly. Every other view
 * (including the default event dump) needs `Event[]`. When the user passes
 * *only* `--runs` (no events-consuming companion view, no `--run=` filter),
 * we skip the full-events scan entirely.
 */
const runsTableOnly =
	showRunsTable && !showTimeline && !showTools && !showStages && !runFilter;

// ── Data loading ────────────────────────────────────────────────────

/**
 * Load every event for the app. If `runFilter` is set, push the filter into
 * the query via `readEvents`. Otherwise scan the whole `events` table for the
 * app, ordered by `(ts, seq)` — the same chronological order `readEvents`
 * returns (the envelope `ts`/`seq` columns mirror the values inside the
 * `event` jsonb).
 */
async function loadEvents(): Promise<Event[]> {
	if (runFilter) {
		const { events, skipped } = await readEvents(appId, runFilter);
		if (skipped > 0) {
			console.warn(
				`Skipped ${skipped} unparseable event(s) (schema drift / forward-version payload).`,
			);
		}
		return events;
	}
	const db = await getAppDb();
	const rows = await db
		.selectFrom("events")
		.select("event")
		.where("app_id", "=", appId)
		.orderBy("ts")
		.orderBy("seq")
		.execute();
	// Drop-and-warn on any event that fails schema validation (forward-version
	// payload / schema drift) instead of letting one bad row abort the whole
	// scan — the failure that made this script crash on attachment-prep events.
	const { events, skipped, sample } = decodeEventsLenient(
		rows.map((row) => row.event),
	);
	if (skipped > 0) {
		console.warn(
			`Skipped ${skipped} unparseable event(s) (schema drift / forward-version payload). First: ${sample}`,
		);
	}
	return events;
}

/**
 * Load every run summary for the app, newest-first by `finished_at`. Sole
 * data source for the `--runs` fast path — no events are scanned. Runs that
 * logged events but never finalized (no `run_summaries` row) do not appear
 * here; the view reports what `run_summaries` contains.
 */
async function loadRunSummariesNewestFirst(): Promise<
	Array<{ runId: string; summary: RunSummaryDoc }>
> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("run_summaries")
		.select("run_id")
		.where("app_id", "=", appId)
		.orderBy("finished_at", "desc")
		.execute();
	// Re-read each row through `readRunSummary` so the canonical row→doc
	// mapping (snake_case columns → camelCase `RunSummaryDoc`) lives in ONE
	// place; `Promise.all` preserves the newest-first order.
	const summaries = await Promise.all(
		rows.map(async ({ run_id }) => ({
			runId: run_id,
			summary: await readRunSummary(appId, run_id),
		})),
	);
	return summaries.filter(
		(r): r is { runId: string; summary: RunSummaryDoc } => r.summary !== null,
	);
}

// ── Event display ───────────────────────────────────────────────────

/**
 * Truncated timestamp (HH:MM:SS.mmm) for single-line event output. The
 * leading date portion is redundant inside a single run — all events share
 * the same day in practice, and the run header already shows full ISO.
 *
 * `Date.prototype.toISOString()` is speced to always return the fixed-width
 * shape `YYYY-MM-DDTHH:MM:SS.sssZ`, so a direct character-index slice
 * (position 11 through 22) extracts `HH:MM:SS.mmm` without a fallback.
 */
function formatTime(ts: number): string {
	return new Date(ts).toISOString().slice(11, 23);
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
		case "validation-attempt":
			return `validation-attempt #${payload.attempt}: ${payload.errors.length} error${payload.errors.length === 1 ? "" : "s"}`;
		case "attachment-prep":
			return `attachment-prep ${payload.phase}${payload.count !== undefined ? ` (${payload.count} doc${payload.count === 1 ? "" : "s"})` : ""}`;
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
 *
 * Note on "Span": a runId spans every chat turn inside the same thread.
 * `finishedAt` advances to the most recent turn's finalize time, so the
 * value below is "first turn → last turn," NOT "wall-clock time the
 * agent spent generating." A thread that sits idle for hours between
 * two quick turns will show a large span with tiny `stepCount`.
 */
function printRunSummary(summary: RunSummaryDoc): void {
	const cacheHitRate = pct(summary.cacheReadTokens, summary.inputTokens);
	const spanMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
	printKV([
		["Model", summary.model],
		["Prompt mode", summary.promptMode],
		["Fresh edit", String(summary.freshEdit)],
		["App ready", String(summary.appReady)],
		["Cache expired", String(summary.cacheExpired)],
		["Module count", String(summary.moduleCount)],
		["First turn", summary.startedAt],
		["Last turn", summary.finishedAt],
		["Span", duration(spanMs)],
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
 * Render the `--runs` per-run summary table. Accepts pre-fetched
 * `{ runId, summary }` rows so callers can pick the data source that
 * matches their invocation path:
 *
 *   - `--runs` alone → the `runs` subcollection (newest-first, no events).
 *   - `--runs --timeline` / `--runs --tools` → merged with the event-derived
 *     runIds so event-only runs render as "—" rows alongside finalised ones.
 *
 * Rows with a `null` summary (no summary doc) render as a single runId
 * column plus dashes — they represent runs that logged events but never
 * called `UsageAccumulator.flush`.
 */
function printRunsTableView(
	rows: Array<{ runId: string; summary: RunSummaryDoc | null }>,
): void {
	printSection("Per-Run Summaries");

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
		rows.map(({ runId, summary }) => {
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

/**
 * Render the --tools view: per-tool call count AND result-output SIZE.
 *
 * Result size (the serialized `tool-result.output` length, shown as ~tokens =
 * bytes/4) is the per-tool proxy for context cost — a tool result re-rides the
 * agent's context on every subsequent step, so the tool with the biggest
 * `Max ~tok` / `Total out ~tok` is what inflates the cache read/write tokens
 * the run summary only reports in aggregate. Sorted biggest-payload-first.
 */
function printToolsView(events: Event[]): void {
	const tools = computeToolUsage(events);
	if (tools.length === 0) {
		console.log("  (no tool calls)");
		return;
	}

	/* Rough bytes-per-token ratio for the `~tok` display columns only — a
	 * back-of-envelope ≈4-bytes-per-token estimate to make output SIZES
	 * legible alongside the run summary's real token totals. Never used for
	 * billing or the cost backstop; the `~` in the headers flags it as approximate. */
	const BYTES_PER_TOKEN_ESTIMATE = 4;
	const estTok = (bytes: number) =>
		tok(Math.round(bytes / BYTES_PER_TOKEN_ESTIMATE));
	printSection(
		"Tool Usage — calls + result-output size (per-tool context-cost driver)",
	);
	printTable(
		[
			{ header: "Tool" },
			{ header: "Calls", align: "right" },
			{ header: "Results", align: "right" },
			{ header: "Total out ~tok", align: "right" },
			{ header: "Avg ~tok", align: "right" },
			{ header: "Max ~tok", align: "right" },
		],
		tools.map((t) => [
			t.tool,
			String(t.calls),
			String(t.results),
			estTok(t.totalOutputBytes),
			estTok(t.results > 0 ? t.totalOutputBytes / t.results : 0),
			estTok(t.maxOutputBytes),
		]),
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
	/* ── Fast path: only --runs was passed ─────────────────────────────
	 * Read the `runs` subcollection directly (newest-first by finishedAt)
	 * and render the summary table. Skips the full events scan that every
	 * other view path requires. */
	if (runsTableOnly) {
		const runRows = await loadRunSummariesNewestFirst();
		printHeader("LOG INSPECTION (read-only)");
		printKV([
			["App", appId],
			["Runs with summary", String(runRows.length)],
		]);
		if (runRows.length === 0) {
			console.log("\n  (no run summary docs — no runs have finalized yet)");
			return;
		}
		printRunsTableView(runRows);
		return;
	}

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
	/* Build the KV block incrementally so optional filter rows stay plain
	 * mutable tuples — `as const` would make them readonly and fail
	 * `printKV`'s signature. Labels are distinct per filter type so a
	 * combined `--run=x --last=N` invocation doesn't emit two "Filter" rows. */
	const headerRows: Array<[string, string]> = [
		["App", appId],
		["Events", String(trimmed.length)],
		["Runs", String(runs.size)],
	];
	if (runFilter) headerRows.push(["Run filter", runFilter]);
	if (lastN > 0) headerRows.push(["Last N", String(lastN)]);
	printKV(headerRows);

	/* Pre-fetch every per-run summary in parallel before entering the render
	 * loop. Serial `await`s inside the loop (one round-trip per run) turned
	 * 20 runs into 20 × network-latency seconds; `Promise.all` collapses
	 * that to one parallel burst. Lookups inside the render loop are then
	 * synchronous `Map.get` calls. */
	const summaryEntries = await Promise.all(
		runIds.map(async (runId) => {
			const summary = await readRunSummary(appId, runId);
			return [runId, summary] as const;
		}),
	);
	const summaryByRun = new Map(summaryEntries);

	/* --runs merges event-derived runIds with their summary docs (or `null`
	 * when a run never finalised). Analytical-only view — no per-run event
	 * dump below because the table up top already summarises every run. */
	if (showRunsTable) {
		const rows = runIds.map((runId) => ({
			runId,
			summary: summaryByRun.get(runId) ?? null,
		}));
		printRunsTableView(rows);
	}

	/* Per-run section: summary doc + (optional) analytical views or event list. */
	for (const [runId, runEvents] of runs) {
		const summary = summaryByRun.get(runId) ?? null;

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

// Close the shared case-store pool so the process exits promptly — an open
// pool keeps the event loop alive.
runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
