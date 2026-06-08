// lib/agent/__tests__/generationContext-extractDocumentStructured.test.ts
//
// Unit tests for `GenerationContext.extractDocumentStructured` — the ONE
// structured call the document extractor makes. It fills { extract, title,
// summary } from either a decoded text `prompt` (text/docx/xlsx) or a native
// `file` block (PDF). The call STREAMS (streamText + Output.object, so the grid
// can feed off reasoning + output deltas), so we mock `streamText` at the module
// boundary and assert the wrapper plumbing (input shape, structured-output
// request, usage tracking, the finishReason→truncated derivation, and the
// error-emission/re-throw contract) WITHOUT a network call. The real
// `UsageAccumulator` is exercised so the `trackSubGeneration` fan-in is verified.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GenerationContext } from "../generationContext";
import { makeTestContext } from "./fixtures";

// Mock `streamText` so we assert the wrapper plumbing, not the network.
// `orig` preserves every other `ai` export the context module imports (Output, …).
vi.mock("ai", async (orig) => {
	const actual = await orig<typeof import("ai")>();
	return { ...actual, streamText: vi.fn() };
});

import * as aiSdk from "ai";

/** Narrow the module-level `streamText` mock to the vi.fn surface. */
const mockStreamText = () =>
	aiSdk.streamText as unknown as ReturnType<typeof vi.fn>;

/** The { extract, title, summary } schema the extractor fills — extract first. */
const schema = z.object({
	extract: z.string(),
	title: z.string(),
	summary: z.string(),
});
const OBJECT = { extract: "EXTRACT", title: "Title", summary: "Summary." };

type StreamPart = { type: string; text?: string };

/** A `streamText` result: a `fullStream` (drives generation + progress) plus the
 *  finished-response promises. `streamText` returns this synchronously. */
function streamResult(
	over: Partial<{
		fullStream: AsyncIterable<StreamPart>;
		output: Promise<unknown>;
		usage: Promise<unknown>;
		warnings: Promise<unknown>;
		finishReason: Promise<string>;
	}> = {},
) {
	async function* oneChunk(): AsyncGenerator<StreamPart> {
		yield { type: "reasoning-delta", text: "thinking" };
		yield { type: "text-delta", text: "chunk" };
	}
	return {
		fullStream: oneChunk(),
		output: Promise.resolve(OBJECT),
		usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
		warnings: Promise.resolve([]),
		finishReason: Promise.resolve("stop"),
		...over,
	};
}

/** A `fullStream` that throws on consumption — a transport failure mid-stream.
 *  `yield* []` makes it a real (empty) generator before the throw. */
async function* throwingStream(): AsyncGenerator<StreamPart> {
	yield* [];
	throw new Error("gemini down");
}

describe("GenerationContext.extractDocumentStructured", () => {
	let ctx: GenerationContext;
	// The real accumulator + the SSE writer stub — to assert the usage fan-in and
	// the error-event emission.
	let usage: ReturnType<typeof makeTestContext>["usage"];
	let writer: ReturnType<typeof makeTestContext>["writer"];

	beforeEach(() => {
		mockStreamText().mockReset();
		({ ctx, usage, writer } = makeTestContext());
	});

	it("sends a text prompt + structured output and tracks usage (clean finish = not truncated)", async () => {
		mockStreamText().mockReturnValue(streamResult());

		const out = await ctx.extractDocumentStructured({
			system: "extract",
			prompt: "the document body",
			schema,
			label: "attachment-txt",
			model: "claude-haiku-4-5-20251001",
			maxOutputTokens: 4096,
		});

		expect(out).toEqual({ object: OBJECT, truncated: false });

		// System prompt, the decoded text prompt, the structured-output request, and
		// the output cap pass through; no `messages` (that's the file path).
		const call = mockStreamText().mock.calls[0][0];
		expect(call.system).toBe("extract");
		expect(call.prompt).toBe("the document body");
		expect(call.output).toBeDefined(); // Output.object({ schema })
		expect(call.maxOutputTokens).toBe(4096);
		expect(call.messages).toBeUndefined();

		// The mocked usage fans into the shared accumulator (the method's own return
		// omits usage, so the snapshot is the only place to observe trackSubGeneration).
		expect(usage.snapshot().inputTokens).toBe(10);
		expect(usage.snapshot().outputTokens).toBe(5);
	});

	it("sends a PDF as a native file block in a user message (no text prompt)", async () => {
		mockStreamText().mockReturnValue(streamResult());

		await ctx.extractDocumentStructured({
			system: "extract",
			file: {
				mediaType: "application/pdf",
				data: "data:application/pdf;base64,AAAA",
			},
			instruction: "Extract requirements.",
			schema,
			label: "attachment-pdf",
		});

		// The user turn carries the instruction text followed by the file block —
		// the document block the provider turns into a native PDF block.
		const call = mockStreamText().mock.calls[0][0];
		expect(call.prompt).toBeUndefined();
		expect(call.messages[0].role).toBe("user");
		expect(call.messages[0].content).toEqual([
			{ type: "text", text: "Extract requirements." },
			{
				type: "file",
				data: "data:application/pdf;base64,AAAA",
				mediaType: "application/pdf",
			},
		]);
	});

	it("flags truncation when the model reports a length finish", async () => {
		mockStreamText().mockReturnValue(
			streamResult({
				usage: Promise.resolve({ inputTokens: 10, outputTokens: 4096 }),
				finishReason: Promise.resolve("length"),
			}),
		);

		const out = await ctx.extractDocumentStructured({
			system: "extract",
			prompt: "a very long document body",
			schema,
			label: "attachment-txt",
		});
		expect(out.truncated).toBe(true);
	});

	it("re-throws on model failure AND emits an error event by default", async () => {
		// A transport failure surfaces while consuming the stream; streamObjectWith
		// re-throws it (not a NoObjectGeneratedError), and the method's catch emits.
		mockStreamText().mockReturnValue(
			streamResult({ fullStream: throwingStream() }),
		);

		await expect(
			ctx.extractDocumentStructured({
				system: "extract",
				prompt: "body",
				schema,
				label: "attachment-txt",
			}),
		).rejects.toThrow("gemini down");

		// Default (emitErrors unset) surfaces the failure as a conversation error
		// event on the stream, not just a thrown rejection.
		expect(writer.write).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "data-conversation-event",
				data: expect.objectContaining({
					payload: expect.objectContaining({ type: "error" }),
				}),
			}),
		);
	});

	it("re-throws but stays silent under emitErrors:false (the caller recovers)", async () => {
		mockStreamText().mockReturnValue(
			streamResult({ fullStream: throwingStream() }),
		);

		await expect(
			ctx.extractDocumentStructured({
				system: "extract",
				prompt: "body",
				schema,
				label: "attachment-txt",
				emitErrors: false,
			}),
		).rejects.toThrow("gemini down");

		// emitErrors:false logs but does NOT surface a user-facing error event — the
		// attachment pipeline owns the recovery (inlining the raw document).
		expect(writer.write).not.toHaveBeenCalled();
	});
});
