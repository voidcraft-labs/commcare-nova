/**
 * Side-by-side comparison of two generation runs.
 *
 * Two modes:
 *   - Cross-app: `inspect-compare.ts <appId1> <appId2>`
 *                Compares the most recent run of each app (resolved via
 *                `readLatestRunId`). Typical A/B: same prompt on two apps
 *                generated with different model or reasoning settings.
 *   - Same-app:  `inspect-compare.ts <appId> --runs=<runId1>,<runId2>`
 *                Compares two explicit runs of the same app — useful for
 *                initial-build vs edit, or for diffing two retries.
 *
 * Data sources per run:
 *   - `apps/{appId}/runs/{runId}` — `RunSummaryDoc` (cost + behavior).
 *     The source of truth for cost deltas.
 *   - `apps/{appId}/events/` filtered to `runId` — used for event-count
 *     and tool-usage deltas (the summary stores total tool calls but not
 *     per-tool breakdown).
 *
 * Read-only — never writes to Firestore.
 *
 * Usage:
 *   npx tsx scripts/inspect-compare.ts <appId1> <appId2>
 *   npx tsx scripts/inspect-compare.ts <appId> --runs=<runIdA>,<runIdB>
 */
import "dotenv/config";
import type { RunSummaryDoc } from "@/lib/db/types";
import { readEvents, readLatestRunId, readRunSummary } from "@/lib/log/reader";
import {
	duration,
	formatDelta,
	formatPctDelta,
	pct,
	printHeader,
	printSection,
	tok,
	usd,
} from "./lib/format";
import { computeEventKindCounts, computeToolUsage } from "./lib/log-stats";
import type { Event } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

/**
 * Resolve the positional args + flags into a well-typed comparison target.
 * One of two shapes:
 *   - cross-app:  two app IDs, each resolved to their latest run
 *   - same-app:   one app ID + `--runs=<a>,<b>` explicit run IDs
 */
type CompareTarget =
	| { mode: "cross-app"; appA: string; appB: string }
	| {
			mode: "same-app";
			appId: string;
			runIdA: string;
			runIdB: string;
	  };

function parseTarget(): CompareTarget {
	const args = process.argv.slice(2);
	const runsFlag = args.find((a) => a.startsWith("--runs="))?.split("=")[1];

	if (runsFlag) {
		const appId = args[0];
		if (!appId || appId.startsWith("--")) {
			console.error(
				"Usage: npx tsx scripts/inspect-compare.ts <appId> --runs=<runIdA>,<runIdB>",
			);
			process.exit(1);
		}
		const parts = runsFlag.split(",");
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			console.error(
				`Invalid --runs value "${runsFlag}". Expected "<runIdA>,<runIdB>".`,
			);
			process.exit(1);
		}
		return {
			mode: "same-app",
			appId,
			runIdA: parts[0],
			runIdB: parts[1],
		};
	}

	const appA = args[0];
	const appB = args[1];
	if (!appA || !appB || appA.startsWith("--") || appB.startsWith("--")) {
		console.error(
			"Usage:\n" +
				"  npx tsx scripts/inspect-compare.ts <appId1> <appId2>\n" +
				"  npx tsx scripts/inspect-compare.ts <appId> --runs=<runIdA>,<runIdB>",
		);
		process.exit(1);
	}
	return { mode: "cross-app", appA, appB };
}

const target = parseTarget();

// ── Run payload loading ─────────────────────────────────────────────

/**
 * The bundle of data fetched per comparison side. `summary` is `null`
 * when no summary doc exists (legacy runs predating Phase-4); the caller
 * prints "—" in affected rows so the comparison still renders.
 */
interface RunPayload {
	appId: string;
	runId: string;
	summary: RunSummaryDoc | null;
	events: Event[];
}

/**
 * Resolve the two comparison sides into concrete (appId, runId) pairs and
 * fetch each side's summary + events in parallel. For cross-app mode, the
 * "latest runId" lookup happens first — if either app has no events, the
 * script exits with a clear error.
 */
async function loadPayloads(): Promise<[RunPayload, RunPayload]> {
	if (target.mode === "same-app") {
		const { appId, runIdA, runIdB } = target;
		const [summaryA, summaryB, eventsA, eventsB] = await Promise.all([
			readRunSummary(appId, runIdA),
			readRunSummary(appId, runIdB),
			readEvents(appId, runIdA),
			readEvents(appId, runIdB),
		]);
		return [
			{ appId, runId: runIdA, summary: summaryA, events: eventsA },
			{ appId, runId: runIdB, summary: summaryB, events: eventsB },
		];
	}

	const { appA, appB } = target;
	const [runIdA, runIdB] = await Promise.all([
		readLatestRunId(appA),
		readLatestRunId(appB),
	]);
	if (!runIdA) {
		console.error(`App ${appA} has no events — nothing to compare.`);
		process.exit(1);
	}
	if (!runIdB) {
		console.error(`App ${appB} has no events — nothing to compare.`);
		process.exit(1);
	}

	const [summaryA, summaryB, eventsA, eventsB] = await Promise.all([
		readRunSummary(appA, runIdA),
		readRunSummary(appB, runIdB),
		readEvents(appA, runIdA),
		readEvents(appB, runIdB),
	]);
	return [
		{ appId: appA, runId: runIdA, summary: summaryA, events: eventsA },
		{ appId: appB, runId: runIdB, summary: summaryB, events: eventsB },
	];
}

