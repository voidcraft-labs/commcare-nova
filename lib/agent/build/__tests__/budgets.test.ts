import { describe, expect, it } from "vitest";
import { budgetForSlice } from "@/lib/agent/build/budgets";
import {
	did,
	fixtureValue,
	makeBuildPlan,
} from "@/lib/agent/design/__tests__/fixtures";
import type { BuildSlice } from "@/lib/agent/design/buildPlan";

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
			maxStagedRequests: 19,
			maxWallClockMs: 315_000,
		});
		expect(budgetForSlice(sliceWithGroups(5))).toMatchObject({
			maxModelSteps: 25,
			maxStagedRequests: 31,
			maxWallClockMs: 615_000,
		});
	});

	it("holds scaled axes at hard ceilings", () => {
		expect(budgetForSlice(sliceWithGroups(500))).toMatchObject({
			maxModelSteps: 40,
			maxStagedRequests: 96,
			maxWallClockMs: 720_000,
		});
	});

	it("is pure for a derived slice", () => {
		const slice = fixtureValue(makeBuildPlan().slices[0], "first slice");
		expect(budgetForSlice(slice)).toEqual(
			budgetForSlice(structuredClone(slice)),
		);
	});
});
