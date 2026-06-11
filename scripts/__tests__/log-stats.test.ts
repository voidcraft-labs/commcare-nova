// scripts/__tests__/log-stats.test.ts
//
// Pure-function coverage for `computeToolUsage` — the per-tool result-SIZE
// aggregation that powers `inspect-logs --tools` (the "which tool's output
// inflated the context" view). The size math, the null-output edge, and the
// biggest-payload-first ordering are exactly the kind of silent regression a
// read-only diagnostic would never surface at runtime, so they get pinned here.
//
// Byte sizes are `JSON.stringify(output ?? null).length` — e.g. {"x":"aaa"} is
// 11 chars, {"x":"a"} is 9, "z" is 3, null is 4. The fixtures below use those
// exact serializations so the asserted totals are checkable by hand.

import { describe, expect, it } from "vitest";
import { computeToolUsage } from "../lib/log-stats";
import type { Event } from "../lib/types";

/* Minimal valid conversation events. `seq` doubles as the timestamp so the
 * helpers stay one-liners; ordering is irrelevant to `computeToolUsage`. */
let seq = 0;
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
				// Mutation body is irrelevant — computeToolUsage skips on `kind`
				// alone, before ever reading the payload.
				mutation: { op: "noop" } as never,
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
