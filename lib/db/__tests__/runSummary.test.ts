import { describe, expect, it, vi } from "vitest";
import { runSummaryDocSchema } from "../types";

vi.mock("../pg", () => ({
	getAppDb: async () => {
		throw new Error("Database unavailable");
	},
	withAppTx: async () => {
		throw new Error("Database unavailable");
	},
}));

describe("runSummaryDocSchema", () => {
	const sample = {
		runId: "run-abc",
		startedAt: "2026-04-18T12:00:00.000Z",
		finishedAt: "2026-04-18T12:01:30.000Z",
		promptMode: "build" as const,
		appReady: false,
		moduleCount: 0,
		stepCount: 7,
		model: "gpt-5.6-sol",
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

it("reports failed accounting without throwing when database access fails", async () => {
	const {
		accrueMonthlyUsageBestEffort,
		writeRunSummary,
		writeRunSummaryWithDurableContributions,
	} = await import("../runSummary");
	const summary = runSummaryDocSchema.parse({
		runId: "run",
		startedAt: "2026-04-20T05:00:00.000Z",
		finishedAt: "2026-04-20T05:01:00.000Z",
		promptMode: "edit",
		appReady: true,
		moduleCount: 3,
		stepCount: 2,
		model: "model",
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheWriteTokens: 100,
		costEstimate: 0.01,
		toolCallCount: 3,
	});
	const target = { kind: "app", appId: "app" } as const;
	await expect(
		accrueMonthlyUsageBestEffort(
			{ userId: "user", period: "2026-04" },
			summary,
		),
	).resolves.toBe(false);
	await expect(writeRunSummary(target, "run", summary)).resolves.toBe("failed");
	await expect(
		writeRunSummaryWithDurableContributions(target, "run", summary, [], {
			userId: "user",
			period: "2026-04",
		}),
	).resolves.toEqual({
		action: "failed",
		admittedContributions: [],
		monthlyUsageAccrued: false,
		runCostEstimate: null,
	});
});
