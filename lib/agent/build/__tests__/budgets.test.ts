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
	const groups = Array.from(
		{ length: Math.max(1, Math.ceil(count / 10)) },
		(_, index) => ({
			name: `Group ${index + 1}`,
			kind: "workflow" as const,
			intentIds: owned.slice(index * 10, (index + 1) * 10),
			blueprintAreas: ["forms" as const],
		}),
	);
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
		constructionStrategy: {
			semanticGroups: groups,
			lowerings: owned.map((intentId) => ({
				intentId,
				target: "task-form" as const,
			})),
			tasks: [],
			facts: [],
			readModels: [],
			access: [],
			navigation: [],
			externalSetupActionIds: [],
		},
		externalActionIds: [],
	};
}

describe("budgetForSlice", () => {
	it("gives a single-intent slice the base budget", () => {
		expect(budgetForSlice(sliceWithOwnedIntents(1))).toEqual({
			maxModelSteps: 13,
			maxStagedRequests: 18,
			maxCommitAttempts: 3,
			maxRebaseAttempts: 2,
			maxBlockerResolutions: 2,
			maxWallClockMs: 315_000,
		});
	});

	it("scales the per-step axes with owned intents", () => {
		expect(budgetForSlice(sliceWithOwnedIntents(5))).toEqual({
			maxModelSteps: 13,
			maxStagedRequests: 26,
			maxCommitAttempts: 3,
			maxRebaseAttempts: 2,
			maxBlockerResolutions: 2,
			maxWallClockMs: 315_000,
		});
	});

	it("holds every scaled axis at its hard ceiling", () => {
		expect(budgetForSlice(sliceWithOwnedIntents(500))).toEqual({
			maxModelSteps: 40,
			maxStagedRequests: 96,
			maxCommitAttempts: 3,
			maxRebaseAttempts: 2,
			maxBlockerResolutions: 2,
			maxWallClockMs: 720_000,
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
