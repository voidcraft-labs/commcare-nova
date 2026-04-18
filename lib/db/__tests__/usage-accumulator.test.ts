/**
 * UsageAccumulator — in-memory per-request token + cost totals.
 *
 * The accumulator owns two write targets on flush():
 * - `incrementUsage()` for the monthly spend cap (skipped on zero cost).
 * - `writeRunSummary()` for the per-run admin inspect summary doc.
 *
 * Both collaborators are mocked here so the tests stay unit-scoped — we
 * verify the accumulator's accounting + flush orchestration without
 * touching Firestore. `vi.mock` factories run before the import below,
 * so the imported `UsageAccumulator` sees the mocked `incrementUsage`
 * and `writeRunSummary` at flush time.
 */
import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above imports by Vitest, so any identifiers referenced
// inside the factory must be hoisted too — vi.hoisted lifts a block of setup
// alongside the mock calls. Without this, the mock factory runs before the
// top-level `const` bindings exist and throws a ReferenceError on load.
const { writeRunSummaryMock } = vi.hoisted(() => ({
	writeRunSummaryMock: vi.fn(),
}));

// Run summary writer is fire-and-forget in prod — mock it outright so
// the idempotence + zero-cost tests can count invocations.
vi.mock("../runSummary", () => ({
	writeRunSummary: writeRunSummaryMock,
}));

// Mock Firestore at the adapter boundary — `incrementUsage` lives in the
// same module as `UsageAccumulator`, so a module-level vi.mock can't
// intercept an intra-module call. Stubbing `docs.usage(...).set` instead
// keeps the real incrementUsage in play (fail-closed behavior untouched)
// while swallowing the network write.
const setMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../firestore", () => ({
	docs: {
		usage: () => ({ set: setMock }),
	},
}));

import { UsageAccumulator } from "../usage";

describe("UsageAccumulator", () => {
	it("tracks cumulative tokens + cost across track() calls", () => {
		const acc = new UsageAccumulator({
			appId: "app-1",
			userId: "user-1",
			runId: "run-1",
			model: "claude-opus-4-7",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
		});
		acc.track({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 20,
			cacheWriteTokens: 0,
		});
		acc.track({
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 40,
			cacheWriteTokens: 10,
		});

		const snap = acc.snapshot();
		expect(snap.inputTokens).toBe(300);
		expect(snap.outputTokens).toBe(150);
		expect(snap.cacheReadTokens).toBe(60);
		expect(snap.cacheWriteTokens).toBe(10);
		// Pin the exact cost against Opus 4.7 pricing from @/lib/models
		// (input 5, output 25, cacheRead 0.5, cacheWrite 6.25 per 1M tokens).
		//   uncachedInput = 300 - 60 - 10 = 230
		//   cost = (230*5 + 60*0.5 + 10*6.25 + 150*25) / 1_000_000
		//        = (1150 + 30 + 62.5 + 3750) / 1_000_000
		//        = 4992.5 / 1_000_000 = 0.0049925
		// toBeGreaterThan(0) would silently accept a regression that zeroed
		// any of the four rate terms; exact pinning catches formula drift.
		expect(snap.costEstimate).toBeCloseTo(0.0049925, 10);
	});

	it("stepCount increments on track(...,{step:true}) calls only", () => {
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "claude-opus-4-7",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
		});
		acc.track({ inputTokens: 10, outputTokens: 5 }, { step: true });
		// Sub-gen call inside a tool — accumulates tokens but not step count.
		acc.track({ inputTokens: 5, outputTokens: 2 });
		acc.track({ inputTokens: 10, outputTokens: 5 }, { step: true });
		expect(acc.snapshot().stepCount).toBe(2);
	});

	it("flush() is idempotent", async () => {
		setMock.mockClear();
		writeRunSummaryMock.mockReset();
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "claude-opus-4-7",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
			startedAt: "2026-04-18T12:00:00.000Z",
		});
		acc.track({ inputTokens: 1, outputTokens: 1 }, { step: true });
		await acc.flush();
		await acc.flush();
		// setMock is the real Firestore write inside incrementUsage — one
		// invocation proves the second flush short-circuited before the
		// monthly-usage write ran.
		expect(setMock).toHaveBeenCalledTimes(1);
		expect(writeRunSummaryMock).toHaveBeenCalledTimes(1);
	});

	it("flush() with zero cost skips the monthly increment", async () => {
		setMock.mockClear();
		writeRunSummaryMock.mockReset();
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "claude-opus-4-7",
			promptMode: "edit",
			freshEdit: true,
			appReady: true,
			cacheExpired: true,
			moduleCount: 5,
		});
		await acc.flush();
		// No Firestore set at all — zero-cost runs short-circuit before
		// incrementUsage. request_count would otherwise bump without
		// matching spend.
		expect(setMock).not.toHaveBeenCalled();
		// Run summary still written so the inspect tools see the run at all —
		// admins care about zero-cost replays too (e.g. cache-hit analysis).
		expect(writeRunSummaryMock).toHaveBeenCalledTimes(1);
	});

	it("runId getter returns the seed runId", () => {
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "run-getter-test",
			model: "claude-opus-4-7",
			promptMode: "build",
			freshEdit: false,
			appReady: false,
			cacheExpired: false,
			moduleCount: 0,
		});
		expect(acc.runId).toBe("run-getter-test");
	});
});
