import { describe, expect, it } from "vitest";
import { normalizeRecordedUsage } from "../recorded";

describe("normalizeRecordedUsage", () => {
	it("returns null for a step with no usage", () => {
		expect(normalizeRecordedUsage(null)).toBeNull();
	});

	it("reads the AI SDK's nested token details", () => {
		expect(
			normalizeRecordedUsage({
				inputTokens: 1200,
				outputTokens: 80,
				totalTokens: 1280,
				inputTokenDetails: { cacheReadTokens: 1000, noCacheTokens: 200 },
				outputTokenDetails: { reasoningTokens: 30, textTokens: 50 },
			}),
		).toEqual({
			inputTokens: 1200,
			outputTokens: 80,
			totalTokens: 1280,
			cachedInputTokens: 1000,
			reasoningTokens: 30,
		});
	});

	it("reads the flat cached and reasoning fields when present", () => {
		expect(
			normalizeRecordedUsage({
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				cachedInputTokens: 4,
				reasoningTokens: 2,
			}),
		).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			cachedInputTokens: 4,
			reasoningTokens: 2,
		});
	});

	it("reports non-numeric or absent counts as null rather than zero", () => {
		expect(
			normalizeRecordedUsage({
				inputTokens: "12",
				outputTokens: Number.NaN,
				inputTokenDetails: { cacheReadTokens: null },
			}),
		).toEqual({
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
			cachedInputTokens: null,
			reasoningTokens: null,
		});
	});
});
