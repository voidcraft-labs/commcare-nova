import { describe, expect, it } from "vitest";
import {
	buildPlanSchema,
	buildPlanSchemaFor,
	deriveBuildPlan,
	newPlanAdmissionMessages,
} from "@/lib/agent/design/buildPlan";
import {
	cloneContract,
	did,
	ids,
	makeBuildPlan,
	makeContract,
} from "./fixtures";

function messages(
	result: ReturnType<typeof buildPlanSchema.safeParse>,
): string {
	return result.success
		? ""
		: result.error.issues.map((issue) => issue.message).join("\n");
}

describe("deterministic build planning", () => {
	it("derives one dependency-ordered slice per workflow", () => {
		const plan = makeBuildPlan();
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			ids.taskRegister,
			ids.taskVisit,
		]);
		expect(plan.slices[0]?.role).toBe("materialization-root");
		expect(plan.slices[1]?.prerequisiteSliceIds).toEqual([plan.slices[0]?.id]);
	});

	it("is stable for the same accepted revision", () => {
		const first = makeBuildPlan();
		const second = makeBuildPlan();
		expect(second).toEqual(first);
	});

	it("assigns every buildable design element exactly once", () => {
		const contract = makeContract();
		const plan = makeBuildPlan();
		const assigned = plan.slices.flatMap((slice) =>
			slice.constructionGroups.flatMap((group) =>
				group.elements.map((element) => element.id),
			),
		);
		expect(new Set(assigned).size).toBe(assigned.length);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});

	it("rejects duplicate workflow slices and construction groups", () => {
		const duplicateWorkflow = makeBuildPlan();
		if (!duplicateWorkflow.slices[0] || !duplicateWorkflow.slices[1]) {
			throw new Error("fixture needs two slices");
		}
		duplicateWorkflow.slices[1].workflowId =
			duplicateWorkflow.slices[0].workflowId;
		expect(messages(buildPlanSchema.safeParse(duplicateWorkflow))).toContain(
			"exactly one slice",
		);

		const duplicateGroup = makeBuildPlan();
		const firstGroup = duplicateGroup.slices[0]?.constructionGroups[0];
		const secondGroup = duplicateGroup.slices[1]?.constructionGroups[0];
		if (!firstGroup || !secondGroup) throw new Error("fixture needs groups");
		secondGroup.id = firstGroup.id;
		expect(messages(buildPlanSchema.safeParse(duplicateGroup))).toContain(
			"group ids must be unique",
		);
	});

	it("rejects prerequisite cycles and unknown prerequisites", () => {
		const cyclic = makeBuildPlan();
		const first = cyclic.slices[0];
		const second = cyclic.slices[1];
		if (!first || !second) throw new Error("fixture needs two slices");
		first.prerequisiteSliceIds = [second.id];
		expect(messages(buildPlanSchema.safeParse(cyclic))).toContain("acyclic");

		const unknown = makeBuildPlan();
		unknown.slices[1]?.prerequisiteSliceIds.push(did(9999));
		expect(messages(buildPlanSchema.safeParse(unknown))).toContain(
			"does not exist",
		);
	});

	it("rejects missing or foreign contract elements", () => {
		const missing = makeBuildPlan();
		missing.slices[0]?.constructionGroups[0]?.elements.pop();
		expect(buildPlanSchemaFor(makeContract()).safeParse(missing).success).toBe(
			false,
		);

		const foreign = makeBuildPlan();
		foreign.slices[0]?.constructionGroups[0]?.elements.push({
			kind: "record",
			id: did(7777),
		});
		expect(buildPlanSchemaFor(makeContract()).safeParse(foreign).success).toBe(
			false,
		);
	});

	it("changes slice identities when the accepted revision digest changes", () => {
		const contract = cloneContract(makeContract());
		const changed = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "c".repeat(64) },
			planId: ids.planId,
		});
		expect(changed.slices[0]?.id).not.toBe(makeBuildPlan().slices[0]?.id);
	});

	it("refuses to derive construction for a one-value controlled choice", () => {
		const contract = cloneContract(makeContract());
		const risk = contract.records[0]?.properties.find(
			(property) => property.id === ids.factRisk,
		);
		if (!risk) throw new Error("fixture risk property missing");
		risk.choiceValues = ["priority"];
		expect(() =>
			deriveBuildPlan({
				contract,
				revision: { id: ids.revisionId, digest: "a".repeat(64) },
				planId: ids.planId,
			}),
		).toThrow(/not constructible/);
	});

	it("derives construction for a specifically named existing lookup choice", () => {
		const contract = cloneContract(makeContract());
		const risk = contract.records[0]?.properties.find(
			(property) => property.id === ids.factRisk,
		);
		if (!risk) throw new Error("fixture risk property missing");
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			table: "Referral urgency",
			valueColumn: "code",
			labelColumn: "name",
		};
		expect(
			deriveBuildPlan({
				contract,
				revision: { id: ids.revisionId, digest: "a".repeat(64) },
				planId: ids.planId,
			}).slices,
		).not.toHaveLength(0);
	});

	it("refuses blocking external actions until a receipt producer exists", () => {
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Existing media",
			kind: "existing-reference",
			description: "Select an existing Project media asset.",
			relatedWorkflowIds: [ids.taskRegister],
			timing: "before-construction",
			blocksConstruction: true,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		contract.openQuestions.push({
			id: ids.question,
			question: "Which existing media asset should be attached?",
			structuralImpact: "local",
			blocking: true,
			relatedElementIds: [ids.externalSetup],
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "d".repeat(64) },
			planId: ids.planId,
		});
		expect(newPlanAdmissionMessages(plan)).toHaveLength(1);
		expect(newPlanAdmissionMessages(plan)[0]).toContain(
			"no registered completion producer",
		);
	});

	it("keeps non-blocking workflow readiness out of construction gating", () => {
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Worker setup",
			kind: "runtime-readiness",
			description: "Configure the worker role before people run this workflow.",
			relatedWorkflowIds: [ids.taskRegister],
			timing: "before-workflow",
			blocksConstruction: false,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "e".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.externalActions[0]).toMatchObject({
			timing: "after-slice",
			requiredFor: "runtime",
		});
		expect(
			plan.slices
				.flatMap((slice) => slice.constructionGroups)
				.some((group) =>
					group.elements.some(
						(element) => element.kind === "external-requirement",
					),
				),
		).toBe(false);
		expect(newPlanAdmissionMessages(plan)).toEqual([]);
	});

	it("reads persisted v1 all-external groups without requiring them in new plans", () => {
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Worker setup",
			kind: "runtime-readiness",
			description: "Configure workers before runtime.",
			relatedWorkflowIds: [ids.taskRegister],
			timing: "before-workflow",
			blocksConstruction: false,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "f".repeat(64) },
			planId: ids.planId,
		});
		expect(
			plan.slices
				.flatMap((slice) => slice.constructionGroups)
				.some((group) =>
					group.elements.some(
						(element) => element.kind === "external-requirement",
					),
				),
		).toBe(false);

		plan.slices[0]?.constructionGroups.push({
			id: did(5000),
			workflowId: ids.taskRegister,
			name: "External readiness",
			kind: "foundation",
			elements: [{ kind: "external-requirement", id: ids.externalSetup }],
			blueprintAreas: ["media-references"],
		});
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});
});
