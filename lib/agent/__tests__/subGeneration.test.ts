/**
 * Unit tests for the structured sub-generation cores: `streamObjectWith` (the
 * streaming path — per-chunk `onProgress` fed from BOTH reasoning and output
 * deltas, the final-object-only result, the output-failure → null mapping) and
 * `generateObjectWith` (the blocking twin, whose input wiring must not drift
 * from the streaming path's — its only production-adjacent caller is the paid
 * preview script, so drift would ship silently without these).
 *
 * The AI SDK's `streamText` / `generateObject` are mocked at the import
 * boundary so no model runs.
 */

import type { LanguageModelUsage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// A minimal usage value cast to the SDK type — `streamText` is mocked at runtime,
// but tsc still checks `new NoObjectGeneratedError({ usage })` against the real
// `LanguageModelUsage` shape.
const USAGE = {
	inputTokens: 1,
	outputTokens: 0,
} as unknown as LanguageModelUsage;

const { streamTextMock, generateObjectMock } = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
	generateObjectMock: vi.fn(),
}));

// Mock the SDK: `streamText`/`generateObject` are driven per test; `Output.object`
// is a passthrough (the mocked streamText ignores it); `NoObjectGeneratedError` is
// a real class so the production `isInstance` check (and our `new …()` here) agree.
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
		streamText: streamTextMock,
		generateObject: generateObjectMock,
		Output: { object: (cfg: unknown) => cfg },
		NoObjectGeneratedError,
	};
});

import { NoObjectGeneratedError } from "ai";
import { generateObjectWith, streamObjectWith } from "../subGeneration";

type StreamPart = { type: string; text?: string };

/** An async-iterable `stream` from a fixed part list. */
async function* streamOf(parts: StreamPart[]) {
	for (const p of parts) yield p;
}

// `streamText` is mocked and ignores the model; a string is a valid
// `LanguageModel` (a model id) so the call type-checks without a real provider.
const MODEL = "mock-model";
const SCHEMA = z.object({ x: z.number() });

beforeEach(() => vi.clearAllMocks());

