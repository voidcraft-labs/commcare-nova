/**
 * Bounded slice execution (the plan's §13.8).
 *
 * Every axis a slice attempt can spend is capped before the first model call,
 * and every cap is a pure function of the slice's own shape — so a budget is
 * reproducible from the plan alone, comparable across attempts, and provable
 * in a test rather than tuned at runtime. Exceeding any axis ends the attempt
 * as `budget-exhausted`: it never commits a partial canonical prefix and never
 * reports completion. There is no unbounded "amend until valid" loop.
 */

import type { BuildSlice } from "@/lib/agent/design/buildPlan";

export interface SliceExecutionBudget {
	readonly maxModelSteps: number;
	readonly maxStagedRequests: number;
	readonly maxCommitAttempts: number;
	readonly maxRebaseAttempts: number;
	readonly maxDesignIssueEscalations: number;
	readonly maxWallClockMs: number;
}

/**
 * The floor every slice gets. Sized for the smallest real slice — one record,
 * one form, its case list — with room for a read, a correction after a
 * rejected stage, and an inspect before commit.
 */
const BASE_BUDGET: SliceExecutionBudget = {
	maxModelSteps: 24,
	maxStagedRequests: 40,
	/* Three commit attempts: the first, one after a rebase refresh, one after
	 * a diagnostics fix. A fourth is a replan, not a retry. */
	maxCommitAttempts: 3,
	maxRebaseAttempts: 2,
	/* Two escalations: one question, and one more if answering the first
	 * exposed a second gap. A third means the design is wrong, not thin. */
	maxDesignIssueEscalations: 2,
	maxWallClockMs: 8 * 60_000,
};

/** Per owned intent beyond the first — one intent is roughly one entity plus
 *  the call that corrects it. */
const STEPS_PER_EXTRA_INTENT = 2;
const STAGED_REQUESTS_PER_EXTRA_INTENT = 3;
const WALL_CLOCK_MS_PER_EXTRA_INTENT = 20_000;

/**
 * Hard global ceilings. A slice that would need more than this is mis-sized:
 * the planner owns splitting it, and letting one attempt grow past these
 * numbers only converts a planning defect into a long, expensive failure.
 */
const CEILINGS = {
	maxModelSteps: 60,
	maxStagedRequests: 120,
	maxWallClockMs: 15 * 60_000,
} as const;

/** Deterministic budget for one slice — pure, and pinned by test. */
export function budgetForSlice(slice: BuildSlice): SliceExecutionBudget {
	const extraIntents = Math.max(0, slice.ownedIntentIds.length - 1);
	return {
		maxModelSteps: Math.min(
			CEILINGS.maxModelSteps,
			BASE_BUDGET.maxModelSteps + extraIntents * STEPS_PER_EXTRA_INTENT,
		),
		maxStagedRequests: Math.min(
			CEILINGS.maxStagedRequests,
			BASE_BUDGET.maxStagedRequests +
				extraIntents * STAGED_REQUESTS_PER_EXTRA_INTENT,
		),
		maxCommitAttempts: BASE_BUDGET.maxCommitAttempts,
		maxRebaseAttempts: BASE_BUDGET.maxRebaseAttempts,
		maxDesignIssueEscalations: BASE_BUDGET.maxDesignIssueEscalations,
		maxWallClockMs: Math.min(
			CEILINGS.maxWallClockMs,
			BASE_BUDGET.maxWallClockMs +
				extraIntents * WALL_CLOCK_MS_PER_EXTRA_INTENT,
		),
	};
}
