import { describe, expect, it } from "vitest";
import {
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { architectBlockerDecisionSchemaFor } from "../executionBlocker";

function repairContext(planRepairAllowed: boolean) {
	return {
		acceptedContract: appDesignContractSchema.parse(makeContract()),
		currentPlan: makeBuildPlan(),
		planRepairAllowed,
	};
}

function planDraft() {
	const plan = makeBuildPlan();
	return {
		slices: plan.slices,
		externalActions: plan.externalActions,
		intentOwnership: plan.intentOwnership,
	};
}

describe("architect blocker decisions", () => {
	it("accepts exact compiler guidance without reopening design authority", () => {
		const parsed = architectBlockerDecisionSchemaFor(
			repairContext(false),
		).safeParse({ kind: "continue", guidance: "Use the selected-case form." });
		expect(parsed.success).toBe(true);
	});

	it("forbids plan replacement after materialization", () => {
		const parsed = architectBlockerDecisionSchemaFor(
			repairContext(false),
		).safeParse({
			kind: "plan-repair",
			reason: "The root boundary is wrong.",
			repairedPlan: planDraft(),
		});
		expect(parsed.success).toBe(false);
		expect(
			parsed.error?.issues.map((issue) => issue.message).join("\n"),
		).toContain("only available before the materialization root commits");
	});

	it("accepts a construction-valid replacement before materialization", () => {
		const parsed = architectBlockerDecisionSchemaFor(
			repairContext(true),
		).safeParse({
			kind: "plan-repair",
			reason: "The root boundary is wrong.",
			repairedPlan: planDraft(),
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects a replacement that contradicts the accepted contract", () => {
		const draft = planDraft();
		const task = draft.slices[1]?.constructionStrategy.tasks[0];
		if (!task) throw new Error("fixture has a visit task strategy");
		task.mode = "survey";
		const parsed = architectBlockerDecisionSchemaFor(
			repairContext(true),
		).safeParse({
			kind: "plan-repair",
			reason: "The root boundary is wrong.",
			repairedPlan: draft,
		});
		expect(parsed.success).toBe(false);
		expect(
			parsed.error?.issues.map((issue) => issue.message).join("\n"),
		).toContain("requires case-action mode");
	});
});
