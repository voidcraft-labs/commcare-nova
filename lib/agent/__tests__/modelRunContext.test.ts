/**
 * The shared structured-call adapter (`runStructuredWith`): every call
 * streams, stamps the non-strict structured-output option, and meters
 * usage — success or not. Pinned at the `streamText` seam (the same mock
 * discipline as `subGeneration.test.ts`); the wire-level truth of these
 * options is pinned in `designGenerationContextWire.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", () => {
	class NoObjectGeneratedError extends Error {
		static isInstance(e: unknown): e is NoObjectGeneratedError {
			return e instanceof NoObjectGeneratedError;
		}
	}
	return {
		streamText: streamTextMock,
		Output: { object: (cfg: unknown) => cfg },
		NoObjectGeneratedError,
	};
});

import { runStructuredWith } from "../modelRunContext";

async function* streamOf(parts: { type: string; text?: string }[]) {
	for (const p of parts) yield p;
}

const SCHEMA = z.object({ answer: z.string() });

describe("runStructuredWith", () => {
	it("streams, returns the parsed object, meters usage, and stamps strictJsonSchema:false over caller options", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([{ type: "text-delta", text: '{"answer":"yes"}' }]),
			output: Promise.resolve({ answer: "yes" }),
			usage: Promise.resolve({ inputTokens: 11, outputTokens: 7 }),
			warnings: Promise.resolve([]),
			finishReason: Promise.resolve("stop"),
		});
		const tracked: unknown[] = [];

		const result = await runStructuredWith(
			"mock-model",
			{
				schema: SCHEMA,
				modelId: "mock-model",
				system: "s",
				prompt: "p",
				maxOutputTokens: 500,
				providerOptions: { openai: { reasoningEffort: "high" } },
				signal: new AbortController().signal,
			},
			(usage) => tracked.push(usage),
		);

		expect(result.object).toEqual({ answer: "yes" });
		expect(tracked).toEqual([{ inputTokens: 11, outputTokens: 7 }]);
		const call = streamTextMock.mock.calls[0]?.[0] as {
			providerOptions?: { openai?: Record<string, unknown> };
		};
		// The seam owns the stance; caller options survive beside it.
		expect(call.providerOptions?.openai?.strictJsonSchema).toBe(false);
		expect(call.providerOptions?.openai?.reasoningEffort).toBe("high");
	});

	it("meters usage even when the model produced no parseable object", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([{ type: "text-delta", text: "not json" }]),
			output: Promise.reject(new Error("no valid object")),
			usage: Promise.resolve({ inputTokens: 3, outputTokens: 2 }),
			warnings: Promise.resolve(undefined),
			finishReason: Promise.resolve("length"),
		});
		const tracked: unknown[] = [];

		const result = await runStructuredWith(
			"mock-model",
			{
				schema: SCHEMA,
				modelId: "mock-model",
				system: "s",
				prompt: "p",
				maxOutputTokens: 500,
				signal: new AbortController().signal,
			},
			(usage) => tracked.push(usage),
		);

		expect(result.object).toBeNull();
		expect(result.finishReason).toBe("length");
		expect(tracked).toEqual([{ inputTokens: 3, outputTokens: 2 }]);
	});
});
