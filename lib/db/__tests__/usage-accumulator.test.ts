/**
 * UsageAccumulator — in-memory per-request token + cost totals.
 *
 * The accumulator owns two write targets on flush():
 * - `incrementUsage()` for the monthly spend cap (skipped on zero cost).
 * - `writeRunSummary()` for the per-run admin inspect summary doc.
 *
 * `writeRunSummary` and `refundReservation` (separate modules) are mocked so the
 * accounting + flush-orchestration tests stay unit-scoped; the monthly-usage
 * increment (`incrementUsage`, INTRA-module — a module-level mock can't intercept
 * it) runs for real against the per-test `usage_months` table (the app-state
 * harness), so an increment shows up as a real row (`request_count`) rather than a
 * spied `set` call.
 */
import { describe, expect, it, vi } from "vitest";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

// vi.mock is hoisted above imports by Vitest, so any identifiers referenced
// inside the factory must be hoisted too — vi.hoisted lifts a block of setup
// alongside the mock calls. Without this, the mock factory runs before the
// top-level `const` bindings exist and throws a ReferenceError on load.
const { writeRunSummaryMock, refundReservationMock } = vi.hoisted(() => ({
	writeRunSummaryMock: vi.fn(),
	refundReservationMock: vi.fn(),
}));

// Run summary writer is fire-and-forget in prod — mock it outright so
// the idempotence + zero-cost tests can count invocations.
vi.mock("../runSummary", () => ({
	writeRunSummary: writeRunSummaryMock,
}));

// `refundReservation` lives in `../credits` — a SEPARATE module from
// `UsageAccumulator` — so a module-level mock DOES intercept the import that
// `usage.ts` resolves at flush time (unlike `incrementUsage`, which is
// intra-module and can only be observed at the database boundary below). We
// assert on the mock's invocations to prove the refund branch's guard logic.
vi.mock("../credits", () => ({
	refundReservation: refundReservationMock,
}));

// `@/lib/logger` is globally stubbed in vitest.setup.ts and `clearMocks: true`
// wipes each stub's call history between tests, so the finalize-log tests
// assert on the `log.info` stub directly (no per-test re-spy needed).
import { log } from "@/lib/logger";
import { UsageAccumulator } from "../usage";

const h = setupAppStateTestDb("usage_acc_");

/** The `usage_months.request_count` for a user this period, or undefined when
 *  `incrementUsage` never wrote (a zero-cost run short-circuits it). */
async function requestCount(userId: string): Promise<number | undefined> {
	const row = await h
		.db()
		.selectFrom("usage_months")
		.select("request_count")
		.where("user_id", "=", userId)
		.where("period", "=", getCurrentPeriod())
		.executeTakeFirst();
	return row?.request_count;
}

