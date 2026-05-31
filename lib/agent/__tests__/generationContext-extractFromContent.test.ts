// lib/agent/__tests__/generationContext-extractFromContent.test.ts
//
// Unit tests for `GenerationContext.extractFromContent` — the multimodal
// sibling of `generatePlainText`. The method sends a text instruction plus a
// single file content block (e.g. a PDF document block) to the model and
// returns plain text, threading usage through the shared accumulator.
//
// We mock `generateText` at the module boundary so these tests assert the
// wrapper plumbing (content-part shape, usage tracking, return passthrough),
// not the network. The real `UsageAccumulator` is exercised so the
// `trackSubGeneration` fan-in is verified end-to-end.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationContext } from "../generationContext";
import { makeTestContext } from "./fixtures";

// Mock `generateText` so we assert the wrapper plumbing, not the network.
// `orig` preserves every other `ai` export the context module imports
// (`Output`, `streamText`, the type guards) so only the one call is stubbed.
vi.mock("ai", async (orig) => {
	const actual = await orig<typeof import("ai")>();
	return { ...actual, generateText: vi.fn() };
});

import * as aiSdk from "ai";

/** Narrow the module-level `generateText` mock to the vi.fn surface. */
const mockGenerateText = () =>
	aiSdk.generateText as unknown as ReturnType<typeof vi.fn>;

describe("GenerationContext.extractFromContent", () => {
	let ctx: GenerationContext;

	beforeEach(() => {
		mockGenerateText().mockReset();
		ctx = makeTestContext().ctx;
	});

	it("sends a multimodal user message and tracks usage", async () => {
		mockGenerateText().mockResolvedValue({
			text: "EXTRACTED",
			usage: { inputTokens: 10, outputTokens: 5 },
			warnings: [],
		});

		const out = await ctx.extractFromContent({
			system: "extract",
			instruction: "Extract requirements.",
			file: {
				mediaType: "application/pdf",
				data: "data:application/pdf;base64,AAAA",
			},
			label: "attachment-pdf",
			model: "claude-haiku-4-5-20251001",
			maxOutputTokens: 4096,
		});

		// Return value flows straight through from the model result.
		expect(out).toBe("EXTRACTED");

		// The user turn carries the instruction text followed by the file
		// content block — the document block the provider turns into a native
		// PDF block for Anthropic.
		const call = mockGenerateText().mock.calls[0][0];
		expect(call.messages[0].role).toBe("user");
		expect(call.messages[0].content).toEqual([
			{ type: "text", text: "Extract requirements." },
			{
				type: "file",
				data: "data:application/pdf;base64,AAAA",
				mediaType: "application/pdf",
			},
		]);
		// System prompt + output cap are passed through verbatim.
		expect(call.system).toBe("extract");
		expect(call.maxOutputTokens).toBe(4096);
	});

	it("re-throws on model failure so callers can fall back (and emits an error event)", async () => {
		mockGenerateText().mockRejectedValue(new Error("haiku down"));

		await expect(
			ctx.extractFromContent({
				system: "extract",
				instruction: "Extract requirements.",
				file: {
					mediaType: "application/pdf",
					data: "data:application/pdf;base64,AAAA",
				},
				label: "attachment-pdf",
			}),
		).rejects.toThrow("haiku down");
	});
});
