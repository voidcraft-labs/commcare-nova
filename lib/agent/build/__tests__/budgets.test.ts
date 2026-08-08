/**
 * Slice budgets are deterministic from the slice's shape — pinned here so a
 * change to the numbers is a deliberate, reviewed act rather than a drift.
 */

import { describe, expect, it } from "vitest";
import { budgetForSlice } from "@/lib/agent/build/budgets";
import { did, ids, makeBuildPlan } from "@/lib/agent/design/__tests__/fixtures";
import type { BuildSlice } from "@/lib/agent/design/buildPlan";

function sliceWithOwnedIntents(count: number): BuildSlice {
	const owned = Array.from({ length: count }, (_, index) => did(1000 + index));
	return {
		id: did(900),
		name: "Sized slice",
		goal: "Exercise the budget scaling.",
		intentIds: owned,
		ownedIntentIds: owned,
		prerequisiteSliceIds: [],
		acceptanceScenarioIds: [],
		risk: "ordinary",
		role: "ordinary",
		expectedBlueprintAreas: [],
		externalActionIds: [],
	};
}

describe("budgetForSlice", () => {
	it("gives a single-intent slice the base budget", () => {
		expect(budgetForSlice(sliceWithOwnedIntents(1))).toEqual({
			maxModelSteps: 24,
			maxStagedRequests: 40,
			maxCommitAttempts: 3,
			maxRebaseAttempts: 2,
			maxDesignIssueEscalations: 2,
			maxWallClockMs: 480_000,
		});
	});

	it("scales the per-step axes with owned intents", () => {
		expect(budgetForSlice(sliceWithOwnedIntents(5))).toEqual({
			maxModelSteps: 32,
			maxStagedRequests: 52,
			maxCommitAttempts: 3,
			maxRebaseAttempts: 2,
			maxDesignIssueEscalations: 2,
			maxWallClockMs: 560_000,
		});
	});

	it("holds every scaled axis at its hard ceiling", () => {
		expect(budgetForSlice(sliceWithOwnedIntents(500))).toEqual({
			maxModelSteps: 60,
			maxStagedRequests: 120,
			maxCommitAttempts: 3,
			maxRebaseAttempts: 2,
			maxDesignIssueEscalations: 2,
			maxWallClockMs: 900_000,
		});
	});

	it("is pure — the same slice always yields the same budget", () => {
		const plan = makeBuildPlan();
		const slice = plan.slices.find((entry) => entry.id === ids.sliceRegister);
		if (slice === undefined) throw new Error("fixture slice missing");
		expect(budgetForSlice(slice)).toEqual(
			budgetForSlice(structuredClone(slice)),
		);
	});
});
