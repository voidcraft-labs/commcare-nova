/** The executor carries Nova's complete cache triple and the server-side
 * compaction config on every model step, streamed with blocking semantics. */

import type { LanguageModel, ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_COMPACTION_THRESHOLD } from "@/lib/models";

const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return { ...actual, streamText: streamTextMock };
});

import { productionExecutorStep } from "@/lib/agent/build/executorLoop";

describe("productionExecutorStep cache configuration", () => {
	beforeEach(() => {
		streamTextMock.mockReset();
		streamTextMock.mockImplementation(() => ({
			stream: (async function* () {})(),
			toolCalls: Promise.resolve([]),
			text: Promise.resolve(""),
			reasoningText: Promise.resolve(undefined),
			usage: Promise.resolve(undefined),
			responseMessages: Promise.resolve([]),
		}));
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
			allowedTools: ["searchBlueprint", "finishWorkflow"],
			signal: new AbortController().signal,
		});

		const request = streamTextMock.mock.calls[0]?.[0];
		expect(request.providerOptions.openai).toMatchObject({
			store: false,
			contextManagement: [
				{ type: "compaction", compactThreshold: OPENAI_COMPACTION_THRESHOLD },
			],
			reasoningEffort: "high",
			reasoningSummary: "auto",
			promptCacheKey: "nova:design-executor:session-1",
			promptCacheOptions: { mode: "implicit", ttl: "30m" },
			parallelToolCalls: true,
			allowedTools: {
				toolNames: ["searchBlueprint", "finishWorkflow"],
				mode: "auto",
			},
		});
		expect(request.messages).toEqual(messages);
		expect(JSON.stringify(request.messages)).not.toContain(
			"promptCacheBreakpoint",
		);
	});

	it("drains the stream and returns the settled aggregates", async () => {
		let drained = false;
		streamTextMock.mockImplementation(() => ({
			stream: (async function* () {
				yield { type: "text-delta", text: "working" };
				drained = true;
			})(),
			toolCalls: Promise.resolve([
				{ toolCallId: "call-1", toolName: "searchBlueprint", input: {} },
			]),
			text: Promise.resolve("done"),
			reasoningText: Promise.resolve("thought"),
			usage: Promise.resolve(undefined),
			responseMessages: Promise.resolve([]),
		}));
		const step = productionExecutorStep({} as LanguageModel);
		const outcome = await step({
			system: "static executor",
			messages: [],
			tools: {},
			signal: new AbortController().signal,
		});

		expect(drained).toBe(true);
		expect(outcome).toEqual({
			toolCalls: [
				{ toolCallId: "call-1", toolName: "searchBlueprint", input: {} },
			],
			text: "done",
			reasoningText: "thought",
			usage: undefined,
			responseMessages: [],
		});
	});

	it("refuses to construct the stream for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const step = productionExecutorStep({} as LanguageModel);
		await expect(
			step({
				system: "static executor",
				messages: [],
				tools: {},
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(streamTextMock).not.toHaveBeenCalled();
	});
});
