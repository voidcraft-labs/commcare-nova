/**
 * Open-part tracker — the retry loop's guarantee that an aborted attempt's
 * message parts end cleanly instead of rendering stuck-streaming above the
 * retried answer.
 */

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
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

it("the SDK consumes retry closures as completed parts in one assistant message", async () => {
	const tracker = createOpenPartTracker();
	const interrupted: UIMessageChunk[] = [
		{ type: "start", messageId: "answer" },
		{ type: "start-step" },
		{ type: "text-start", id: "text-1" },
		{ type: "text-delta", id: "text-1", delta: "First attempt" },
		{ type: "reasoning-start", id: "reasoning-1" },
		{ type: "reasoning-delta", id: "reasoning-1", delta: "Partial reasoning" },
		{
			type: "tool-input-available",
			toolCallId: "call-1",
			toolName: "searchBlueprint",
			input: { query: "patient" },
		},
	];
	for (const chunk of interrupted) tracker.observe(chunk);
	const chunks: UIMessageChunk[] = [
		...interrupted,
		...tracker.closures("This attempt stopped."),
		{ type: "start-step" },
		{ type: "text-start", id: "text-2" },
		{ type: "text-delta", id: "text-2", delta: "Retried answer" },
		{ type: "text-end", id: "text-2" },
		{ type: "finish-step" },
		{ type: "finish" },
	];
	const stream = new ReadableStream<UIMessageChunk>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	let final: UIMessage | undefined;
	await readUIMessageStream({ stream, terminateOnError: true }).pipeTo(
		new WritableStream<UIMessage>({
			write(message) {
				final = message;
			},
		}),
	);
	expect(final).toEqual({
		id: "answer",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "text", text: "First attempt", state: "done" },
			{
				type: "reasoning",
				id: "reasoning-1",
				text: "Partial reasoning",
				state: "done",
			},
			{
				type: "tool-searchBlueprint",
				toolCallId: "call-1",
				state: "output-error",
				input: { query: "patient" },
				errorText: "This attempt stopped.",
			},
			{ type: "step-start" },
			{ type: "text", text: "Retried answer", state: "done" },
		],
	});
});
