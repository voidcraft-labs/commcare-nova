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
});
