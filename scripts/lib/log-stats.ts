/**
 * Log event analysis functions for diagnostic scripts.
 *
 * Computes cost breakdowns, per-step metrics, tool usage distribution,
 * and timing analysis from StoredEvent arrays. All functions are pure —
 * they take event data and return computed results. No Firestore access.
 *
 * Used by inspect-logs (--steps, --timeline, --tools, run header cost)
 * and inspect-compare (side-by-side cost/behavior comparison).
 */

import { truncate } from "./format";
import type { ConfigEvent, StepEvent, StoredEvent } from "./types";

// ── Result types ────────────────────────────────────────────────────

/**
 * Aggregated cost/token summary for a run or set of events.
 *
 * Separates agent-level tokens (the SA's LLM calls) from inner tool
 * LLM calls (e.g. generateText invoked by a tool). Total cost is the
 * sum of both layers.
 */
export interface CostSummary {
	stepCount: number;
	agentInputTokens: number;
	agentOutputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	agentCost: number;
	/**
	 * Cache hit rate: cacheReadTokens / agentInputTokens.
	 *
	 * The Anthropic API reports input_tokens as the total including
	 * cache reads, so this ratio reflects what percentage of the input
	 * came from cache. Range: 0–1.
	 */
	cacheHitRate: number;
	/** Inner tool LLM calls (e.g. structured output inside tools). */
	toolLLM: {
		inputTokens: number;
		outputTokens: number;
		cost: number;
	};
	totalCost: number;
}

/**
 * Per-step breakdown row.
 *
 * One row per agent step (LLM call). Contains the tools invoked,
 * token usage, cost, and snippets of reasoning/text for quick scanning.
 */
export interface StepBreakdown {
	stepIndex: number;
	sequence: number;
	timestamp: string;
	tools: string[];
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheHitRate: number;
	cost: number;
	/** Inner tool LLM cost (if any tool invoked an LLM). */
	toolLLMCost: number;
	totalCost: number;
	/** First 120 chars of reasoning, if present. */
	reasoningSnippet: string;
	/** First 120 chars of text output, if present. */
	textSnippet: string;
}

/**
 * Tool usage aggregation.
 *
 * Shows how many times each tool was called across all steps and the
 * cumulative token cost. Useful for understanding agent behavior patterns.
 */
export interface ToolUsageSummary {
	name: string;
	callCount: number;
	/** Inner LLM cost if this tool invokes LLMs (e.g. structured output). */
	innerLLMCost: number;
}

/**
 * Timeline entry for timing analysis.
 *
 * Shows the elapsed time between consecutive steps, which reveals
 * where the agent spent its time — slow steps indicate large context
 * or complex reasoning.
 */
export interface TimelineEntry {
	stepIndex: number;
	timestamp: string;
	/** Milliseconds since previous step (0 for the first step). */
	deltaMs: number;
	tools: string[];
	cost: number;
}

/**
 * Full run analysis result.
 *
 * Combines event-level metadata (type distribution, time range, errors)
 * with the cost summary. This is the structured representation of a
 * single generation/edit run.
 */
export interface RunAnalysis {
	runId: string;
	eventCount: number;
	/** Type distribution: { step: 5, emission: 12, config: 1, error: 0 }. */
	eventTypes: Record<string, number>;
	timeRange: { start: string; end: string };
	/** Total wall-clock duration from first to last event, in milliseconds. */
	durationMs: number;
	hasError: boolean;
	errorMessages: string[];
	config: {
		promptMode: string;
		freshEdit: boolean;
		appReady: boolean;
		cacheExpired: boolean;
		moduleCount: number;
	} | null;
	cost: CostSummary;
}

// ── Core analysis functions ─────────────────────────────────────────

/** Extract only step events from a set of stored events. */
function stepEvents(
	events: StoredEvent[],
): Array<StoredEvent & { event: StepEvent }> {
	return events.filter(
		(e): e is StoredEvent & { event: StepEvent } => e.event.type === "step",
	);
}

/** Aggregate cost/token totals from a set of events. */
export function computeCostSummary(events: StoredEvent[]): CostSummary {
	let agentInput = 0;
	let agentOutput = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let agentCost = 0;
	let stepCount = 0;

	let toolInput = 0;
	let toolOutput = 0;
	let toolCost = 0;

	for (const e of stepEvents(events)) {
		stepCount++;
		const u = e.event.usage;
		agentInput += u.input_tokens;
		agentOutput += u.output_tokens;
		cacheRead += u.cache_read_tokens;
		cacheWrite += u.cache_write_tokens;
		agentCost += u.cost;

		for (const tc of e.event.tool_calls ?? []) {
			if (tc.generation) {
				toolInput += tc.generation.input_tokens;
				toolOutput += tc.generation.output_tokens;
				toolCost += tc.generation.cost;
			}
		}
	}

	return {
		stepCount,
		agentInputTokens: agentInput,
		agentOutputTokens: agentOutput,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		agentCost,
		cacheHitRate: agentInput > 0 ? cacheRead / agentInput : 0,
		toolLLM: {
			inputTokens: toolInput,
			outputTokens: toolOutput,
			cost: toolCost,
		},
		totalCost: agentCost + toolCost,
	};
}

