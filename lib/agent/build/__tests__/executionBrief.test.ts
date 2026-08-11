import { describe, expect, it } from "vitest";
import {
	briefDigest,
	deriveSliceExecutionBrief,
	renderBriefMessage,
} from "@/lib/agent/build/executionBrief";
import {
	cloneContract,
	did,
	ids,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import { PLATFORM_CONSTRAINT_CODES } from "@/lib/agent/design/platformConstraints";

const REVISION = { id: ids.revisionId, digest: "b".repeat(64) };

function briefAt(index: number) {
	const plan = makeBuildPlan();
	const slice = plan.slices[index];
	if (!slice) throw new Error("fixture slice missing");
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: REVISION,
		plan,
		sliceId: slice.id,
	});
}

describe("deriveSliceExecutionBrief", () => {
	it("carries one workflow and its real construction groups", () => {
		const brief = briefAt(0);
		expect(brief.workflow.id).toBe(ids.taskRegister);
		expect(brief.constructionGroupIds).toEqual(
			brief.slice.constructionGroups.map((group) => group.id),
		);
		expect(brief.records.map((record) => record.id)).toContain(ids.recPatient);
		expect(brief.actors.map((actor) => actor.id)).toContain(ids.actorChw);
	});

	it("includes prerequisite workflow context without merging workflow work", () => {
		const brief = briefAt(1);
		expect(brief.workflow.id).toBe(ids.taskVisit);
		expect(brief.prerequisiteWorkflows).toEqual([
			{
				id: ids.taskRegister,
				name: "Register patient",
				goal: "Create a usable patient record.",
			},
		]);
		expect(brief.records.map((record) => record.id)).toEqual([
			ids.recPatient,
			ids.recVisit,
		]);
	});

	it("carries app-wide decisions only on materialization", () => {
		expect(briefAt(0).decisions.map((decision) => decision.id)).toEqual([
			ids.decision,
		]);
		expect(briefAt(1).decisions).toEqual([]);
	});

	it("keeps legacy all-external plan groups as context, not executable coverage", () => {
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
			revision: REVISION,
			planId: ids.planId,
		});
		plan.slices[0]?.constructionGroups.push({
			id: did(5000),
			workflowId: ids.taskRegister,
			name: "External readiness",
			kind: "foundation",
			elements: [{ kind: "external-requirement", id: ids.externalSetup }],
			blueprintAreas: ["media-references"],
		});
		const sliceId = plan.slices[0]?.id;
		if (!sliceId) throw new Error("fixture slice missing");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId,
		});

		expect(brief.externalRequirements.map((item) => item.id)).toEqual([
			ids.externalSetup,
		]);
		expect(brief.constructionGroupIds).not.toContain(did(5000));
		expect(
			brief.slice.constructionGroups.some((group) =>
				group.elements.some(
					(element) => element.kind === "external-requirement",
				),
			),
		).toBe(false);
	});

	it("binds exact revision, plan, constraints, and capability boundary", () => {
		const brief = briefAt(0);
		expect(brief.designRevisionId).toBe(REVISION.id);
		expect(brief.buildPlanId).toBe(makeBuildPlan().id);
		expect(brief.loweringConstraints.map((entry) => entry.code)).toEqual([
			...PLATFORM_CONSTRAINT_CODES,
		]);
		expect(brief.capabilityBoundary.sessionBoundary).toEqual({
			appCount: 1,
			projectScope: "current-project",
		});
	});

	it("renders a concise workflow-scoped executor message", () => {
		const message = renderBriefMessage(briefAt(1));
		expect(message).toContain("One-app charter");
		expect(message).toContain("Record visit");
		expect(message).toContain("construction groups");
		expect(message).not.toContain("intentOwnership");
	});

	it("has a stable digest and refuses unknown slices", () => {
		expect(briefDigest(briefAt(0))).toBe(briefDigest(briefAt(0)));
		expect(briefDigest(briefAt(0))).not.toBe(briefDigest(briefAt(1)));
		expect(() =>
			deriveSliceExecutionBrief({
				contract: makeContract(),
				revision: REVISION,
				plan: makeBuildPlan(),
				sliceId: did(9999),
			}),
		).toThrow(/holds no slice/);
	});
});
