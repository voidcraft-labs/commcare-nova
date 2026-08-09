/**
 * validateSlicePlan — structural rules plus the contract-bound factory:
 * exact ownership, one dependency-closed materialization root, honest
 * external-action timing, scenario coverage, parent-selection reachability.
 */

import { describe, expect, it } from "vitest";
import {
	buildPlanSchema,
	buildPlanSchemaFor,
} from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import {
	cloneContract,
	did,
	ids,
	makeBuildPlan,
	makeContract,
} from "./fixtures";

const contract = appDesignContractSchema.parse(makeContract());

function messages(result: {
	success: boolean;
	error?: { issues: Array<{ message: string }> };
}) {
	return result.success
		? ""
		: (result.error?.issues ?? []).map((i) => i.message).join("\n");
}

describe("buildPlanSchema (structural)", () => {
	it("accepts the fixture plan", () => {
		const result = buildPlanSchema.safeParse(makeBuildPlan());
		expect(result.success, messages(result)).toBe(true);
	});

	it("rejects zero and two materialization roots", () => {
		const none = makeBuildPlan();
		const first = none.slices[0];
		if (!first) throw new Error("fixture has slices");
		first.role = "ordinary";
		expect(messages(buildPlanSchema.safeParse(none))).toContain(
			"No slice is the materialization root",
		);

		const two = makeBuildPlan();
		const second = two.slices[1];
		if (!second) throw new Error("fixture has two slices");
		second.role = "materialization-root";
		expect(messages(buildPlanSchema.safeParse(two))).toContain(
			"More than one slice",
		);
	});

	it("rejects a prerequisite cycle", () => {
		const plan = makeBuildPlan();
		plan.slices[0]?.prerequisiteSliceIds.push(ids.sliceVisit);
		expect(messages(buildPlanSchema.safeParse(plan))).toContain(
			"prerequisite cycle",
		);
	});

	it("rejects a materialization root with a prerequisite before persistence", () => {
		const plan = makeBuildPlan();
		const root = plan.slices[0];
		const later = plan.slices[1];
		if (!root || !later) throw new Error("fixture has two slices");
		later.prerequisiteSliceIds = [];
		root.prerequisiteSliceIds = [later.id];
		expect(messages(buildPlanSchema.safeParse(plan))).toContain(
			"materialization root cannot name prerequisite slices",
		);
	});

	it("rejects an unknown prerequisite and self-prerequisite", () => {
		const plan = makeBuildPlan();
		plan.slices[1]?.prerequisiteSliceIds.push(did(8888));
		expect(messages(buildPlanSchema.safeParse(plan))).toContain(
			"not a slice in this plan",
		);

		const self = makeBuildPlan();
		self.slices[1]?.prerequisiteSliceIds.push(ids.sliceVisit);
		expect(messages(buildPlanSchema.safeParse(self))).toContain("lists itself");
	});

	it("rejects an owned intent the slice does not name", () => {
		const plan = makeBuildPlan();
		plan.slices[1]?.ownedIntentIds.push(ids.navMain);
		expect(messages(buildPlanSchema.safeParse(plan))).toContain(
			"owns an intent it does not list",
		);
	});

	it("rejects ownership disagreement between rows and slices", () => {
		const plan = makeBuildPlan();
		const row = plan.intentOwnership.find(
			(entry) => entry.intentId === ids.recVisit,
		);
		if (!row) throw new Error("fixture owns recVisit");
		row.owningSliceId = ids.sliceRegister;
		expect(messages(buildPlanSchema.safeParse(plan))).toContain("disagree");
	});

	it("rejects a contributor that is also the owner", () => {
		const plan = makeBuildPlan();
		const row = plan.intentOwnership.find(
			(entry) => entry.intentId === ids.rmPatients,
		);
		if (!row) throw new Error("fixture owns rmPatients");
		row.contributingSliceIds = [ids.sliceRegister];
		expect(messages(buildPlanSchema.safeParse(plan))).toContain(
			"cannot also be listed as a contributor",
		);
	});

	it("rejects a data-migration slice inside the root closure", () => {
		const plan = makeBuildPlan();
		const root = plan.slices[0];
		if (!root) throw new Error("fixture has a root");
		root.risk = "data-migration";
		expect(messages(buildPlanSchema.safeParse(plan))).toContain(
			"no data to migrate",
		);
	});

	it("rejects a post-materialization external action in the root closure", () => {
		const plan = makeBuildPlan();
		plan.externalActions.push({
			id: did(500),
			kind: "hq-setup",
			timing: "after-slice",
			requiredFor: "runtime",
			description: "Configure the reminder rule in HQ.",
			idempotencyOwner: "user",
			completionEvidence: "The HQ rule list shows the reminder.",
		});
		plan.slices[0]?.externalActionIds.push(did(500));
		expect(messages(buildPlanSchema.safeParse(plan))).toContain(
			"named as manual setup",
		);
	});

	it("accepts a manual-setup action in the root closure", () => {
		const plan = makeBuildPlan();
		plan.externalActions.push({
			id: did(501),
			kind: "manual",
			timing: "manual-setup",
			requiredFor: "deployment",
			description: "Create the HQ project space.",
			idempotencyOwner: "user",
			completionEvidence: "The project space exists.",
		});
		plan.slices[0]?.externalActionIds.push(did(501));
		const result = buildPlanSchema.safeParse(plan);
		expect(result.success, messages(result)).toBe(true);
	});

	it("rejects blocking external actions while no receipt producer is registered", () => {
		for (const timing of ["before-materialization", "before-slice"] as const) {
			const plan = makeBuildPlan();
			plan.externalActions.push({
				id: timing === "before-slice" ? did(502) : did(503),
				kind: "manual",
				timing,
				requiredFor: "construction",
				description: "Complete a prerequisite outside the Blueprint.",
				idempotencyOwner: "user",
				completionEvidence: "The prerequisite is complete.",
			});
			expect(messages(buildPlanSchema.safeParse(plan))).toContain(
				"no registered completion producer",
			);
		}
	});
});