// ── Comparison printing ─────────────────────────────────────────────

/* Column widths used by both the row renderer and the header separator.
 * Extracted so the `─` separator stays in sync with the rendered row width
 * automatically — previously the separator was a hardcoded 68/54 that
 * silently drifted if any column width changed. */
const LABEL_W = 22;
const COL_W = 16;
const DELTA_W = 12;
/* Rows are `label + valueA + valueB [+ gap + delta]`. The 2-char gap before
 * the delta column matches the `"  "` literal in `deltaPad` below. */
const ROW_WIDTH_WITH_DELTA = LABEL_W + COL_W * 2 + 2 + DELTA_W;
const ROW_WIDTH_WITHOUT_DELTA = LABEL_W + COL_W * 2;

/**
 * Print a side-by-side row: label + two values + optional delta. Widths
 * are fixed so rows align vertically across sections without recomputing.
 */
function printCompRow(
	label: string,
	valueA: string,
	valueB: string,
	delta?: string,
): void {
	const labelPad = label.padEnd(LABEL_W);
	const aPad = valueA.padStart(COL_W);
	const bPad = valueB.padStart(COL_W);
	const deltaPad = delta !== undefined ? `  ${delta.padStart(DELTA_W)}` : "";
	console.log(`  ${labelPad}${aPad}${bPad}${deltaPad}`);
}

/** Column header row + separator for a comparison block. */
function printCompHeader(labelA: string, labelB: string, showDelta = true) {
	const labelPad = "".padEnd(LABEL_W);
	const aLabel = labelA.padStart(COL_W);
	const bLabel = labelB.padStart(COL_W);
	const deltaLabel = showDelta ? `  ${"Delta".padStart(DELTA_W)}` : "";
	console.log(`  ${labelPad}${aLabel}${bLabel}${deltaLabel}`);
	const width = showDelta ? ROW_WIDTH_WITH_DELTA : ROW_WIDTH_WITHOUT_DELTA;
	console.log(`  ${"─".repeat(width)}`);
}

/**
 * Compare two numeric summary fields by pulling them through a formatter.
 * Emits "(no summary)" on either side when the corresponding run summary
 * is missing — delta is omitted since there's nothing to subtract.
 */
