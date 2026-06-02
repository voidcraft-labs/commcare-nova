// lib/agent/__tests__/generationContext-generatePlainText.test.ts
//
// Unit tests for `GenerationContext.generatePlainText` — the text-in/text-out
// condense sub-generation that every text/office attachment (the common case)
// flows through. We mock `generateText` at the module boundary to assert the
// wrapper plumbing (prompt shape, usage tracking, and the finishReason→truncated
// derivation), not the network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationContext } from "../generationContext";
import { makeTestContext } from "./fixtures";

vi.mock("ai", async (orig) => {
	const actual = await orig<typeof import("ai")>();
	return { ...actual, generateText: vi.fn() };
});

import * as aiSdk from "ai";

const mockGenerateText = () =>
	aiSdk.generateText as unknown as ReturnType<typeof vi.fn>;

describe("GenerationContext.generatePlainText", () => {
	let ctx: GenerationContext;

	beforeEach(() => {
		mockGenerateText().mockReset();
		ctx = makeTestContext().ctx;
	});

	it("passes the text prompt through and reports a clean finish as not truncated", async () => {
		mockGenerateText().mockResolvedValue({
			text: "EXTRACTED",
			usage: { inputTokens: 10, outputTokens: 5 },
			warnings: [],
			finishReason: "stop",
		});

		const out = await ctx.generatePlainText({
			system: "extract",
			prompt: "the document body",
			label: "attachment-txt",
			model: "claude-haiku-4-5-20251001",
			maxOutputTokens: 4096,
		});

		expect(out.text).toBe("EXTRACTED");
		expect(out.truncated).toBe(false);

		// System prompt, the decoded text prompt, and the output cap pass through.
		const call = mockGenerateText().mock.calls[0][0];
		expect(call.system).toBe("extract");
		expect(call.prompt).toBe("the document body");
		expect(call.maxOutputTokens).toBe(4096);
	});

	it("flags truncation when the model hits the output ceiling", async () => {
		mockGenerateText().mockResolvedValue({
			text: "PARTIAL",
			usage: { inputTokens: 10, outputTokens: 4096 },
			warnings: [],
			finishReason: "length",
		});

		const out = await ctx.generatePlainText({
			system: "extract",
			prompt: "a very long document body",
			label: "attachment-txt",
			maxOutputTokens: 4096,
		});

		// `finishReason: "length"` = chopped at the cap; the caller must surface it.
		expect(out.text).toBe("PARTIAL");
		expect(out.truncated).toBe(true);
	});

	it("re-throws on model failure so callers can fall back", async () => {
		mockGenerateText().mockRejectedValue(new Error("haiku down"));

		await expect(
			ctx.generatePlainText({
				system: "extract",
				prompt: "body",
				label: "attachment-txt",
			}),
		).rejects.toThrow("haiku down");
	});
});
