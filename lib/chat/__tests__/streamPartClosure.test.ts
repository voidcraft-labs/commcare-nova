/**
 * Open-part tracker — the retry loop's guarantee that an aborted attempt's
 * message parts end cleanly instead of rendering stuck-streaming above the
 * retried answer.
 */

import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenPartTracker } from "../streamPartClosure";

const c = (chunk: Record<string, unknown>) => chunk as UIMessageChunk;

describe("createOpenPartTracker", () => {
	it("closes an interrupted text part and the open step", () => {
		const t = createOpenPartTracker();
		t.observe(c({ type: "start" }));
		t.observe(c({ type: "start-step" }));
		t.observe(c({ type: "text-start", id: "0" }));
		t.observe(c({ type: "text-delta", id: "0", delta: "hal" }));

		expect(t.closures()).toEqual([
			c({ type: "text-end", id: "0" }),
			c({ type: "finish-step" }),
		]);
	});

	it("returns nothing after a cleanly completed step", () => {
		const t = createOpenPartTracker();
		t.observe(c({ type: "start-step" }));
		t.observe(c({ type: "text-start", id: "0" }));
		t.observe(c({ type: "text-end", id: "0" }));
		t.observe(c({ type: "finish-step" }));

		expect(t.closures()).toEqual([]);
	});

	it("errors out an orphaned tool call — including one whose input completed", () => {
		const t = createOpenPartTracker();
		t.observe(c({ type: "start-step" }));
		t.observe(c({ type: "tool-input-start", toolCallId: "t1", toolName: "x" }));
		t.observe(
			c({
				type: "tool-input-available",
				toolCallId: "t1",
				toolName: "x",
				input: {},
			}),
		);
		t.observe(c({ type: "reasoning-start", id: "r0" }));

		const closures = t.closures();
		expect(closures.map((ch) => ch.type)).toEqual([
			"reasoning-end",
			"tool-output-error",
			"finish-step",
		]);
		const toolClosure = closures.find(
			(ch) => ch.type === "tool-output-error",
		) as { toolCallId: string; errorText: string };
		expect(toolClosure.toolCallId).toBe("t1");
		expect(toolClosure.errorText.length).toBeGreaterThan(0);
	});

	it("does not close a tool call whose output already arrived", () => {
		const t = createOpenPartTracker();
		t.observe(c({ type: "start-step" }));
		t.observe(c({ type: "tool-input-start", toolCallId: "t1", toolName: "x" }));
		t.observe(
			c({ type: "tool-output-available", toolCallId: "t1", output: {} }),
		);

		// Only the open step needs closing.
		expect(t.closures()).toEqual([c({ type: "finish-step" })]);
	});

	it("resets after closures — the retried attempt starts clean", () => {
		const t = createOpenPartTracker();
		t.observe(c({ type: "start-step" }));
		t.observe(c({ type: "text-start", id: "0" }));
		t.closures();

		// The retried attempt runs a full clean step; nothing to close after.
		t.observe(c({ type: "start-step" }));
		t.observe(c({ type: "text-start", id: "0" }));
		t.observe(c({ type: "text-end", id: "0" }));
		t.observe(c({ type: "finish-step" }));
		expect(t.closures()).toEqual([]);
	});
});
