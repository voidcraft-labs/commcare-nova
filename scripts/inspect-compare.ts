/**
 * Side-by-side comparison of two app builds.
 *
 * Fetches both app documents and their log events from Firestore in
 * parallel, computes blueprint stats and run analysis for each, then
 * prints a structured comparison. Read-only — never writes to Firestore.
 *
 * Designed for A/B comparisons: same prompt with different models,
 * reasoning levels, or prompt versions. Surfaces differences in cost,
 * structure, quality metrics, and agent behavior.
 *
 * Usage:
 *   npx tsx scripts/inspect-compare.ts <appId1> <appId2>                  # compare build runs (default)
 *   npx tsx scripts/inspect-compare.ts <appId1> <appId2> --run=latest     # compare most recent run (may be edit)
 *   npx tsx scripts/inspect-compare.ts <appId1> <appId2> --run=<runId>    # compare specific run IDs (comma-separated)
 *   npx tsx scripts/inspect-compare.ts <appId1> <appId2> --verbose        # + per-module form-by-form detail
 */

import { analyzeBlueprint, type BlueprintStats } from "./lib/blueprint-stats";
import { db } from "./lib/firestore";
import {
	duration,
	formatDelta,
	formatPctDelta,
	pct,
	printHeader,
	printSection,
	tok,
	truncate,
	tsToISO,
	usd,
} from "./lib/format";
import {
	analyzeRun,
	computeToolUsage,
	type RunAnalysis,
	type ToolUsageSummary,
} from "./lib/log-stats";
import type { AppBlueprint, ConfigEvent, StoredEvent } from "./lib/types";

// ── CLI argument parsing ────────────────────────────────────────────

const appIdA = process.argv[2];
const appIdB = process.argv[3];
const verbose = process.argv.includes("--verbose");
const runFlag =
	process.argv.find((a) => a.startsWith("--run="))?.split("=")[1] ?? "build";

if (!appIdA || !appIdB) {
	console.error(
		"Usage: npx tsx scripts/inspect-compare.ts <appId1> <appId2> [--run=build|latest|<id,id>] [--verbose]",
	);
	process.exit(1);
}

/**
 * Parse the --run flag into per-app run resolution strategy.
 *
 * - "build" (default): find the initial build run via config event
 * - "latest": use data.run_id from the app document
 * - "<idA,idB>": explicit run IDs for each app (comma-separated)
 */
function parseRunTargets(): {
	mode: "build" | "latest" | "explicit";
	explicitA?: string;
	explicitB?: string;
} {
	if (runFlag === "build") return { mode: "build" };
	if (runFlag === "latest") return { mode: "latest" };
	/* Comma-separated explicit run IDs. */
	const parts = runFlag.split(",");
	if (parts.length === 2 && parts[0] && parts[1]) {
		return { mode: "explicit", explicitA: parts[0], explicitB: parts[1] };
	}
	console.error(
		`Invalid --run value: "${runFlag}". Use "build", "latest", or "<runIdA>,<runIdB>".`,
	);
	process.exit(1);
}

const runTargets = parseRunTargets();

// ── Data loading ────────────────────────────────────────────────────

/**
 * All the data needed for one side of the comparison.
 *
 * Fetched in parallel for both apps, then analyzed locally.
 * The separation between raw data and computed stats keeps the
 * Firestore access pattern simple (two parallel fetches).
 */
interface AppData {
	appId: string;
	appName: string;
	owner: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	connectType: string | null;
	/** Which run was selected for analysis. */
	runId: string | null;
	/** How the run was resolved — shown in the output header. */
	runLabel: string;
	blueprintStats: BlueprintStats | null;
	runAnalysis: RunAnalysis | null;
	toolUsage: ToolUsageSummary[];
}

/**
 * Find the initial build run for an app by scanning config events.
 *
 * The build run is identified by prompt_mode === "build" in its config
 * event. Since event.type is a nested field, Firestore can't filter on
 * it — we fetch all config-like events and filter client-side.
 *
 * Falls back to data.run_id if no build config is found (pre-logging
 * apps or apps where config events weren't recorded).
 */