/** Per-step breakdown table data. One row per agent step. */
export function computeStepBreakdown(events: StoredEvent[]): StepBreakdown[] {
	return stepEvents(events).map((e) => {
		const evt = e.event;
		const u = evt.usage;
		const tools = (evt.tool_calls ?? []).map((tc) => tc.name);

		let toolLLMCost = 0;
		for (const tc of evt.tool_calls ?? []) {
			if (tc.generation) toolLLMCost += tc.generation.cost;
		}

		return {
			stepIndex: evt.step_index,
			sequence: e.sequence,
			timestamp: e.timestamp,
			tools,
			inputTokens: u.input_tokens,
			outputTokens: u.output_tokens,
			cacheReadTokens: u.cache_read_tokens,
			cacheWriteTokens: u.cache_write_tokens,
			cacheHitRate:
				u.input_tokens > 0 ? u.cache_read_tokens / u.input_tokens : 0,
			cost: u.cost,
			toolLLMCost,
			totalCost: u.cost + toolLLMCost,
			reasoningSnippet: truncate(evt.reasoning ?? "", 120),
			textSnippet: truncate(evt.text ?? "", 120),
		};
	});
}

/**
 * Aggregate tool usage across all steps.
 *
 * Returns one row per unique tool name, sorted by call count descending.
 * Useful for understanding the agent's tool-calling patterns.
 */
export function computeToolUsage(events: StoredEvent[]): ToolUsageSummary[] {
	const toolMap = new Map<string, { calls: number; innerCost: number }>();

	for (const e of stepEvents(events)) {
		for (const tc of e.event.tool_calls ?? []) {
			const entry = toolMap.get(tc.name) ?? { calls: 0, innerCost: 0 };
			entry.calls++;
			if (tc.generation) entry.innerCost += tc.generation.cost;
			toolMap.set(tc.name, entry);
		}
	}

	return [...toolMap.entries()]
		.map(([name, data]) => ({
			name,
			callCount: data.calls,
			innerLLMCost: data.innerCost,
		}))
		.sort((a, b) => b.callCount - a.callCount);
}

/**
 * Compute timing between steps.
 *
 * Each entry shows the elapsed milliseconds since the previous step.
 * Useful for identifying slow steps (large context, complex reasoning)
 * versus fast ones (simple tool calls with cached context).
 */
export function computeTimeline(events: StoredEvent[]): TimelineEntry[] {
	const steps = stepEvents(events);
	const entries: TimelineEntry[] = [];
	let prevTime: number | null = null;

	for (const e of steps) {
		const ts = new Date(e.timestamp).getTime();
		const deltaMs = prevTime !== null ? ts - prevTime : 0;
		prevTime = ts;

		entries.push({
			stepIndex: e.event.step_index,
			timestamp: e.timestamp,
			deltaMs,
			tools: (e.event.tool_calls ?? []).map((tc) => tc.name),
			cost: e.event.usage.cost,
		});
	}

	return entries;
}

// ── Run-level analysis ──────────────────────────────────────────────

/** Full analysis for a single run's events. */
export function analyzeRun(runId: string, events: StoredEvent[]): RunAnalysis {
	/* Event type distribution. */
	const eventTypes: Record<string, number> = {};
	for (const e of events) {
		const t = e.event.type;
		eventTypes[t] = (eventTypes[t] ?? 0) + 1;
	}

	/* Time range and duration from first to last event. */
	const timestamps = events.map((e) => e.timestamp);
	const timeRange = {
		start: timestamps[0] ?? "",
		end: timestamps[timestamps.length - 1] ?? "",
	};
	const durationMs =
		timestamps.length >= 2
			? new Date(timestamps[timestamps.length - 1]).getTime() -
				new Date(timestamps[0]).getTime()
			: 0;

	/* Error detection. */
	const errors = events.filter((e) => e.event.type === "error");
	const errorMessages = errors.map(
		(e) => (e.event as { error_message?: string }).error_message ?? "(unknown)",
	);

	/* Config snapshot (first config event in the run). */
	const configEvent = events.find((e) => e.event.type === "config");
	const config = configEvent
		? {
				promptMode: (configEvent.event as ConfigEvent).prompt_mode,
				freshEdit: (configEvent.event as ConfigEvent).fresh_edit,
				appReady: (configEvent.event as ConfigEvent).app_ready,
				cacheExpired: (configEvent.event as ConfigEvent).cache_expired,
				moduleCount: (configEvent.event as ConfigEvent).module_count,
			}
		: null;

	return {
		runId,
		eventCount: events.length,
		eventTypes,
		timeRange,
		durationMs,
		hasError: errors.length > 0,
		errorMessages,
		config,
		cost: computeCostSummary(events),
	};
}

/** Group events by run_id, preserving sequence order within each group. */
export function groupByRun(events: StoredEvent[]): Map<string, StoredEvent[]> {
	const runs = new Map<string, StoredEvent[]>();
	for (const e of events) {
		const group = runs.get(e.run_id) ?? [];
		group.push(e);
		runs.set(e.run_id, group);
	}
	return runs;
}
