// lib/agent/__tests__/generationContext-extractDocumentStructured.test.ts
//
// Unit tests for `GenerationContext.extractDocumentStructured` — the ONE
// structured call the document extractor makes. It fills { extract, title,
// summary } from either a decoded text `prompt` (text/docx/xlsx) or a native
// `file` block (PDF). We mock `generateObject` at the module boundary to assert
// the wrapper plumbing (input shape, schema pass-through, usage tracking, the
// finishReason→truncated derivation, and the error-emission/re-throw contract)
// WITHOUT a network call. The real `UsageAccumulator` is exercised so the
// `trackSubGeneration` fan-in is verified end-to-end.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GenerationContext } from "../generationContext";
import { makeTestContext } from "./fixtures";

// Mock `generateObject` so we assert the wrapper plumbing, not the network.
// `orig` preserves every other `ai` export the context module imports.
vi.mock("ai", async (orig) => {
	const actual = await orig<typeof import("ai")>();
	return { ...actual, generateObject: vi.fn() };
});

import * as aiSdk from "ai";

/** Narrow the module-level `generateObject` mock to the vi.fn surface. */
const mockGenerateObject = () =>
	aiSdk.generateObject as unknown as ReturnType<typeof vi.fn>;

/** The { extract, title, summary } schema the extractor fills — extract first. */
const schema = z.object({
	extract: z.string(),
	title: z.string(),
	summary: z.string(),
});
const OBJECT = { extract: "EXTRACT", title: "Title", summary: "Summary." };

describe("GenerationContext.extractDocumentStructured", () => {
	let ctx: GenerationContext;
	// The real accumulator + the SSE writer stub — to assert the usage fan-in and
	// the error-event emission.
	let usage: ReturnType<typeof makeTestContext>["usage"];
	let writer: ReturnType<typeof makeTestContext>["writer"];

	beforeEach(() => {
		mockGenerateObject().mockReset();
		({ ctx, usage, writer } = makeTestContext());
	});

	it("sends a text prompt + schema and tracks usage (clean finish = not truncated)", async () => {
		mockGenerateObject().mockResolvedValue({
			object: OBJECT,
			usage: { inputTokens: 10, outputTokens: 5 },
			warnings: [],
			finishReason: "stop",
		});

		const out = await ctx.extractDocumentStructured({
			system: "extract",
			prompt: "the document body",
			schema,
			label: "attachment-txt",
			model: "claude-haiku-4-5-20251001",
			maxOutputTokens: 4096,
		});

		expect(out).toEqual({ object: OBJECT, truncated: false });

		// System prompt, the decoded text prompt, the schema, and the output cap
		// pass through; no `messages` (that's the file path).
		const call = mockGenerateObject().mock.calls[0][0];
		expect(call.system).toBe("extract");
		expect(call.prompt).toBe("the document body");
		expect(call.schema).toBe(schema);
		expect(call.maxOutputTokens).toBe(4096);
		expect(call.messages).toBeUndefined();

		// The mocked usage fans into the shared accumulator (the method's own return
		// omits usage, so the snapshot is the only place to observe trackSubGeneration).
		expect(usage.snapshot().inputTokens).toBe(10);
		expect(usage.snapshot().outputTokens).toBe(5);
	});

	it("sends a PDF as a native file block in a user message (no text prompt)", async () => {
		mockGenerateObject().mockResolvedValue({
			object: OBJECT,
			usage: { inputTokens: 10, outputTokens: 5 },
			warnings: [],
			finishReason: "stop",
		});

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
		const call = mockGenerateObject().mock.calls[0][0];
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
		mockGenerateObject().mockResolvedValue({
			object: OBJECT,
			usage: { inputTokens: 10, outputTokens: 4096 },
			warnings: [],
			finishReason: "length",
		});

		const out = await ctx.extractDocumentStructured({
			system: "extract",
			prompt: "a very long document body",
			schema,
			label: "attachment-txt",
		});
		expect(out.truncated).toBe(true);
	});

	it("re-throws on model failure AND emits an error event by default", async () => {
		mockGenerateObject().mockRejectedValue(new Error("gemini down"));

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
		mockGenerateObject().mockRejectedValue(new Error("gemini down"));

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
