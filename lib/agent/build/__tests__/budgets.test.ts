/** Budget policy, exercised independently of model calls and durable claims. */
import { describe, expect, it } from "vitest";
import { did } from "@/lib/agent/design/__tests__/fixtures";
import {
	type BuildSlice,
	buildSliceSchema,
} from "@/lib/agent/design/buildPlan";
import { MODEL_ROLES } from "@/lib/models";
import {
	BLOCKER_RESOLUTION_ALLOWANCE,
	budgetForSlice,
	remainingWallClockMs,
	totalWallClockAllowanceMs,
} from "../budgets";

// Sizing consumes a slice's risk and group count. These schema-admitted policy
// inputs deliberately reach the ceilings; they are not claims that today's
// deterministic planner generates this many groups.
function sizedSlice(groups: number, risk: BuildSlice["risk"] = "ordinary") {
	return buildSliceSchema.parse({
		id: did(900),
		workflowId: did(901),
		name: "Sized workflow",
		goal: "Bound execution cost",
		prerequisiteSliceIds: [],
		externalActionIds: [],
		risk,
		role: "ordinary",
		constructionGroups: Array.from({ length: groups }, (_, index) => ({
			id: did(1000 + index),
			workflowId: did(901),
			name: `Group ${index + 1}`,
			kind: "workflow",
			elements: [{ kind: "property", id: did(2000 + index) }],
			blueprintAreas: ["forms"],
		})),
	});
}

describe("slice execution budget policy", () => {
	it.each([
		[1, "ordinary", 13, 19],
		[5, "ordinary", 25, 31],
		[9, "ordinary", 37, 43],
		[10, "ordinary", 40, 46],
		[26, "ordinary", 40, 94],
		[27, "ordinary", 40, 96],
		[1, "cross-record", 16, 25],
		[9, "cross-record", 40, 49],
		[1, "external-effect", 15, 23],
		[10, "external-effect", 40, 50],
	] as const)(
		"prices %i %s groups at %i model steps and %i mutation calls",
		(groups, risk, steps, calls) => {
			const slice = sizedSlice(groups, risk);
			const before = structuredClone(slice);
			expect(budgetForSlice(slice)).toEqual({
				maxModelSteps: steps,
				maxMutationCalls: calls,
				maxCommitAttempts: 3,
				maxRebaseAttempts: 2,
				maxBlockerResolutions: 2,
				maxWallClockMs: steps * MODEL_ROLES.buildExecutor.msPerModelStep,
			});
			expect(slice).toEqual(before);
		},
	);
	it("caps all risk classes without reducing their funded step pace", () => {
		for (const risk of [
			"ordinary",
			"cross-record",
			"external-effect",
		] as const) {
			const budget = budgetForSlice(sizedSlice(100, risk));
			expect(budget).toMatchObject({
				maxModelSteps: 40,
				maxMutationCalls: 96,
				maxWallClockMs: 40 * MODEL_ROLES.buildExecutor.msPerModelStep,
			});
		}
	});
	it("funds each paid blocker with the same step pace and bounded extra mutations", () => {
		expect(BLOCKER_RESOLUTION_ALLOWANCE).toEqual({
			modelSteps: 5,
			mutationCalls: 8,
			ms: 5 * MODEL_ROLES.buildExecutor.msPerModelStep,
		});
	});
});

describe("durable active-time allowance", () => {
	it.each([0, 1, 2])(
		"accounts for %i paid blockers and floors exhausted active time at zero",
		(blockers) => {
			const budget = budgetForSlice(sizedSlice(1));
			const total =
				(13 + blockers * 5) * MODEL_ROLES.buildExecutor.msPerModelStep;
			expect(totalWallClockAllowanceMs(budget, blockers)).toBe(total);
			for (const [spent, remaining] of [
				[0, total],
				[200_000, total - 200_000],
				[total - 1, 1],
				[total, 0],
				[total + 1, 0],
			]) {
				expect(remainingWallClockMs(budget, spent, blockers)).toBe(remaining);
			}
		},
	);
});
