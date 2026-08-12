/** The executor carries Nova's complete cache triple on every model step. */

import type { LanguageModel, ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return { ...actual, generateText: generateTextMock };
});

import { productionExecutorStep } from "@/lib/agent/build/executorLoop";

describe("productionExecutorStep cache configuration", () => {
	beforeEach(() => {
		generateTextMock.mockReset();
		generateTextMock.mockResolvedValue({
			toolCalls: [],
			text: "",
			reasoningText: undefined,
			usage: undefined,
			responseMessages: [],
		});
	});

	it("pairs the per-session key and options with the unchanged message prefix", async () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "accepted slice brief" }],
			},
		];
		const step = productionExecutorStep(
			{} as LanguageModel,
			"high",
			"nova:design-executor:session-1",
		);
		await step({
			system: "static executor",
			messages,
			tools: {},
			signal: new AbortController().signal,
		});

		const request = generateTextMock.mock.calls[0]?.[0];
		expect(request.providerOptions.openai).toMatchObject({
			store: false,
			reasoningEffort: "high",
			reasoningSummary: "auto",
			promptCacheKey: "nova:design-executor:session-1",
			promptCacheOptions: { mode: "implicit", ttl: "30m" },
			parallelToolCalls: false,
		});
		expect(request.messages).toEqual(messages);
		expect(JSON.stringify(request.messages)).not.toContain(
			"promptCacheBreakpoint",
		);
	});
});