function compareNumericField(
	label: string,
	a: RunSummaryDoc | null,
	b: RunSummaryDoc | null,
	pick: (s: RunSummaryDoc) => number,
	format: (n: number) => string,
): void {
	if (!a || !b) {
		printCompRow(label, a ? format(pick(a)) : "—", b ? format(pick(b)) : "—");
		return;
	}
	const valA = pick(a);
	const valB = pick(b);
	printCompRow(
		label,
		format(valA),
		format(valB),
		formatDelta(valA, valB, format),
	);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	const [sideA, sideB] = await loadPayloads();

	const labelA =
		target.mode === "cross-app"
			? `${sideA.appId.slice(0, 8)}…`
			: `run ${sideA.runId.slice(0, 8)}…`;
	const labelB =
		target.mode === "cross-app"
			? `${sideB.appId.slice(0, 8)}…`
			: `run ${sideB.runId.slice(0, 8)}…`;

	printHeader("RUN COMPARISON (read-only)");

	/* ── Identity header ─────────────────────────────────────────── */
	printSection("Identity");
	printCompHeader("A", "B", false);
	printCompRow("App ID", sideA.appId, sideB.appId);
	printCompRow("Run ID", sideA.runId, sideB.runId);
	printCompRow(
		"Has summary",
		sideA.summary ? "yes" : "no",
		sideB.summary ? "yes" : "no",
	);

	const sumA = sideA.summary;
	const sumB = sideB.summary;

	/* ── Run config ──────────────────────────────────────────────── */
	if (sumA || sumB) {
		printSection("Config");
		printCompHeader(labelA, labelB, false);
		printCompRow("Model", sumA?.model ?? "—", sumB?.model ?? "—");
		printCompRow(
			"Prompt mode",
			sumA?.promptMode ?? "—",
			sumB?.promptMode ?? "—",
		);
		printCompRow(
			"Fresh edit",
			sumA ? String(sumA.freshEdit) : "—",
			sumB ? String(sumB.freshEdit) : "—",
		);
		printCompRow(
			"App ready",
			sumA ? String(sumA.appReady) : "—",
			sumB ? String(sumB.appReady) : "—",
		);
		printCompRow(
			"Cache expired",
			sumA ? String(sumA.cacheExpired) : "—",
			sumB ? String(sumB.cacheExpired) : "—",
		);
		printCompRow(
			"Module count (in)",
			sumA ? String(sumA.moduleCount) : "—",
			sumB ? String(sumB.moduleCount) : "—",
		);
	}

	/* ── Cost / tokens ───────────────────────────────────────────── */
	if (sumA || sumB) {
		printSection("Cost & Tokens");
		printCompHeader(labelA, labelB);
		compareNumericField("Total cost", sumA, sumB, (s) => s.costEstimate, usd);
		compareNumericField("Input tokens", sumA, sumB, (s) => s.inputTokens, tok);
		compareNumericField(
			"Output tokens",
			sumA,
			sumB,
			(s) => s.outputTokens,
			tok,
		);
		compareNumericField(
			"Cache read",
			sumA,
			sumB,
			(s) => s.cacheReadTokens,
			tok,
		);
		compareNumericField(
			"Cache write",
			sumA,
			sumB,
			(s) => s.cacheWriteTokens,
			tok,
		);

		/* Cache hit rate is derived; formatPctDelta returns percentage points. */
		const cacheA = sumA
			? (sumA.cacheReadTokens / Math.max(1, sumA.inputTokens)) * 100
			: Number.NaN;
		const cacheB = sumB
			? (sumB.cacheReadTokens / Math.max(1, sumB.inputTokens)) * 100
			: Number.NaN;
		const cacheAStr = sumA ? pct(sumA.cacheReadTokens, sumA.inputTokens) : "—";
		const cacheBStr = sumB ? pct(sumB.cacheReadTokens, sumB.inputTokens) : "—";
		const cacheDelta =
			sumA && sumB ? formatPctDelta(cacheA, cacheB) : undefined;
		printCompRow("Cache hit rate", cacheAStr, cacheBStr, cacheDelta);

		/* Duration is derived from ISO strings on the summary. */
		const durA = sumA
			? Date.parse(sumA.finishedAt) - Date.parse(sumA.startedAt)
			: Number.NaN;
		const durB = sumB
			? Date.parse(sumB.finishedAt) - Date.parse(sumB.startedAt)
			: Number.NaN;
		/* `formatDelta` already passes `Math.abs(diff)` to the formatter and
		 * prepends the sign itself — the `duration` formatter receives a
		 * non-negative ms value and the sign rides on the output prefix
		 * (e.g. "+30s" vs "−30s"). Do NOT re-absolutize inside the lambda:
		 * that was load-bearing-looking noise that suggested a sign bug. */
		printCompRow(
			"Duration",
			sumA ? duration(durA) : "—",
			sumB ? duration(durB) : "—",
			sumA && sumB ? formatDelta(durA, durB, duration) : undefined,
		);
	}

	/* ── Agent behavior ─────────────────────────────────────────── */
	if (sumA || sumB) {
		printSection("Agent Behavior");
		printCompHeader(labelA, labelB);
		compareNumericField("Steps", sumA, sumB, (s) => s.stepCount, String);
		compareNumericField(
			"Tool calls",
			sumA,
			sumB,
			(s) => s.toolCallCount,
			String,
		);
	}

	/* ── Event counts ───────────────────────────────────────────── */
	printSection("Event Counts");
	printCompHeader(labelA, labelB);

	const kindA = computeEventKindCounts(sideA.events);
	const kindB = computeEventKindCounts(sideB.events);

	printCompRow(
		"Total events",
		String(kindA.total),
		String(kindB.total),
		formatDelta(kindA.total, kindB.total),
	);
	printCompRow(
		"Mutation events",
		String(kindA.mutation),
		String(kindB.mutation),
		formatDelta(kindA.mutation, kindB.mutation),
	);

	/* Conversation payload types union. */
	const allConvTypes = new Set([
		...Object.keys(kindA.conversation),
		...Object.keys(kindB.conversation),
	]);
	for (const type of allConvTypes) {
		const a = kindA.conversation[type] ?? 0;
		const b = kindB.conversation[type] ?? 0;
		printCompRow(`  ${type}`, String(a), String(b), formatDelta(a, b));
	}

	/* ── Tool usage ─────────────────────────────────────────────── */
	const toolsA = computeToolUsage(sideA.events);
	const toolsB = computeToolUsage(sideB.events);

	if (toolsA.length > 0 || toolsB.length > 0) {
		printSection("Tool Usage");
		printCompHeader(labelA, labelB);

		const toolMapA = new Map(toolsA.map((t) => [t.tool, t.calls]));
		const toolMapB = new Map(toolsB.map((t) => [t.tool, t.calls]));
		const allTools = new Set([...toolMapA.keys(), ...toolMapB.keys()]);

		/* Sort by combined call volume so the heaviest rows surface first. */
		const sortedTools = [...allTools].sort((x, y) => {
			const totalX = (toolMapA.get(x) ?? 0) + (toolMapB.get(x) ?? 0);
			const totalY = (toolMapA.get(y) ?? 0) + (toolMapB.get(y) ?? 0);
			return totalY - totalX;
		});

		for (const tool of sortedTools) {
			const a = toolMapA.get(tool) ?? 0;
			const b = toolMapB.get(tool) ?? 0;
			printCompRow(tool, String(a), String(b), formatDelta(a, b));
		}
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
