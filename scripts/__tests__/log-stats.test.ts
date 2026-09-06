import { beforeEach, describe, expect, it } from "vitest";
import {
	computeEventKindCounts,
	computeMutationsByStage,
	computeTimeline,
	computeToolErrors,
	computeToolUsage,
	groupByRun,
} from "../lib/log-stats";
import type { Event } from "../lib/types";

/* Minimal valid conversation events. `seq` doubles as the timestamp so the
 * helpers stay one-liners; ordering is irrelevant to `computeToolUsage`. */
let seq = 0;
beforeEach(() => {
	seq = 0;
});
function toolCall(toolName: string): Event {
	const n = seq++;
	return {
		kind: "conversation",
		source: "chat",
		runId: "r",
		ts: n,
		seq: n,
		payload: { type: "tool-call", toolCallId: `c${n}`, toolName, input: {} },
	};
}
function toolResult(toolName: string, output: unknown): Event {
	const n = seq++;
	return {
		kind: "conversation",
		source: "chat",
		runId: "r",
		ts: n,
		seq: n,
		payload: { type: "tool-result", toolCallId: `c${n}`, toolName, output },
	};
}

describe("computeToolUsage", () => {
	it("aggregates calls, results, total + max output bytes per tool", () => {
		const events: Event[] = [
			toolCall("getForm"),
			toolResult("getForm", { x: "aaa" }), // 11 bytes
			toolCall("getForm"),
			toolResult("getForm", { x: "a" }), // 9 bytes
		];

		const [row] = computeToolUsage(events);
		expect(row).toEqual({
			tool: "getForm",
			calls: 2,
			results: 2,
			totalOutputBytes: 20, // 11 + 9
			maxOutputBytes: 11, // the larger single result
		});
	});

	it("sorts by total output bytes descending — the biggest context-cost driver first", () => {
		const events: Event[] = [
			toolCall("addFields"),
			toolResult("addFields", "z"), // 3 bytes
			toolCall("getForm"),
			toolResult("getForm", { x: "aaa" }), // 11 bytes
		];

		expect(computeToolUsage(events).map((r) => r.tool)).toEqual([
			"getForm",
			"addFields",
		]);
	});

	it("breaks a total-bytes tie by call count (a noisier tool ranks higher)", () => {
		const events: Event[] = [
			// "quiet" — one call, one 5-byte result.
			toolCall("quiet"),
			toolResult("quiet", "xyz"), // 5 bytes
			// "chatty" — two calls, results summing to the same 5 bytes.
			toolCall("chatty"),
			toolResult("chatty", "x"), // 3 bytes
			toolCall("chatty"),
			toolResult("chatty", ""), // 2 bytes
		];

		const rows = computeToolUsage(events);
		expect(rows.map((r) => r.tool)).toEqual(["chatty", "quiet"]);
		expect(rows[0].totalOutputBytes).toBe(rows[1].totalOutputBytes);
	});

	it("counts a null/void tool result as 4 bytes ('null') without throwing", () => {
		const events: Event[] = [
			toolCall("removeField"),
			toolResult("removeField", null),
		];
		const [row] = computeToolUsage(events);
		expect(row.results).toBe(1);
		expect(row.totalOutputBytes).toBe(4); // JSON.stringify(null) === "null"
		expect(row.maxOutputBytes).toBe(4);
	});

	it("ignores mutation events and non-tool conversation payloads", () => {
		const events: Event[] = [
			{
				kind: "mutation",
				source: "chat",
				runId: "r",
				ts: 100,
				seq: 100,
				actor: "agent",
				mutation: { kind: "setAppName", name: "Renamed" },
			},
			{
				kind: "conversation",
				source: "chat",
				runId: "r",
				ts: 101,
				seq: 101,
				payload: { type: "assistant-text", text: "hello" },
			},
			toolCall("getForm"),
			toolResult("getForm", { x: "a" }), // 9 bytes
		];

		const rows = computeToolUsage(events);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			tool: "getForm",
			calls: 1,
			totalOutputBytes: 9,
		});
	});
});

it("ranks actual UTF-8 result bytes, including Unicode that reverses character-length order", () => {
	expect(
		computeToolUsage([toolResult("ascii", "abc"), toolResult("unicode", "😃")]),
	).toEqual([
		{
			tool: "unicode",
			calls: 0,
			results: 1,
			totalOutputBytes: 6,
			maxOutputBytes: 6,
		},
		{
			tool: "ascii",
			calls: 0,
			results: 1,
			totalOutputBytes: 5,
			maxOutputBytes: 5,
		},
	]);
});

it("summarizes a mixed event history without counting archived mutations as current work", () => {
	const envelope = {
		source: "chat" as const,
		runId: "first",
		ts: 1000,
		seq: 0,
	};
	const events: Event[] = [
		{
			...envelope,
			kind: "mutation",
			actor: "agent",
			stage: "scaffold",
			mutation: { kind: "setAppName", name: "A" },
		},
		{
			...envelope,
			seq: 1,
			kind: "archived-mutation",
			archived: { kind: "old-edit" },
		},
		{
			...envelope,
			seq: 2,
			ts: 1025,
			kind: "conversation",
			payload: {
				type: "tool-result",
				toolName: "addFields",
				toolCallId: "failed",
				output: { error: "Unknown form" },
			},
		},
		{
			...envelope,
			runId: "second",
			ts: 1125,
			seq: 0,
			kind: "mutation",
			actor: "user",
			mutation: { kind: "setAppName", name: "B" },
		},
	];
	const original = structuredClone(events);
	expect([...groupByRun(events)]).toEqual([
		["first", events.slice(0, 3)],
		["second", [events[3]]],
	]);
	expect(computeToolErrors(events)).toEqual([
		{
			seq: 2,
			ts: 1025,
			toolName: "addFields",
			toolCallId: "failed",
			error: "Unknown form",
		},
	]);
	expect(computeTimeline(events)).toEqual([
		{ ts: 1000, gapMs: 0, kind: "mutation:scaffold" },
		{ ts: 1000, gapMs: 0, kind: "archived-mutation" },
		{ ts: 1025, gapMs: 25, kind: "conversation:tool-result" },
		{ ts: 1125, gapMs: 100, kind: "mutation" },
	]);
	expect(computeMutationsByStage(events)).toEqual([
		{ stage: "scaffold", count: 1 },
		{ stage: "(untagged)", count: 1 },
	]);
	expect(computeEventKindCounts(events)).toEqual({
		mutation: 2,
		archivedMutation: 1,
		conversation: { "tool-result": 1 },
		total: 4,
	});
	expect(events).toEqual(original);
});