describe("UsageAccumulator", () => {
	it("tracks cumulative tokens + cost across track() calls", () => {
		const acc = new UsageAccumulator({
			appId: "app-1",
			userId: "user-1",
			runId: "run-1",
			model: "openai/gpt-5.6-sol",
			promptMode: "build",
			appReady: false,
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
		// Pin the exact cost against GPT-5.6 Sol pricing from @/lib/models
		// (input 5, output 30, cacheRead 0.5, cacheWrite 6.25 per 1M tokens).
		//   uncachedInput = 300 - 60 - 10 = 230
		//   cost = (230*5 + 60*0.5 + 10*6.25 + 150*30) / 1_000_000
		//        = (1150 + 30 + 62.5 + 4500) / 1_000_000
		//        = 5742.5 / 1_000_000 = 0.0057425
		// toBeGreaterThan(0) would silently accept a regression that zeroed
		// any of the four rate terms; exact pinning catches formula drift.
		expect(snap.costEstimate).toBeCloseTo(0.0057425, 10);
	});

	it("stepCount increments on track(...,{step:true}) calls only", () => {
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "openai/gpt-5.6-sol",
			promptMode: "build",
			appReady: false,
			moduleCount: 0,
		});
		acc.track({ inputTokens: 10, outputTokens: 5 }, { step: true });
		// Sub-gen call inside a tool — accumulates tokens but not step count.
		acc.track({ inputTokens: 5, outputTokens: 2 });
		acc.track({ inputTokens: 10, outputTokens: 5 }, { step: true });
		expect(acc.snapshot().stepCount).toBe(2);
	});

	it("flush() is idempotent", async () => {
		writeRunSummaryMock.mockReset();
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "openai/gpt-5.6-sol",
			promptMode: "build",
			appReady: false,
			moduleCount: 0,
			startedAt: "2026-04-18T12:00:00.000Z",
		});
		acc.track({ inputTokens: 1, outputTokens: 1 }, { step: true });
		await acc.flush();
		await acc.flush();
		// One increment (request_count 1, not 2) proves the second flush
		// short-circuited before the monthly-usage write ran.
		expect(await requestCount("u")).toBe(1);
		expect(writeRunSummaryMock).toHaveBeenCalledTimes(1);
	});

	it("flush() with zero cost skips the monthly increment", async () => {
		writeRunSummaryMock.mockReset();
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "r",
			model: "openai/gpt-5.6-sol",
			promptMode: "edit",
			appReady: true,
			moduleCount: 5,
		});
		await acc.flush();
		// No usage_months row at all — zero-cost runs short-circuit before
		// incrementUsage. request_count would otherwise bump without matching spend.
		expect(await requestCount("u")).toBeUndefined();
		// Run summary still written so the inspect tools see the run at all —
		// admins care about zero-cost replays too (e.g. cache-hit analysis).
		expect(writeRunSummaryMock).toHaveBeenCalledTimes(1);
	});

	it("runId getter returns the seed runId", () => {
		const acc = new UsageAccumulator({
			appId: "a",
			userId: "u",
			runId: "run-getter-test",
			model: "openai/gpt-5.6-sol",
			promptMode: "build",
			appReady: false,
			moduleCount: 0,
		});
		expect(acc.runId).toBe("run-getter-test");
	});

	// ── Credit refund on no-op / failed runs ────────────────────────
	//
	// A reservation booked at request start (didReserve) is handed back to the
	// user when the run did no billable work: it either FAILED (broke the app)
	// or produced zero cost. The two flush() branches are INDEPENDENT — a failed
	// run with real cost both accrues the cost (so the actual-$ backstop sees retry
	// spam) AND refunds the reserved credits. These cases cover every branch of
	// that guard, not just a representative one.
	describe("credit refund branch", () => {
		/** A reserved seed pinned to a deterministic charge period for refund assertions. */
		const reservedSeed = {
			appId: "a",
			userId: "u",
			runId: "r",
			model: "openai/gpt-5.6-sol",
			promptMode: "build" as const,
			appReady: false,
			moduleCount: 0,
			didReserve: true,
			reservedAmount: 100,
			chargePeriod: "2026-06",
		};

		it("refunds the reservation on a zero-cost run and skips the increment", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			// No track() calls → zero cost → the run did no billable work.
			const acc = new UsageAccumulator(reservedSeed);
			await acc.flush();

			// Reservation handed straight back — flush calls refundReservation by
			// appId; the amount + booked period live on the durable marker.
			expect(refundReservationMock).toHaveBeenCalledTimes(1);
			expect(refundReservationMock).toHaveBeenCalledWith("a", "r");
			// Zero cost short-circuits the increment — no usage_months row at all.
			expect(await requestCount("u")).toBeUndefined();
		});

		it("charges (no refund) on a successful run with real cost", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			const acc = new UsageAccumulator(reservedSeed);
			acc.track({ inputTokens: 1000, outputTokens: 500 }, { step: true });
			await acc.flush();

			// Real cost accrues to the monthly spend row (the increment fires)…
			expect(await requestCount("u")).toBe(1);
			// …and a healthy charge is never refunded.
			expect(refundReservationMock).not.toHaveBeenCalled();
		});

		it("on a FAILED run with real cost it BOTH accrues the cost AND refunds", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			const acc = new UsageAccumulator(reservedSeed);
			acc.track({ inputTokens: 1000, outputTokens: 500 }, { step: true });
			acc.markRunFailed();
			await acc.flush();

			// The two branches are independent: the actual $ cost still accrues so
			// the actual-$ backstop sees retry spam from a user hammering a broken app…
			expect(await requestCount("u")).toBe(1);
			// …while the user's credits are made whole because the app broke.
			expect(refundReservationMock).toHaveBeenCalledTimes(1);
			expect(refundReservationMock).toHaveBeenCalledWith("a", "r");
		});

		it("never refunds a free continuation that was never reserved", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			// didReserve:false — an assistant-tail continuation that booked nothing.
			const acc = new UsageAccumulator({
				...reservedSeed,
				didReserve: false,
				reservedAmount: undefined,
				chargePeriod: undefined,
			});
			acc.markRunFailed();
			await acc.flush();

			// Zero-cost AND failed, yet nothing was reserved → nothing to give back.
			// A phantom refund here would credit work the user never paid for.
			expect(refundReservationMock).not.toHaveBeenCalled();
		});

		it("the didReserve flag alone vetoes the refund even with amount + period present", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			// `reservedAmount` and `chargePeriod` are PRESENT but `didReserve` is
			// false. This isolates `didReserve`'s contribution to the guard: with the
			// other two clauses truthy, only the flag can veto the refund. Dropping
			// the `didReserve` clause from the guard would wrongly refund here — the
			// other two cases leave all three falsy together, so they can't catch it.
			const acc = new UsageAccumulator({
				...reservedSeed,
				didReserve: false,
				reservedAmount: 100,
				chargePeriod: "2026-06",
			});
			await acc.flush();

			expect(refundReservationMock).not.toHaveBeenCalled();
		});

		it("triggers the refund for an edit's reservation (a non-build amount still fires the gate)", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			// An EDIT reserved 5, not a build's 100. The exact amount is no longer
			// flush's concern (refundReservation reads it off the marker — see
			// credits.test.ts); this pins that the flush refund GATE still fires for a
			// non-build reservation, delegating by appId.
			const acc = new UsageAccumulator({
				...reservedSeed,
				reservedAmount: 5,
			});
			await acc.flush();

			expect(refundReservationMock).toHaveBeenCalledWith("a", "r");
		});

		it("refunds at most once across repeated flush() calls", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			const acc = new UsageAccumulator(reservedSeed);
			await acc.flush();
			await acc.flush();

			// The `_finalized` guard short-circuits the second flush before the
			// refund branch — a double-refund would over-credit the user.
			expect(refundReservationMock).toHaveBeenCalledTimes(1);
		});

		it("still fires the refund gate when the reservation was booked to a prior month", async () => {
			writeRunSummaryMock.mockReset();
			refundReservationMock.mockReset();
			// The cross-midnight period-capture now lives on the marker: reserveCredits
			// writes the booked period, refundReservation reads it (credits.test.ts).
			// flush's job is only to FIRE the refund — this asserts a prior-month
			// chargePeriod still passes the gate and delegates by appId.
			const acc = new UsageAccumulator({
				...reservedSeed,
				chargePeriod: "2026-05",
			});
			await acc.flush();

			expect(refundReservationMock).toHaveBeenCalledWith("a", "r");
		});
	});

	/**
	 * The `[run-finalize]` line is the per-request finalization record: one
	 * entry per `flush()` carrying what this turn recorded versus dropped. Its
	 * value is making three otherwise-invisible failures searchable — an
	 * all-zero count on a run that did work, a `summaryAction: "overwritten"`
	 * clobber, and a `refundReason: "zero-cost"` that refunds a build whose
	 * flush saw no cost. These tests pin that payload.
	 */
	describe("finalize log", () => {
		const reservedSeed = {
			appId: "a",
			userId: "u",
			runId: "r",
			model: "openai/gpt-5.6-sol",
			promptMode: "build" as const,
			appReady: false,
			moduleCount: 0,
			didReserve: true,
			reservedAmount: 100,
			chargePeriod: "2026-06",
		};

		it("carries the summaryAction, the zero-cost refund reason, and the input composition", async () => {
			writeRunSummaryMock.mockReset();
			// A clobbered prior doc — the silent-undercount path we most want to see.
			writeRunSummaryMock.mockResolvedValue("overwritten");
			refundReservationMock.mockReset();

			// No track() → zero cost. Reserved + zero-cost = the wrong-refund signature.
			const acc = new UsageAccumulator(reservedSeed);
			acc.configureRun({ sentMessageCount: 4, sentMessageChars: 1234 });
			await acc.flush();

			expect(log.info).toHaveBeenCalledTimes(1);
			expect(log.info).toHaveBeenCalledWith(
				"[run-finalize]",
				expect.objectContaining({
					runId: "r",
					summaryAction: "overwritten",
					stepCount: 0,
					toolCallCount: 0,
					costEstimate: 0,
					accruedActual: false,
					didReserve: true,
					reservedAmount: 100,
					refunded: true,
					refundReason: "zero-cost",
					sentMessageCount: 4,
					sentMessageChars: 1234,
				}),
			);
		});

		it("labels a FAILED run with real cost as run-failed (the legit-refund leg, not the zero-cost alarm)", async () => {
			writeRunSummaryMock.mockReset();
			writeRunSummaryMock.mockResolvedValue("incremented");
			refundReservationMock.mockReset();

			// Real cost + markRunFailed → the third leg of the refundReason ternary.
			// This is the discriminator the log exists for: a legitimate failed-run
			// refund must read "run-failed", never the "zero-cost" wrong-refund alarm.
			// `accruedActual: true` confirms costEstimate > 0 (they are equivalent by
			// construction), so both the failed-refund AND the still-accrues-cost
			// invariants are pinned in one assertion.
			const acc = new UsageAccumulator(reservedSeed);
			acc.track({ inputTokens: 1000, outputTokens: 500 }, { step: true });
			acc.markRunFailed();
			await acc.flush();

			expect(log.info).toHaveBeenCalledWith(
				"[run-finalize]",
				expect.objectContaining({
					summaryAction: "incremented",
					refunded: true,
					refundReason: "run-failed",
					accruedActual: true,
				}),
			);
		});

		it("logs refunded:false + refundFailed:true when the owed refund's transaction throws", async () => {
			writeRunSummaryMock.mockReset();
			writeRunSummaryMock.mockResolvedValue("incremented");
			refundReservationMock.mockReset();
			// The refund was owed (failed run, reservation booked) but its cross-doc
			// transaction threw. The log reports the OUTCOME, not the intent: a refund
			// that did not commit logs refunded:false + refundFailed:true, so the cost
			// investigation is never told credits were handed back when they weren't.
			refundReservationMock.mockRejectedValue(new Error("database contention"));
			const acc = new UsageAccumulator(reservedSeed);
			acc.track({ inputTokens: 1000, outputTokens: 500 }, { step: true });
			acc.markRunFailed();
			await acc.flush();

			expect(log.info).toHaveBeenCalledWith(
				"[run-finalize]",
				expect.objectContaining({
					refundReason: "run-failed",
					refunded: false,
					refundFailed: true,
				}),
			);
		});

		it("logs refundReason null + accruedActual true on a healthy paid run", async () => {
			writeRunSummaryMock.mockReset();
			writeRunSummaryMock.mockResolvedValue("incremented");
			refundReservationMock.mockReset();

			const acc = new UsageAccumulator(reservedSeed);
			acc.track({ inputTokens: 1000, outputTokens: 500 }, { step: true });
			await acc.flush();

			expect(log.info).toHaveBeenCalledWith(
				"[run-finalize]",
				expect.objectContaining({
					summaryAction: "incremented",
					refunded: false,
					refundReason: null,
					accruedActual: true,
				}),
			);
		});

		it("carries undefined composition when the run finalizes before configureRun", async () => {
			writeRunSummaryMock.mockReset();
			writeRunSummaryMock.mockResolvedValue("created");
			refundReservationMock.mockReset();

			// No configureRun() — the early-finalize shape: a flush that lands
			// before the route assembles the effective messages. Pinning the
			// undefined composition documents that the log degrades gracefully
			// (this is exactly the empty-flush case the line exists to expose).
			const acc = new UsageAccumulator(reservedSeed);
			await acc.flush();

			expect(log.info).toHaveBeenCalledWith(
				"[run-finalize]",
				expect.objectContaining({
					sentMessageCount: undefined,
					sentMessageChars: undefined,
				}),
			);
		});
	});
});
