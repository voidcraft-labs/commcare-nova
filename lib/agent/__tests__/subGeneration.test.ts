/**
 * Unit tests for `streamObjectWith` — the streaming structured-generation core.
 *
 * The AI SDK's `streamObject` is mocked at the import boundary so no model runs:
 * we drive a fake text stream + result promises and assert the two things the
 * streaming path adds over the blocking `generateObjectWith` — per-chunk
 * `onProgress` (character counts) and the same final-object-only result, including
 * the `NoObjectGeneratedError → null` mapping (a structured call has no partial to
 * salvage).
 */

import type { LanguageModelUsage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// A minimal usage value cast to the SDK type — `streamObject` is mocked at
// runtime, but tsc still checks `new NoObjectGeneratedError({ usage })` against
// the real `LanguageModelUsage` shape.
const USAGE = {
	inputTokens: 1,
	outputTokens: 0,
} as unknown as LanguageModelUsage;

const { streamObjectMock } = vi.hoisted(() => ({ streamObjectMock: vi.fn() }));

// Mock the SDK: `streamObject` is driven per test; `NoObjectGeneratedError` is a
// real class so the production `isInstance` check (and our `new …()` here) agree.
vi.mock("ai", () => {
	class NoObjectGeneratedError extends Error {
		usage: unknown;
		finishReason: string | undefined;
		constructor(opts?: { usage?: unknown; finishReason?: string }) {
			super("no object generated");
			this.usage = opts?.usage;
			this.finishReason = opts?.finishReason;
		}
		static isInstance(e: unknown): e is NoObjectGeneratedError {
			return e instanceof NoObjectGeneratedError;
		}
	}
	return {
		streamObject: streamObjectMock,
		generateObject: vi.fn(),
		NoObjectGeneratedError,
	};
});

import { NoObjectGeneratedError } from "ai";
import { streamObjectWith } from "../subGeneration";

/** An async-iterable text stream from a fixed chunk list. */
async function* textChunks(parts: string[]) {
	for (const p of parts) yield p;
}

// `streamObject` is mocked and ignores the model; a string is a valid
// `LanguageModel` (a model id) so the call type-checks without a real provider.
const MODEL = "mock-model";
const SCHEMA = z.object({ x: z.number() });

beforeEach(() => vi.clearAllMocks());

describe("streamObjectWith", () => {
	it("fires onProgress per text chunk and returns the final object + usage", async () => {
		streamObjectMock.mockReturnValue({
			textStream: textChunks(["abc", "de"]),
			object: Promise.resolve({ x: 1 }),
			usage: Promise.resolve({ inputTokens: 3, outputTokens: 4 }),
			warnings: Promise.resolve([]),
			finishReason: Promise.resolve("stop"),
		});
		const onProgress = vi.fn();

		const result = await streamObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "p",
			onProgress,
		});

		// One call per chunk, each with that chunk's character count.
		expect(onProgress.mock.calls).toEqual([[3], [2]]);
		expect(result.object).toEqual({ x: 1 });
		expect(result.finishReason).toBe("stop");
		expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
	});

	it("maps NoObjectGeneratedError to a null object, surfacing usage + finishReason", async () => {
		// The runtime class is mocked and ignores its arg; cast past the real SDK
		// constructor's required `response`/etc. — only `usage`/`finishReason` matter
		// to the code under test (it reads them off the caught error).
		const err = new NoObjectGeneratedError({
			usage: USAGE,
			finishReason: "length",
		} as never);
		streamObjectMock.mockReturnValue({
			textStream: textChunks(["truncated"]),
			object: Promise.reject(err),
			usage: Promise.resolve(USAGE),
			warnings: Promise.resolve(undefined),
			finishReason: Promise.resolve("length"),
		});

		const result = await streamObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "p",
		});

		// Truncation / malformed output → no salvage; the caller still meters tokens
		// and can detect truncation via finishReason.
		expect(result.object).toBeNull();
		expect(result.finishReason).toBe("length");
		expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 0 });
	});

	it("drives generation with no onProgress (drains the stream, returns the object)", async () => {
		streamObjectMock.mockReturnValue({
			textStream: textChunks(["x"]),
			object: Promise.resolve({ x: 9 }),
			usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
			warnings: Promise.resolve([]),
			finishReason: Promise.resolve("stop"),
		});

		const result = await streamObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "p",
		});

		expect(result.object).toEqual({ x: 9 });
	});
});
