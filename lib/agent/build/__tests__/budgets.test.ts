import { describe, expect, it } from "vitest";
import {
	BLOCKER_RESOLUTION_ALLOWANCE,
	budgetForSlice,
	remainingWallClockMs,
} from "@/lib/agent/build/budgets";
import { EXECUTOR_PROMPT_VERSION } from "@/lib/agent/build/executorPrompt";
import {
	did,
	fixtureValue,
	makeBuildPlan,
} from "@/lib/agent/design/__tests__/fixtures";
import type { BuildSlice } from "@/lib/agent/design/buildPlan";
import { MODEL_ROLES } from "@/lib/models";

function sliceWithGroups(count: number): BuildSlice {
	return {
		id: did(900),
		workflowId: did(901),
		name: "Sized slice",
		goal: "Exercise budget scaling.",
		prerequisiteSliceIds: [],
		constructionGroups: Array.from({ length: count }, (_, index) => ({
			id: did(1000 + index),
			workflowId: did(901),
			name: `Group ${index + 1}`,
			kind: "workflow" as const,
			elements: [{ kind: "workflow" as const, id: did(2000 + index) }],
			blueprintAreas: ["forms" as const],
		})),
		externalActionIds: [],
		risk: "ordinary",
		role: "ordinary",
	};
}

describe("budgetForSlice", () => {
	it("scales from real construction groups", () => {
		expect(budgetForSlice(sliceWithGroups(1))).toMatchObject({
			maxModelSteps: 13,
			maxMutationCalls: 19,
			maxWallClockMs: 1_170_000,
		});
		expect(budgetForSlice(sliceWithGroups(5))).toMatchObject({
			maxModelSteps: 25,
			maxMutationCalls: 31,
			maxWallClockMs: 2_250_000,
		});
	});

	it("holds scaled axes at hard ceilings", () => {
		expect(budgetForSlice(sliceWithGroups(500))).toMatchObject({
			maxModelSteps: 40,
			maxMutationCalls: 96,
			maxWallClockMs: 3_600_000,
		});
	});

	it("funds every slice's wall clock at exactly the executor role's step pace", () => {
		const pace = MODEL_ROLES.buildExecutor.msPerModelStep;
		for (const groups of [0, 1, 5, 9, 10, 500]) {
			const budget = budgetForSlice(sliceWithGroups(groups));
			expect(budget.maxWallClockMs).toBe(budget.maxModelSteps * pace);
		}
		const crossRecord: BuildSlice = {
			...sliceWithGroups(2),
			risk: "cross-record",
		};
		const budget = budgetForSlice(crossRecord);
		expect(budget.maxWallClockMs).toBe(budget.maxModelSteps * pace);
		expect(BLOCKER_RESOLUTION_ALLOWANCE.ms).toBe(
			BLOCKER_RESOLUTION_ALLOWANCE.modelSteps * pace,
		);
	});

	it("couples any budget retune to the executor prompt version", () => {
		/* The failed-slice rerun gate fingerprints (executor model, prompt
		 * version, brief digest); the budgets are enforced but not recorded.
		 * Changing any number in budgets.ts — or the pace in lib/models.ts —
		 * changes the executor's operating envelope, so the same diff must
		 * bump EXECUTOR_PROMPT_VERSION or every budget-exhausted slice stays
		 * permanently closed under the old limits. The pins above break on any
		 * retune; this pin makes that diff also name the version bump. */
		expect(EXECUTOR_PROMPT_VERSION).toBe("build-executor-v17");
	});

	it("is pure for a derived slice", () => {
		const slice = fixtureValue(makeBuildPlan().slices[0], "first slice");
		expect(budgetForSlice(slice)).toEqual(
			budgetForSlice(structuredClone(slice)),
		);
	});
});

describe("remainingWallClockMs", () => {
	it("grants the full budget to a fresh attempt and the unspent remainder to a recovered one", () => {
		const budget = budgetForSlice(sliceWithGroups(1));
		expect(remainingWallClockMs(budget, 0)).toBe(budget.maxWallClockMs);
		expect(remainingWallClockMs(budget, 200_000)).toBe(
			budget.maxWallClockMs - 200_000,
		);
	});

	it("prices answered architect blockers into the remaining wall clock", () => {
		const budget = budgetForSlice(sliceWithGroups(1));
		expect(remainingWallClockMs(budget, budget.maxWallClockMs, 1)).toBe(
			BLOCKER_RESOLUTION_ALLOWANCE.ms,
		);
		expect(remainingWallClockMs(budget, 0, 2)).toBe(
			budget.maxWallClockMs + 2 * BLOCKER_RESOLUTION_ALLOWANCE.ms,
		);
	});

	it("floors at zero once active spend reaches the budget", () => {
		const budget = budgetForSlice(sliceWithGroups(1));
		expect(remainingWallClockMs(budget, budget.maxWallClockMs)).toBe(0);
		/* The pre-integrator failure shape: a recovery arriving after a long
		 * dead gap must NOT be modeled as spend — but if genuine active spend
		 * ever exceeds the budget, the remainder still floors at zero. */
		expect(remainingWallClockMs(budget, budget.maxWallClockMs + 1)).toBe(0);
	});
});
