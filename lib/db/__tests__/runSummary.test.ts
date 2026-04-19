/**
 * Round-trips a RunSummaryDoc through the Zod schema. The Firestore write
 * path is fire-and-forget; we only validate shape here, not network.
 */
import { describe, expect, it } from "vitest";
import { runSummaryDocSchema } from "../types";

describe("runSummaryDocSchema", () => {
	const sample = {
		runId: "run-abc",
		startedAt: "2026-04-18T12:00:00.000Z",
		finishedAt: "2026-04-18T12:01:30.000Z",
		promptMode: "build" as const,
		freshEdit: false,
		appReady: false,
		cacheExpired: false,
		moduleCount: 0,
		stepCount: 7,
		model: "claude-opus-4-7",
		inputTokens: 1234,
		outputTokens: 567,
		cacheReadTokens: 891,
		cacheWriteTokens: 0,
		costEstimate: 0.0421,
		toolCallCount: 14,
	};

	it("parses a populated summary", () => {
		expect(runSummaryDocSchema.parse(sample)).toEqual(sample);
	});

	it("rejects missing required fields", () => {
		const { costEstimate: _c, ...partial } = sample;
		expect(() => runSummaryDocSchema.parse(partial)).toThrow();
	});

	it("accepts zero-valued token counts and cost", () => {
		expect(
			runSummaryDocSchema.parse({
				...sample,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costEstimate: 0,
			}),
		).toBeDefined();
	});

	it("rejects negative token counts", () => {
		expect(() =>
			runSummaryDocSchema.parse({ ...sample, inputTokens: -1 }),
		).toThrow();
	});

	it("rejects non-integer token counts", () => {
		expect(() =>
			runSummaryDocSchema.parse({ ...sample, inputTokens: 1.5 }),
		).toThrow();
	});

	it("rejects unknown promptMode values", () => {
		expect(() =>
			runSummaryDocSchema.parse({ ...sample, promptMode: "foo" }),
		).toThrow();
	});
});