describe("buildPlanSchemaFor (contract-bound)", () => {
	it("accepts the fixture plan against the fixture contract", () => {
		const result = buildPlanSchemaFor(contract).safeParse(makeBuildPlan());
		expect(result.success, messages(result)).toBe(true);
	});

	it("rejects a slice intent that is not implementable in the contract", () => {
		const plan = makeBuildPlan();
		plan.slices[1]?.intentIds.push(ids.actorChw);
		expect(messages(buildPlanSchemaFor(contract).safeParse(plan))).toContain(
			"not an implementable intent",
		);
	});

	it("rejects a plan that leaves an implementable intent unowned", () => {
		const plan = makeBuildPlan();
		plan.intentOwnership = plan.intentOwnership.filter(
			(entry) => entry.intentId !== ids.navMain,
		);
		const slice = plan.slices[0];
		if (!slice) throw new Error("fixture has a root slice");
		slice.ownedIntentIds = slice.ownedIntentIds.filter(
			(id) => id !== ids.navMain,
		);
		expect(messages(buildPlanSchemaFor(contract).safeParse(plan))).toContain(
			"no owning slice",
		);
	});

	it("rejects an unclaimed acceptance scenario", () => {
		const plan = makeBuildPlan();
		const root = plan.slices[0];
		if (!root) throw new Error("fixture has a root slice");
		root.acceptanceScenarioIds = [ids.scenarioRegister];
		expect(messages(buildPlanSchemaFor(contract).safeParse(plan))).toContain(
			"belongs to no slice",
		);
	});

	it("rejects a child-creating slice that cannot reach a parent read model", () => {
		const plan = makeBuildPlan();
		const visit = plan.slices[1];
		if (!visit) throw new Error("fixture has the visit slice");
		visit.prerequisiteSliceIds = [];
		visit.intentIds = visit.intentIds.filter((id) => id !== ids.rmPatients);
		expect(messages(buildPlanSchemaFor(contract).safeParse(plan))).toContain(
			"read model over the parent record",
		);
	});

	it("accepts the child-creating slice when the parent read model is its own intent", () => {
		const plan = makeBuildPlan();
		const visit = plan.slices[1];
		if (!visit) throw new Error("fixture has the visit slice");
		visit.prerequisiteSliceIds = [];
		// rmPatients stays in intentIds — the slice carries its own selection
		// surface, so the closure is intact without the prerequisite.
		const result = buildPlanSchemaFor(contract).safeParse(plan);
		expect(result.success, messages(result)).toBe(true);
	});
});

describe("makeContract/makeBuildPlan fixture agreement", () => {
	it("the plan's ownership covers exactly the contract's implementable intents", () => {
		const plan = makeBuildPlan();
		const owned = new Set(plan.intentOwnership.map((entry) => entry.intentId));
		const implementable = [
			...contract.records,
			...contract.facts,
			...contract.rules,
			...contract.tasks,
			...contract.transitions,
			...contract.readModels,
			...contract.accessPolicies,
			...contract.navigation,
		].map((intent) => intent.id);
		expect([...owned].sort()).toEqual([...implementable].sort());
	});

	it("cloned fixture edits never leak between tests", () => {
		const first = makeBuildPlan();
		first.slices[0]?.ownedIntentIds.push(did(777));
		expect(makeBuildPlan().slices[0]?.ownedIntentIds.includes(did(777))).toBe(
			false,
		);

		const contractCopy = cloneContract(makeContract());
		contractCopy.tasks[0]?.writes.pop();
		expect(makeContract().tasks[0]?.writes).toHaveLength(3);
	});
});
