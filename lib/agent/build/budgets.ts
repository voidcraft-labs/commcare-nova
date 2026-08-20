/**
 * Bounded slice execution.
 *
 * Every axis a slice attempt can spend is capped before the first model call,
 * and every cap is a pure function of the admitted construction strategy and
 * the executor role's funded step pace
 * (`MODEL_ROLES.buildExecutor.msPerModelStep`) — so a budget is
 * reproducible from the plan alone, comparable across attempts, and provable
 * in a test rather than tuned at runtime. Every wall-clock axis is its step
 * count times that pace, base through ceiling, so one generous pace
 * assumption holds across the whole range and the deadline is a backstop
 * against a runaway attempt, not a per-slice estimate. Exceeding any axis
 * ends the attempt
 * as `budget-exhausted`: it never commits a partial canonical prefix and never
 * reports completion. There is no unbounded "amend until valid" loop.
 *
 * Wall time is ACTIVE time. The attempt row's durable integrator
 * (`sliceAttempts.ts`) accrues it at genuine budget claims and recovery
 * resets the accrual point without accruing, so a process-death resume —
 * which can only run after the build liveness horizon lapses — receives the
 * unspent remainder instead of a deadline the dead gap already burned.
 */

import type { BuildSlice } from "@/lib/agent/design/buildPlan";
import { MODEL_ROLES } from "@/lib/models";

const STEP_PACE_MS = MODEL_ROLES.buildExecutor.msPerModelStep;

export interface SliceExecutionBudget {
	readonly maxModelSteps: number;
	readonly maxMutationCalls: number;
	readonly maxCommitAttempts: number;
	readonly maxRebaseAttempts: number;
	readonly maxBlockerResolutions: number;
	readonly maxWallClockMs: number;
}

/** Attempt-local spend axes that are claimed durably before work begins. */
export type SliceAttemptBudgetCounter =
	| "modelSteps"
	| "mutationCalls"
	| "commitAttempts"
	| "blockerReports";

export type SliceAttemptBudgetClaimResult =
	| "claimed"
	| "replayed"
	| "exhausted";

export interface SliceAttemptBudgetSpent {
	readonly modelSteps: number;
	readonly mutationCalls: number;
	readonly commitAttempts: number;
	readonly blockerReports: number;
}

const BASE_MODEL_STEPS = 10;

/**
 * The floor every slice gets. Sized for the smallest real slice — one record,
 * one form, its case list — with room for reads and bounded correction after
 * a rejected private mutation.
 */
const BASE_BUDGET: SliceExecutionBudget = {
	maxModelSteps: BASE_MODEL_STEPS,
	maxMutationCalls: 16,
	/* Three commit attempts: the first, one after a rebase refresh, one after
	 * a diagnostics fix. A fourth is a replan, not a retry. */
	maxCommitAttempts: 3,
	maxRebaseAttempts: 2,
	/* Two fresh architect decisions are enough to turn compiler evidence into
	 * exact guidance. A third unresolved report is a construction defect. */
	maxBlockerResolutions: 2,
	maxWallClockMs: BASE_MODEL_STEPS * STEP_PACE_MS,
};

const MODEL_STEPS_PER_GROUP = 3;
const MUTATION_CALLS_PER_GROUP = 3;
const WALL_CLOCK_MS_PER_GROUP = MODEL_STEPS_PER_GROUP * STEP_PACE_MS;

/** A risk arm's wall clock funds exactly the extra steps it grants. */
function riskAllowance(
	modelSteps: number,
	mutationCalls: number,
): { modelSteps: number; mutationCalls: number; ms: number } {
	return { modelSteps, mutationCalls, ms: modelSteps * STEP_PACE_MS };
}

const RISK_ALLOWANCE: Readonly<
	Record<
		BuildSlice["risk"],
		{ modelSteps: number; mutationCalls: number; ms: number }
	>
> = {
	ordinary: riskAllowance(0, 0),
	"cross-record": riskAllowance(3, 6),
	"external-effect": riskAllowance(2, 4),
};

const CEILING_MODEL_STEPS = 40;

/**
 * Hard global ceilings. A slice that would need more than this is mis-sized:
 * the planner owns splitting it, and letting one attempt grow past these
 * numbers only converts a planning defect into a long, expensive failure.
 * The wall-clock ceiling funds exactly the step ceiling, so both bind at the
 * same slice shape and the funded pace never degrades at the top of the range.
 */
const CEILINGS = {
	maxModelSteps: CEILING_MODEL_STEPS,
	maxMutationCalls: 96,
	maxWallClockMs: CEILING_MODEL_STEPS * STEP_PACE_MS,
} as const;

const BLOCKER_MODEL_STEPS = 5;

/**
 * Priced rework for one answered architect blocker. A `continue` decision
 * directs construction the deterministic plan never priced — a lowering, a
 * rehosting — so each paid resolution grows the attempt's step, mutation-call, and
 * wall-clock limits by this much. `maxBlockerResolutions` bounds the total:
 * the worst case adds exactly two allowances, never an open-ended stream.
 */
export const BLOCKER_RESOLUTION_ALLOWANCE = {
	modelSteps: BLOCKER_MODEL_STEPS,
	mutationCalls: 8,
	ms: BLOCKER_MODEL_STEPS * STEP_PACE_MS,
} as const;

/** The attempt's total wall-clock allowance: its budget plus the priced
 * allowance for every durably paid architect blocker. The one spelling both
 * the deadline mint and the exhaustion report's spent figure derive from. */
export function totalWallClockAllowanceMs(
	budget: SliceExecutionBudget,
	blockerReportsUsed: number,
): number {
	return (
		budget.maxWallClockMs + blockerReportsUsed * BLOCKER_RESOLUTION_ALLOWANCE.ms
	);
}

/** The wall clock an attempt may still spend: its total allowance minus
 * durable active spend, floored at zero. The executor deadline is now plus
 * this — never elapsed time since the attempt's original start, which would
 * count the dead gap a process-death recovery necessarily sits behind. */
export function remainingWallClockMs(
	budget: SliceExecutionBudget,
	wallClockMsUsed: number,
	blockerReportsUsed = 0,
): number {
	return Math.max(
		0,
		totalWallClockAllowanceMs(budget, blockerReportsUsed) - wallClockMsUsed,
	);
}

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
		maxMutationCalls: Math.min(
			CEILINGS.maxMutationCalls,
			BASE_BUDGET.maxMutationCalls +
				groupCount * MUTATION_CALLS_PER_GROUP +
				risk.mutationCalls,
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
