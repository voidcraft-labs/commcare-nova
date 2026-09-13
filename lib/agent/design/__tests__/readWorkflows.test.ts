import { describe, expect, it } from "vitest";
import {
	deriveSliceExecutionBrief,
	renderBriefMessage,
} from "@/lib/agent/build/executionBrief";
import { buildPlanSchemaFor, deriveBuildPlan } from "../buildPlan";
import { appDesignContractSchema, designConstructionIssues } from "../contract";
import { hasCompleteReadSurfaces } from "../readWorkflows";
import { did, fixtureValue, ids, makeContract } from "./fixtures";

const revision = { id: ids.revisionId, digest: "b".repeat(64) };

function readingContract() {
	const contract = makeContract();
	const module = fixtureValue(contract.moduleCompositions[0], "patient module");
	const workflow = {
		...structuredClone(fixtureValue(contract.workflows[0], "registration")),
		id: ids.taskReview,
		name: "Read patient details",
		goal: "Read the patient's name and age without changing their record.",
		trigger: "Open a patient from the list.",
		contextRecordId: ids.recPatient,
		prerequisiteWorkflowIds: [ids.taskRegister],
		prerequisites: ["The patient is registered."],
		inputs: [],
		decisions: [],
		recordEffects: [],
		authoredFeatures: [],
		readback: [
			{
				recordId: ids.recPatient,
				purpose: "Read patient details",
				propertyIds: [ids.factName, ids.factAge],
			},
		],
		acceptanceExamples: [
			{
				name: "Read a saved patient",
				given: ["A patient has a saved name and age."],
				when: ["The worker opens the patient's details."],
				expectedResults: [
					"The saved name and age are visible. Nothing is submitted or changed.",
				],
			},
		],
	};
	contract.workflows.push(workflow);
	contract.charter.includedWorkflowIds.push(workflow.id);
	module.workflowIds.push(workflow.id);
	return { contract, workflow, module };
}