async function findBuildRunId(
	appId: string,
	fallbackRunId: string | null,
): Promise<{ runId: string | null; label: string }> {
	const logSnap = await db
		.collection("apps")
		.doc(appId)
		.collection("logs")
		.orderBy("sequence", "asc")
		.get();

	if (logSnap.empty) {
		return {
			runId: fallbackRunId,
			label: fallbackRunId ? "latest (no logs)" : "none",
		};
	}

	/* Scan for config events with prompt_mode === "build". The first one
	 * chronologically is the initial generation run. */
	for (const doc of logSnap.docs) {
		const stored = doc.data() as StoredEvent;
		if (stored.event.type === "config") {
			const config = stored.event as ConfigEvent;
			if (config.prompt_mode === "build") {
				return { runId: stored.run_id, label: "build" };
			}
		}
	}

	/* No build config found — fall back to the app's run_id. */
	return {
		runId: fallbackRunId,
		label: fallbackRunId ? "latest (no build found)" : "none",
	};
}

/**
 * Load all data for one app: document metadata, blueprint stats, and
 * the target run's log analysis. The run is selected based on the
 * --run flag (build, latest, or explicit ID).
 */
async function loadAppData(
	appId: string,
	runMode: "build" | "latest" | "explicit",
	explicitRunId?: string,
): Promise<AppData> {
	/* Fetch app document. */
	const appSnap = await db.collection("apps").doc(appId).get();
	if (!appSnap.exists) {
		console.error(`App ${appId} not found.`);
		process.exit(1);
	}
	// biome-ignore lint/style/noNonNullAssertion: guarded by exists check
	const data = appSnap.data()!;
	const bp: AppBlueprint | undefined = data.blueprint;

	/* Compute blueprint stats (null if no blueprint). */
	const blueprintStats = bp ? analyzeBlueprint(bp) : null;

	/* Resolve which run to analyze. */
	let runId: string | null;
	let runLabel: string;

	if (runMode === "explicit" && explicitRunId) {
		runId = explicitRunId;
		runLabel = "explicit";
	} else if (runMode === "latest") {
		runId = data.run_id ?? null;
		runLabel = "latest";
	} else {
		/* Default: find the initial build run. */
		const resolved = await findBuildRunId(appId, data.run_id ?? null);
		runId = resolved.runId;
		runLabel = resolved.label;
	}

	/* Fetch log events for the resolved run. */
	let runAnalysis: RunAnalysis | null = null;
	let toolUsage: ToolUsageSummary[] = [];

	if (runId) {
		const logSnap = await db
			.collection("apps")
			.doc(appId)
			.collection("logs")
			.where("run_id", "==", runId)
			.orderBy("sequence", "asc")
			.get();

		if (!logSnap.empty) {
			const events = logSnap.docs.map((d) => d.data() as StoredEvent);
			runAnalysis = analyzeRun(runId, events);
			toolUsage = computeToolUsage(events);
		}
	}

	return {
		appId,
		appName: data.app_name ?? "(unnamed)",
		owner: data.owner ?? "(unknown)",
		status: data.status ?? "(unknown)",
		createdAt: tsToISO(data.created_at),
		updatedAt: tsToISO(data.updated_at),
		connectType: data.connect_type ?? null,
		runId,
		runLabel,
		blueprintStats,
		runAnalysis,
		toolUsage,
	};
}

// ── Comparison printing ─────────────────────────────────────────────

/**
 * Print a comparison row with label, two values, and an optional delta.
 * Pads values for clean alignment.
 */
function printCompRow(label: string, a: string, b: string, delta?: string) {
	const labelPad = label.padEnd(22);
	const aPad = a.padStart(14);
	const bPad = b.padStart(14);
	const deltaPad = delta !== undefined ? `  ${delta.padStart(10)}` : "";
	console.log(`  ${labelPad}${aPad}${bPad}${deltaPad}`);
}

