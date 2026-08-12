/**
 * Bounded slice execution (the plan's §13.8).
 *
 * Every axis a slice attempt can spend is capped before the first model call,
 * and every cap is a pure function of the admitted construction strategy — so a budget is
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
	readonly maxBlockerResolutions: number;
	readonly maxWallClockMs: number;
}

/** Attempt-local spend axes that are claimed durably before work begins. */
export type SliceAttemptBudgetCounter =
	| "modelSteps"
	| "stagedRequests"
	| "commitAttempts"
	| "blockerReports";

export type SliceAttemptBudgetClaimResult =
	| "claimed"
	| "replayed"
	| "exhausted";

export interface SliceAttemptBudgetSpent {
	readonly modelSteps: number;
	readonly stagedRequests: number;
	readonly commitAttempts: number;
	readonly blockerReports: number;
}

/**
 * The floor every slice gets. Sized for the smallest real slice — one record,
 * one form, its case list — with room for a read, a correction after a
 * rejected stage, and an inspect before commit.
 */
const BASE_BUDGET: SliceExecutionBudget = {
	maxModelSteps: 10,
	maxStagedRequests: 16,
	/* Three commit attempts: the first, one after a rebase refresh, one after
	 * a diagnostics fix. A fourth is a replan, not a retry. */
	maxCommitAttempts: 3,
	maxRebaseAttempts: 2,
	/* Two fresh architect decisions are enough to turn compiler evidence into
	 * exact guidance. A third unresolved report is a construction defect. */
	maxBlockerResolutions: 2,
	maxWallClockMs: 4 * 60_000,
};

const MODEL_STEPS_PER_GROUP = 3;
const STAGED_REQUESTS_PER_GROUP = 3;
const WALL_CLOCK_MS_PER_GROUP = 75_000;

const RISK_ALLOWANCE: Readonly<
	Record<
		BuildSlice["risk"],
		{ modelSteps: number; stagedRequests: number; ms: number }
	>
> = {
	ordinary: { modelSteps: 0, stagedRequests: 0, ms: 0 },
	"cross-record": { modelSteps: 3, stagedRequests: 6, ms: 90_000 },
	"external-effect": { modelSteps: 2, stagedRequests: 4, ms: 60_000 },
	"data-migration": { modelSteps: 4, stagedRequests: 8, ms: 120_000 },
};

/**
 * Hard global ceilings. A slice that would need more than this is mis-sized:
 * the planner owns splitting it, and letting one attempt grow past these
 * numbers only converts a planning defect into a long, expensive failure.
 */
const CEILINGS = {
	maxModelSteps: 40,
	maxStagedRequests: 96,
	maxWallClockMs: 12 * 60_000,
} as const;

/** Deterministic budget for one slice — pure, and pinned by test. */
export function budgetForSlice(slice: BuildSlice): SliceExecutionBudget {
	const groupCount = slice.constructionGroups.length;
	const risk = RISK_ALLOWANCE[slice.risk];
	return {
		maxModelSteps: Math.min(
			CEILINGS.maxModelSteps,
			BASE_BUDGET.maxModelSteps +
				groupCount * MODEL_STEPS_PER_GROUP +
				risk.modelSteps,
		),
		maxStagedRequests: Math.min(
			CEILINGS.maxStagedRequests,
			BASE_BUDGET.maxStagedRequests +
				groupCount * STAGED_REQUESTS_PER_GROUP +
				risk.stagedRequests,
		),
		maxCommitAttempts: BASE_BUDGET.maxCommitAttempts,
		maxRebaseAttempts: BASE_BUDGET.maxRebaseAttempts,
		maxBlockerResolutions: BASE_BUDGET.maxBlockerResolutions,
		maxWallClockMs: Math.min(
			CEILINGS.maxWallClockMs,
			BASE_BUDGET.maxWallClockMs +
				groupCount * WALL_CLOCK_MS_PER_GROUP +
				risk.ms,
		),
	};
}
