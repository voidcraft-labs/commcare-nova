/**
 * Event-stream analytics for diagnostic scripts.
 *
 * Operates on the Phase-4 unified `Event[]` shape (mutation + conversation
 * events) as produced by the writer in `lib/log/writer.ts`. Token-cost TOTALS
 * (input/output/cache) live on the per-run summary doc at
 * `apps/{appId}/runs/{runId}` (see `lib/db/runSummary.ts`) — fetch that for
 * "how much did this run cost." But per-TOOL result SIZES — the context-cost
 * proxy for "which tool's output inflated it" — ARE derived here from the
 * event log's `tool-result.output` (see `computeToolUsage`), because the
 * summary's aggregates can't attribute cost to a specific tool.
 *
 * All functions are pure: they take event arrays and return computed
 * results. No database access.
 */

import type { Event } from "./types";

// ── Grouping ────────────────────────────────────────────────────────

/**
 * Group events by their `runId`. Preserves input order within each group,
 * which matches `(ts, seq)` order if the caller fetched events via
 * `readEvents` (the reader query orders by both). Useful for scripts that
 * load every event for an app and then iterate run-by-run.
 */
export function groupByRun(events: Event[]): Map<string, Event[]> {
	const groups = new Map<string, Event[]>();
	for (const event of events) {
		const existing = groups.get(event.runId);
		if (existing) {
			existing.push(event);
		} else {
			groups.set(event.runId, [event]);
		}
	}
	return groups;
}

// ── Tool usage ──────────────────────────────────────────────────────

/**
 * A single row in the tool-usage distribution table.
 *
 * Carries both the call count AND the per-tool RESULT SIZE — the serialized
 * length of every `tool-result` `output` this tool produced. Result size is
 * the per-tool proxy for context cost: a tool result re-rides the agent's
 * context on every subsequent step, so a tool that returns large payloads
 * (a verbatim config dump, an unbounded match list) is what inflates the
 * cache read/write tokens the run summary only shows in aggregate. The run
 * summary has the token TOTALS; this is where you find WHICH tool owns them.
 */
export interface ToolUsageRow {
	tool: string;
	calls: number;
	/** Number of `tool-result` events seen for this tool (≈ calls). */
	results: number;
	/** Σ serialized `output` bytes across this tool's results. */
	totalOutputBytes: number;
	/** Largest single result's serialized `output` bytes. */
	maxOutputBytes: number;
}

/**
 * Aggregate per-tool call counts AND result-output sizes from the event log.
 * Counts come from `tool-call` events; sizes from the serialized `output` of
 * the paired `tool-result` events. Sorted by total output bytes descending so
 * the biggest context-cost contributor surfaces first (call count is a weak
 * proxy — one verbose result outweighs ten terse ones).
 */
export function computeToolUsage(events: Event[]): ToolUsageRow[] {
	const rows = new Map<string, ToolUsageRow>();
	const row = (tool: string): ToolUsageRow => {
		let r = rows.get(tool);
		if (!r) {
			r = {
				tool,
				calls: 0,
				results: 0,
				totalOutputBytes: 0,
				maxOutputBytes: 0,
			};
			rows.set(tool, r);
		}
		return r;
	};
	for (const event of events) {
		if (event.kind !== "conversation") continue;
		if (event.payload.type === "tool-call") {
			row(event.payload.toolName).calls += 1;
		} else if (event.payload.type === "tool-result") {
			const r = row(event.payload.toolName);
			// Serialized length is the size the model actually pays for when the
			// result rides the context (close enough; JSON is the wire shape).
			const bytes = JSON.stringify(event.payload.output ?? null).length;
			r.results += 1;
			r.totalOutputBytes += bytes;
			if (bytes > r.maxOutputBytes) r.maxOutputBytes = bytes;
		}
	}
	return [...rows.values()].sort(
		(a, b) => b.totalOutputBytes - a.totalOutputBytes || b.calls - a.calls,
	);
}

// ── Timeline ────────────────────────────────────────────────────────

/** A single row in the timeline-gap table. */
export interface TimelineRow {
	/** Millisecond timestamp of this event. */
	ts: number;
	/**
	 * Milliseconds elapsed since the previous event in this slice. `0` for
	 * the first row (no previous event to measure against). Spikes here
	 * flag agent hangs; clustered sub-millisecond gaps indicate SSE bursts.
	 */
	gapMs: number;
	/**
	 * Compact label describing the event — `"mutation[:stage]"` for doc
	 * writes, `"conversation:<payload-type>"` for everything else. Used as
	 * a human-readable column in the output table.
	 */
	kind: string;
}

/**
 * Build a per-event timeline showing inter-event gaps. Input order is
 * preserved — callers should pass events already sorted by `(ts, seq)`,
 * which is what `readEvents` returns.
 */
export function computeTimeline(events: Event[]): TimelineRow[] {
	return events.map((event, index) => {
		const prev = index > 0 ? events[index - 1] : null;
		const gapMs = prev ? event.ts - prev.ts : 0;
		const kind =
			event.kind === "mutation"
				? `mutation${event.stage ? `:${event.stage}` : ""}`
				: `conversation:${event.payload.type}`;
		return { ts: event.ts, gapMs, kind };
	});
}

// ── Mutations by stage ──────────────────────────────────────────────

/** A single row in the mutations-by-stage table. */
export interface StageCountRow {
	stage: string;
	count: number;
}

/**
 * Count mutation events grouped by their `stage` tag. Untagged mutations
 * (edit-mode user writes, manual fixes) bucket into `"(untagged)"`. The
 * stage tag is the agent's semantic label for a write — e.g. `"scaffold"`,
 * `"module:0"`, `"form:0-1"`.
 *
 * Sorted by count descending so the heaviest stages surface first.
 */
export function computeMutationsByStage(events: Event[]): StageCountRow[] {
	const counts = new Map<string, number>();
	for (const event of events) {
		if (event.kind !== "mutation") continue;
		const key = event.stage ?? "(untagged)";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([stage, count]) => ({ stage, count }))
		.sort((a, b) => b.count - a.count);
}

// ── Event-kind distribution ─────────────────────────────────────────

/** Per-kind breakdown returned by `computeEventKindCounts`. */
export interface EventKindCounts {
	mutation: number;
	/** Broken down by conversation payload type. */
	conversation: Record<string, number>;
	total: number;
}

/**
 * Distribution of events by kind. Conversation events are further split
 * by payload type so `--runs` and the default header can show "3 user
 * messages, 12 tool calls, 12 tool results" at a glance.
 */
export function computeEventKindCounts(events: Event[]): EventKindCounts {
	const conversation: Record<string, number> = {};
	let mutation = 0;
	for (const event of events) {
		if (event.kind === "mutation") {
			mutation++;
		} else {
			conversation[event.payload.type] =
				(conversation[event.payload.type] ?? 0) + 1;
		}
	}
	return { mutation, conversation, total: events.length };
}