describe("read-only workflows", () => {
	it("keeps a construction slice for a read task that creates its own list", () => {
		const { contract, workflow, module } = readingContract();
		module.workflowIds = module.workflowIds.filter((id) => id !== workflow.id);
		const list = {
			...structuredClone(fixtureValue(contract.lists[0], "patient list")),
			id: did(9850),
			name: "Patient details",
		};
		contract.lists.push(list);
		const readingModule = {
			...structuredClone(module),
			id: did(9851),
			name: "Patient details",
			role: "queue-only" as const,
			workflowIds: [workflow.id],
			listIds: [list.id],
		};
		delete readingModule.selection;
		contract.moduleCompositions.push(readingModule);
		const plan = deriveBuildPlan({
			contract: appDesignContractSchema.parse(contract),
			revision,
		});
		const slice = fixtureValue(
			plan.slices.find((item) => item.workflowId === workflow.id),
			"read slice",
		);
		expect(plan.slices).toHaveLength(3);
		const brief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: slice.id,
		});
		expect(brief.formRealizations).toEqual([]);
		expect(
			brief.moduleRealizations.find(
				(item) => item.compositionId === readingModule.id,
			)?.action,
		).toBe("create");
		expect(brief.toolProfile.mutationTools).toContain("createModule");
		expect(brief.toolProfile.mutationTools).not.toContain("createForm");
	});

	it("admits a complete list and detail task without a form and builds it with its existing surfaces", () => {
		const { contract, workflow } = readingContract();
		appDesignContractSchema.parse(contract);
		expect(designConstructionIssues(contract)).toEqual([]);
		const plan = deriveBuildPlan({ contract, revision });
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			ids.taskRegister,
			ids.taskVisit,
		]);
		const owner = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskRegister),
			"registration slice",
		);
		const covered = plan.slices.flatMap((slice) =>
			slice.constructionGroups.flatMap((group) =>
				group.elements.filter((element) => element.kind === "workflow"),
			),
		);
		expect(covered.map((element) => element.id).sort()).toEqual(
			contract.charter.includedWorkflowIds.toSorted(),
		);
		const brief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: owner.id,
		});
		expect(brief.readWorkflows).toEqual([workflow]);
		expect(brief.formRealizations.map((form) => form.compositionId)).toEqual([
			ids.formRegister,
		]);
		expect(renderBriefMessage(brief)).toContain(workflow.goal);
		expect(brief.lists.flatMap((list) => list.detailPropertyIds)).toContain(
			ids.factAge,
		);
		const missingReadTask = structuredClone(plan);
		for (const slice of missingReadTask.slices)
			for (const group of slice.constructionGroups)
				group.elements = group.elements.filter(
					(element) => element.id !== workflow.id,
				);
		expect(
			buildPlanSchemaFor(contract).safeParse(missingReadTask).success,
		).toBe(false);
	});

	it("keeps the read task after its last prerequisite and preserves its external setup", () => {
		const { contract, workflow } = readingContract();
		workflow.prerequisiteWorkflowIds = [ids.taskVisit];
		const requirement = {
			id: did(9800),
			name: "Assign the device's records",
			kind: "runtime-readiness" as const,
			description:
				"Assign existing patient records to the reviewing worker before synchronization.",
			relatedWorkflowIds: [workflow.id],
			blocksConstruction: false,
		};
		contract.externalRequirements.push(requirement);
		workflow.externalRequirementIds = [requirement.id];
		requirement.relatedWorkflowIds = [workflow.id];
		const plan = deriveBuildPlan({
			contract: appDesignContractSchema.parse(contract),
			revision,
		});
		const owner = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskVisit),
			"visit slice",
		);
		expect(
			owner.constructionGroups.flatMap((group) => group.elements),
		).toContainEqual({ kind: "workflow", id: workflow.id });
		expect(owner.prerequisiteSliceIds).toEqual([plan.slices[0].id]);
		expect(owner.externalActionIds).toEqual(
			plan.externalActions.map((action) => action.id),
		);
		const brief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: owner.id,
		});
		expect(brief.readWorkflows).toEqual([workflow]);
		expect(brief.externalRequirements).toEqual([requirement]);
		expect(
			brief.records
				.find((record) => record.id === ids.recPatient)
				?.properties.map((property) => property.id),
		).toContain(ids.factAge);
	});

	it("requires a visible read surface for every property and actor", () => {
		const { contract, workflow, module } = readingContract();
		expect(hasCompleteReadSurfaces(contract, workflow)).toBe(true);
		for (const list of contract.lists) {
			list.detailPropertyIds = list.detailPropertyIds.filter(
				(id) => id !== ids.factAge,
			);
			list.scanPropertyIds = list.scanPropertyIds.filter(
				(id) => id !== ids.factAge,
			);
			list.searchPropertyIds.push(ids.factAge);
		}
		expect(hasCompleteReadSurfaces(contract, workflow)).toBe(false);
		expect(
			designConstructionIssues(contract).some((issue) =>
				issue.message.includes("read-only task"),
			),
		).toBe(true);
		const complete = readingContract();
		complete.module.actorIds = complete.module.actorIds.filter(
			(id) => id !== complete.workflow.actorIds[0],
		);
		expect(hasCompleteReadSurfaces(complete.contract, complete.workflow)).toBe(
			false,
		);
		module.workflowIds = module.workflowIds.filter((id) => id !== workflow.id);
		expect(hasCompleteReadSurfaces(contract, workflow)).toBe(false);
	});

	it("still requires a form when a workflow captures an answer or changes a record", () => {
		for (const member of ["inputs", "recordEffects"] as const) {
			const { contract, workflow } = readingContract();
			Object.assign(workflow, { [member]: contract.workflows[0][member] });
			expect(hasCompleteReadSurfaces(contract, workflow)).toBe(false);
			expect(
				designConstructionIssues(contract).some((issue) =>
					issue.message.includes("read-only task"),
				),
			).toBe(true);
		}
	});
});
