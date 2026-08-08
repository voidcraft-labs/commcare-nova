/**
 * The shared structured-call adapter (`runStructuredWith`): every call
 * streams, ships the STRICT wire projection of its Zod schema (grammar
 * enforcement on the provider; Zod stays the SDK-side gate), and meters
 * usage — success or not. Pinned at the `streamText` seam (the same mock
 * discipline as `subGeneration.test.ts`); the wire-level truth is pinned
 * in `designGenerationContextWire.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
	// `jsonSchema`/`zodSchema` stay REAL: the strict projection under test
	// is built with them. Only the generation entry points are scripted.
	const actual = await importOriginal<typeof import("ai")>();
	class NoObjectGeneratedError extends Error {
		static isInstance(e: unknown): e is NoObjectGeneratedError {
			return e instanceof NoObjectGeneratedError;
		}
	}
	return {
		...actual,
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
	it("streams, returns the parsed object, meters usage, and ships the strict wire projection", async () => {
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
			output?: { schema?: { jsonSchema?: Record<string, unknown> } };
			providerOptions?: { openai?: Record<string, unknown> };
		};
		// Caller options pass through untouched — strictness is the schema's.
		expect(call.providerOptions?.openai?.strictJsonSchema).toBeUndefined();
		expect(call.providerOptions?.openai?.reasoningEffort).toBe("high");
		// The schema handed to the SDK is the strict PROJECTION, not raw zod:
		// a jsonSchema-backed Schema whose object requires every key.
		const wire = call.output?.schema?.jsonSchema as
			| { required?: string[]; additionalProperties?: boolean }
			| undefined;
		expect(wire?.additionalProperties).toBe(false);
		expect(wire?.required).toEqual(["answer"]);
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