describe("streamObjectWith", () => {
	it("feeds onProgress from BOTH reasoning and output deltas, returns the final object + usage", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([
				{ type: "reasoning-start" }, // ignored (no text)
				{ type: "reasoning-delta", text: "abc" }, // 3
				{ type: "text-start" }, // ignored
				{ type: "text-delta", text: "de" }, // 2
				{ type: "finish" }, // ignored
			]),
			output: Promise.resolve({ x: 1 }),
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

		// Reasoning delta (3) THEN output delta (2) — thinking progress counts too.
		expect(onProgress.mock.calls).toEqual([[3], [2]]);
		expect(result.object).toEqual({ x: 1 });
		expect(result.finishReason).toBe("stop");
		expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
	});

	it("maps an output failure to a null object, surfacing usage + finishReason", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([{ type: "text-delta", text: "truncated" }]),
			// Truncation / malformed / invalid object → `output` rejects.
			output: Promise.reject(new Error("no valid object")),
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

		// No salvage; the caller still meters tokens + detects truncation. usage and
		// finishReason come from the (settled) stream, not the rejected output.
		expect(result.object).toBeNull();
		expect(result.finishReason).toBe("length");
		expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 0 });
	});

	it("maps a NoObjectGeneratedError thrown from the stream to a null object", async () => {
		// Defensive path: a NoObjectGeneratedError surfaced as a stream throw (rather
		// than an output rejection) still maps to null, surfacing the error's usage.
		async function* boom(): AsyncGenerator<StreamPart> {
			yield* [];
			// The runtime class is mocked and ignores its arg; cast past the real SDK
			// constructor's required fields — only usage/finishReason are read.
			throw new NoObjectGeneratedError({
				usage: USAGE,
				finishReason: "length",
			} as never);
		}
		streamTextMock.mockReturnValue({
			stream: boom(),
			output: Promise.reject(new Error("obj")),
			usage: Promise.reject(new Error("u")),
			warnings: Promise.reject(new Error("w")),
			finishReason: Promise.reject(new Error("f")),
		});

		const result = await streamObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "p",
		});

		expect(result.object).toBeNull();
		expect(result.finishReason).toBe("length");
	});

	it("re-throws a stream-stopping error and observes the (rejecting) result promises", async () => {
		// A real transport failure: the stream throws AND the result promises reject.
		// streamObjectWith must re-throw the stream error; vitest fails the run on any
		// unhandled rejection, so a clean pass proves all four were observed.
		async function* boom(): AsyncGenerator<StreamPart> {
			yield* [];
			throw new Error("transport exploded");
		}
		streamTextMock.mockReturnValue({
			stream: boom(),
			output: Promise.reject(new Error("object rejected")),
			usage: Promise.reject(new Error("usage rejected")),
			warnings: Promise.reject(new Error("warnings rejected")),
			finishReason: Promise.reject(new Error("finishReason rejected")),
		});

		await expect(
			streamObjectWith({
				model: MODEL,
				system: "s",
				schema: SCHEMA,
				prompt: "p",
			}),
		).rejects.toThrow("transport exploded");
	});

	it("never lets a throwing onProgress break the drain (best-effort progress)", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([
				{ type: "text-delta", text: "ab" },
				{ type: "text-delta", text: "cd" },
			]),
			output: Promise.resolve({ x: 7 }),
			usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
			warnings: Promise.resolve([]),
			finishReason: Promise.resolve("stop"),
		});

		const result = await streamObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "p",
			onProgress: () => {
				throw new Error("write to a disconnected client");
			},
		});

		// The throwing callback is swallowed; the extraction still completes.
		expect(result.object).toEqual({ x: 7 });
	});

	it("attaches images beside the prompt as labeled file parts in one user message", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([{ type: "text-delta", text: "x" }]),
			output: Promise.resolve({ x: 1 }),
			usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
			warnings: Promise.resolve([]),
			finishReason: Promise.resolve("stop"),
		});

		await streamObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "doc text",
			images: [
				{
					mediaType: "image/png",
					data: "data:image/png;base64,AAA",
					label: '<nova:figure index="1"/>',
				},
				// No label: the image part rides alone.
				{ mediaType: "image/jpeg", data: "data:image/jpeg;base64,BBB" },
			],
		});

		// The document text leads; each labeled image is preceded by its label
		// text part; an unlabeled image rides bare. No top-level `prompt`.
		const call = streamTextMock.mock.calls[0][0];
		expect(call.prompt).toBeUndefined();
		expect(call.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "doc text" },
					{ type: "text", text: '<nova:figure index="1"/>' },
					{
						type: "file",
						data: "data:image/png;base64,AAA",
						mediaType: "image/png",
					},
					{
						type: "file",
						data: "data:image/jpeg;base64,BBB",
						mediaType: "image/jpeg",
					},
				],
			},
		]);
	});

	it("sends a bare prompt as one user message with one text part (no images)", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([]),
			output: Promise.resolve({ x: 1 }),
			usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
			warnings: Promise.resolve([]),
			finishReason: Promise.resolve("stop"),
		});

		await streamObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "p",
			images: [],
		});

		// One messages form for text-with-optional-images: a bare string prompt is
		// wire-identical to this shape, so there is deliberately no third branch.
		const call = streamTextMock.mock.calls[0][0];
		expect(call.prompt).toBeUndefined();
		expect(call.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "p" }] },
		]);
	});

	it("drives generation with no onProgress (drains the stream, returns the object)", async () => {
		streamTextMock.mockReturnValue({
			stream: streamOf([{ type: "text-delta", text: "x" }]),
			output: Promise.resolve({ x: 9 }),
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

describe("generateObjectWith", () => {
	const RESULT = {
		object: { x: 1 },
		usage: { inputTokens: 2, outputTokens: 3 },
		warnings: [],
		finishReason: "stop",
	};

	it("attaches images beside the prompt exactly like the streaming path", async () => {
		generateObjectMock.mockResolvedValue(RESULT);

		const result = await generateObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "doc text",
			images: [
				{
					mediaType: "image/png",
					data: "data:image/png;base64,AAA",
					label: '<nova:figure index="1"/>',
				},
			],
		});

		expect(result.object).toEqual({ x: 1 });
		const call = generateObjectMock.mock.calls[0][0];
		expect(call.prompt).toBeUndefined();
		expect(call.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "doc text" },
					{ type: "text", text: '<nova:figure index="1"/>' },
					{
						type: "file",
						data: "data:image/png;base64,AAA",
						mediaType: "image/png",
					},
				],
			},
		]);
	});

	it("sends a bare prompt as one user message with one text part", async () => {
		generateObjectMock.mockResolvedValue(RESULT);

		await generateObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			prompt: "p",
		});

		const call = generateObjectMock.mock.calls[0][0];
		expect(call.prompt).toBeUndefined();
		expect(call.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "p" }] },
		]);
	});

	it("gives a native file block precedence over images", async () => {
		generateObjectMock.mockResolvedValue(RESULT);

		await generateObjectWith({
			model: MODEL,
			system: "s",
			schema: SCHEMA,
			file: {
				mediaType: "application/pdf",
				data: "data:application/pdf;base64,BB",
			},
			instruction: "Extract.",
			images: [{ mediaType: "image/png", data: "data:image/png;base64,AAA" }],
		});

		// A `file` document carries its own images natively; `images` is ignored.
		const call = generateObjectMock.mock.calls[0][0];
		expect(call.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Extract." },
					{
						type: "file",
						data: "data:application/pdf;base64,BB",
						mediaType: "application/pdf",
					},
				],
			},
		]);
	});
});