/** Print the comparison column headers (App A / App B / Delta). */
function printCompHeader(showDelta = true) {
	const labelPad = "".padEnd(22);
	const aLabel = "App A".padStart(14);
	const bLabel = "App B".padStart(14);
	const deltaLabel = showDelta ? `  ${"Delta".padStart(10)}` : "";
	console.log(`  ${labelPad}${aLabel}${bLabel}${deltaLabel}`);
	const sep = "─".repeat(showDelta ? 62 : 50);
	console.log(`  ${sep}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	/* Fetch both apps in parallel. */
	const [appA, appB] = await Promise.all([
		loadAppData(appIdA, runTargets.mode, runTargets.explicitA),
		loadAppData(appIdB, runTargets.mode, runTargets.explicitB),
	]);

	printHeader("APP COMPARISON (read-only)");

	/* ── Header ──────────────────────────────────────────────────── */
	printSection("Header");
	printCompHeader(false);
	printCompRow(
		"App ID",
		`${appA.appId.slice(0, 12)}…`,
		`${appB.appId.slice(0, 12)}…`,
	);
	printCompRow(
		"App Name",
		truncate(appA.appName, 14),
		truncate(appB.appName, 14),
	);
	printCompRow("Status", appA.status, appB.status);
	printCompRow(
		"Created",
		appA.createdAt.slice(0, 19),
		appB.createdAt.slice(0, 19),
	);
	printCompRow(
		"Connect Type",
		appA.connectType ?? "(none)",
		appB.connectType ?? "(none)",
	);
	printCompRow("Run", appA.runLabel, appB.runLabel);

	const statsA = appA.blueprintStats;
	const statsB = appB.blueprintStats;

	/* ── Structure Comparison ────────────────────────────────────── */
	if (statsA && statsB) {
		printSection("Structure");
		printCompHeader();
		printCompRow(
			"Modules",
			String(statsA.totals.modules),
			String(statsB.totals.modules),
			formatDelta(statsA.totals.modules, statsB.totals.modules),
		);
		printCompRow(
			"Forms",
			String(statsA.totals.forms),
			String(statsB.totals.forms),
			formatDelta(statsA.totals.forms, statsB.totals.forms),
		);
		printCompRow(
			"Questions",
			String(statsA.totals.questions),
			String(statsB.totals.questions),
			formatDelta(statsA.totals.questions, statsB.totals.questions),
		);

		/* Form type breakdown. */
		const allFormTypes = new Set([
			...Object.keys(statsA.totals.formsByType),
			...Object.keys(statsB.totals.formsByType),
		]);
		for (const type of allFormTypes) {
			const a = statsA.totals.formsByType[type] ?? 0;
			const b = statsB.totals.formsByType[type] ?? 0;
			printCompRow(`  ${type}`, String(a), String(b), formatDelta(a, b));
		}

		/* ── Quality Metrics ─────────────────────────────────────── */
		printSection("Quality Metrics");
		printCompHeader();
		const la = statsA.totals.logic;
		const lb = statsB.totals.logic;

		const logicRows: Array<[string, number, number]> = [
			["Calculates", la.calculates, lb.calculates],
			["Show-whens", la.relevants, lb.relevants],
			["Defaults", la.defaults, lb.defaults],
			["Validations", la.validations, lb.validations],
			["Required fields", la.requireds, lb.requireds],
			["Hints", la.hints, lb.hints],
			["Labels (info)", la.labels, lb.labels],
			["With logic", la.questionsWithLogic, lb.questionsWithLogic],
		];

		for (const [label, a, b] of logicRows) {
			printCompRow(label, String(a), String(b), formatDelta(a, b));
		}

		/* Logic coverage percentage (questions with logic / total questions). */
		const covA =
			statsA.totals.questions > 0
				? (la.questionsWithLogic / statsA.totals.questions) * 100
				: 0;
		const covB =
			statsB.totals.questions > 0
				? (lb.questionsWithLogic / statsB.totals.questions) * 100
				: 0;
		printCompRow(
			"Logic coverage",
			`${covA.toFixed(1)}%`,
			`${covB.toFixed(1)}%`,
			formatPctDelta(covA, covB),
		);

		/* ── Case Design ─────────────────────────────────────────── */
		printSection("Case Design");
		printCompHeader();
		printCompRow(
			"Case types",
			String(statsA.caseTypes.length),
			String(statsB.caseTypes.length),
			formatDelta(statsA.caseTypes.length, statsB.caseTypes.length),
		);

		/* Show each case type and its property count. */
		const allCaseNames = new Set([
			...statsA.caseTypes.map((ct) => ct.name),
			...statsB.caseTypes.map((ct) => ct.name),
		]);
		for (const name of allCaseNames) {
			const ctA = statsA.caseTypes.find((ct) => ct.name === name);
			const ctB = statsB.caseTypes.find((ct) => ct.name === name);
			const propsA = ctA?.propertyCount ?? 0;
			const propsB = ctB?.propertyCount ?? 0;
			printCompRow(
				`  ${name}`,
				ctA ? `${propsA} props` : "—",
				ctB ? `${propsB} props` : "—",
				formatDelta(propsA, propsB),
			);
		}

		/* Total case list columns. */
		const clColsA = statsA.modules.reduce(
			(sum, m) => sum + m.caseListColumns,
			0,
		);
		const clColsB = statsB.modules.reduce(
			(sum, m) => sum + m.caseListColumns,
			0,
		);
		printCompRow(
			"Case list cols",
			String(clColsA),
			String(clColsB),
			formatDelta(clColsA, clColsB),
		);
	}

	/* ── Cost Comparison ─────────────────────────────────────────── */
	const runA = appA.runAnalysis;
	const runB = appB.runAnalysis;

	if (runA && runB) {
		printSection("Cost Comparison");
		printCompHeader();

		const cA = runA.cost;
		const cB = runB.cost;

		printCompRow(
			"Total cost",
			usd(cA.totalCost),
			usd(cB.totalCost),
			formatDelta(cA.totalCost, cB.totalCost, usd),
		);
		printCompRow(
			"Duration",
			duration(runA.durationMs),
			duration(runB.durationMs),
			formatDelta(runA.durationMs, runB.durationMs, (ms) =>
				duration(Math.abs(ms)),
			),
		);
		printCompRow(
			"Steps",
			String(cA.stepCount),
			String(cB.stepCount),
			formatDelta(cA.stepCount, cB.stepCount),
		);
		printCompRow(
			"Input tokens",
			tok(cA.agentInputTokens),
			tok(cB.agentInputTokens),
			formatDelta(cA.agentInputTokens, cB.agentInputTokens, tok),
		);
		printCompRow(
			"Output tokens",
			tok(cA.agentOutputTokens),
			tok(cB.agentOutputTokens),
			formatDelta(cA.agentOutputTokens, cB.agentOutputTokens, tok),
		);
		printCompRow(
			"Cache hit rate",
			pct(cA.cacheReadTokens, cA.agentInputTokens),
			pct(cB.cacheReadTokens, cB.agentInputTokens),
			formatPctDelta(cA.cacheHitRate * 100, cB.cacheHitRate * 100),
		);

		/* Cost per question (if blueprints exist). */
		if (
			statsA &&
			statsB &&
			statsA.totals.questions > 0 &&
			statsB.totals.questions > 0
		) {
			const cpqA = cA.totalCost / statsA.totals.questions;
			const cpqB = cB.totalCost / statsB.totals.questions;
			printCompRow(
				"Cost/question",
				usd(cpqA),
				usd(cpqB),
				formatDelta(cpqA, cpqB, usd),
			);
		}

		/* ── Agent Behavior ──────────────────────────────────────── */
		printSection("Agent Behavior");
		printCompHeader();

		printCompRow(
			"Prompt mode",
			runA.config?.promptMode ?? "—",
			runB.config?.promptMode ?? "—",
		);
		printCompRow(
			"Errors",
			String(runA.errorMessages.length),
			String(runB.errorMessages.length),
			formatDelta(runA.errorMessages.length, runB.errorMessages.length),
		);

		/* Tool call distribution — union of all tools used by either app. */
		const toolMapA = new Map(appA.toolUsage.map((t) => [t.name, t]));
		const toolMapB = new Map(appB.toolUsage.map((t) => [t.name, t]));
		const allTools = new Set([...toolMapA.keys(), ...toolMapB.keys()]);

		/* Sort by total calls descending (A + B combined). */
		const sortedTools = [...allTools].sort((x, y) => {
			const totalX =
				(toolMapA.get(x)?.callCount ?? 0) + (toolMapB.get(x)?.callCount ?? 0);
			const totalY =
				(toolMapA.get(y)?.callCount ?? 0) + (toolMapB.get(y)?.callCount ?? 0);
			return totalY - totalX;
		});

		console.log();
		console.log("  Tool Calls:");
		for (const tool of sortedTools) {
			const a = toolMapA.get(tool)?.callCount ?? 0;
			const b = toolMapB.get(tool)?.callCount ?? 0;
			printCompRow(`  ${tool}`, String(a), String(b), formatDelta(a, b));
		}
	}

	/* ── Quality Flags ───────────────────────────────────────────── */
	if (statsA || statsB) {
		printSection("Quality Flags");

		const flagsA = statsA?.qualityFlags ?? [];
		const flagsB = statsB?.qualityFlags ?? [];

		console.log(`  App A (${flagsA.length} flags):`);
		if (flagsA.length === 0) {
			console.log("    (none)");
		} else {
			for (const f of flagsA) {
				const loc = [f.module, f.form].filter(Boolean).join(" > ");
				console.log(`    [${f.severity}] ${loc ? `${loc}: ` : ""}${f.message}`);
			}
		}

		console.log(`\n  App B (${flagsB.length} flags):`);
		if (flagsB.length === 0) {
			console.log("    (none)");
		} else {
			for (const f of flagsB) {
				const loc = [f.module, f.form].filter(Boolean).join(" > ");
				console.log(`    [${f.severity}] ${loc ? `${loc}: ` : ""}${f.message}`);
			}
		}
	}

	/* ── Verbose: per-module form-by-form comparison ──────────────── */
	if (verbose && statsA && statsB) {
		printSection("Per-Module Detail");

		/* Show forms side-by-side for each module (by index). */
		const maxMods = Math.max(statsA.modules.length, statsB.modules.length);
		for (let i = 0; i < maxMods; i++) {
			const mA = statsA.modules[i];
			const mB = statsB.modules[i];
			const nameA = mA?.name ?? "(none)";
			const nameB = mB?.name ?? "(none)";

			console.log(`\n  Module ${i}: ${nameA}  vs  ${nameB}`);
			console.log(
				`    Case type: ${mA?.caseType ?? "—"}  vs  ${mB?.caseType ?? "—"}`,
			);
			console.log(
				`    Questions: ${mA?.totalQuestions ?? 0}  vs  ${mB?.totalQuestions ?? 0}`,
			);
			console.log(
				`    Case list cols: ${mA?.caseListColumns ?? 0}  vs  ${mB?.caseListColumns ?? 0}`,
			);

			const maxForms = Math.max(mA?.forms.length ?? 0, mB?.forms.length ?? 0);
			for (let j = 0; j < maxForms; j++) {
				const fA = mA?.forms[j];
				const fB = mB?.forms[j];
				console.log(
					`      Form ${j}: ${fA?.name ?? "(none)"} (${fA?.questionCount ?? 0}q)  vs  ${fB?.name ?? "(none)"} (${fB?.questionCount ?? 0}q)`,
				);
			}
		}
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
