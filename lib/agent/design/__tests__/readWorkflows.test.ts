import { describe, expect, it } from "vitest";
import {
	deriveSliceExecutionBrief,
	renderBriefMessage,
} from "@/lib/agent/build/executionBrief";
import { buildPlanSchemaFor, deriveBuildPlan } from "../buildPlan";
import { appDesignContractSchema, designConstructionIssues } from "../contract";
import { hasCompleteReadSurfaces } from "../readWorkflows";
import {
	did,
	fixtureValue,
	ids,
	makeContract,
	makeWorkflowChainContract,
} from "./fixtures";

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

		startingConditions: ["The patient is registered."],
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
	it("carries a new reader persona into the slice that builds the existing list", () => {
		const { contract, workflow, module } = readingContract();
		const actor = {
			...structuredClone(contract.actors[0]),
			id: did(9900),
			name: "Reader",
		};
		contract.actors.push(actor);
		workflow.actorIds = [actor.id];
		module.actorIds.push(actor.id);
		contract.lists[0].actorIds.push(actor.id);
		const plan = deriveBuildPlan({
			contract: appDesignContractSchema.parse(contract),
			revision,
		});
		expect(plan.slices).toHaveLength(2);
		const owner = fixtureValue(plan.slices[0], "registration slice");
		expect(owner.constructionGroups.flatMap((group) => group.elements)).toEqual(
			expect.arrayContaining([
				{ kind: "actor", id: actor.id },
				{ kind: "workflow", id: workflow.id },
			]),
		);
		const brief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: owner.id,
		});
		expect(brief.actors).toContainEqual(actor);
		expect(brief.readWorkflows).toEqual([workflow]);
	});

	it("waits for a later menu owner before covering the reading task", () => {
		const contract = makeWorkflowChainContract(3);
		const [first, reading, last] = contract.workflows;
		const [firstModule, readingModule, lastModule] =
			contract.moduleCompositions;
		Object.assign(reading, {
			inputs: [],
			recordEffects: [],
			readback: structuredClone(first.readback),
			contextRecordId: contract.records[0].id,
		});

		contract.records.splice(1, 1);
		contract.formCompositions.splice(1, 1);
		const list = {
			...structuredClone(makeContract().lists[0]),
			id: did(9910),
			recordId: contract.records[0].id,
			actorIds: first.actorIds,
			scanPropertyIds: first.readback[0].propertyIds,
			detailPropertyIds: [],
			searchPropertyIds: [],
		};
		contract.lists.push(list);
		Object.assign(readingModule, {
			role: "queue-only",
			hostRecordId: list.recordId,
			parentModuleCompositionId: lastModule.id,
			listIds: [list.id],
		});
		contract.moduleCompositions = [firstModule, lastModule, readingModule];
		const parsed = appDesignContractSchema.parse(contract);
		expect(designConstructionIssues(parsed)).toEqual([]);
		const plan = deriveBuildPlan({ contract: parsed, revision });
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			first.id,
			last.id,
		]);
		const owner = plan.slices[1];
		expect(owner.prerequisiteSliceIds).toEqual([plan.slices[0].id]);
		const brief = deriveSliceExecutionBrief({
			contract: parsed,
			revision,
			plan,
			sliceId: owner.id,
		});
		expect(brief.readWorkflows).toEqual([reading]);
		expect(brief.moduleRealizations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					compositionId: readingModule.id,
					action: "create",
				}),
			]),
		);
		// An existing summary form already serves the task; a later alternative
		// list must not turn its otherwise valid dependency chain into a cycle.
		const form = makeWorkflowChainContract(3).formCompositions[1];
		form.moduleCompositionId = firstModule.id;
		form.mode = "selected-record";
		form.layout = {
			kind: "flat",
			rationale: "Show the saved value for this record.",
			items: [
				{
					kind: "record-summary",
					id: did(9911),
					recordId: contract.records[0].id,
					propertyIds: first.readback[0].propertyIds,
					purpose: "Read the saved value",
				},
			],
		};
		contract.formCompositions.splice(1, 0, form);
		firstModule.workflowIds.push(reading.id);
		firstModule.selection = {
			cases: "one",
		};
		const withForm = appDesignContractSchema.parse(contract);
		expect(designConstructionIssues(withForm)).toEqual([]);
		const withFormPlan = deriveBuildPlan({ contract: withForm, revision });
		expect(withFormPlan.slices).toHaveLength(3);
		const readingSlice = fixtureValue(
			withFormPlan.slices.find((slice) => slice.workflowId === reading.id),
			"reading slice",
		);
		const laterSlice = fixtureValue(
			withFormPlan.slices.find((slice) => slice.workflowId === last.id),
			"later menu slice",
		);
		expect(readingSlice.prerequisiteSliceIds).not.toContain(laterSlice.id);
	});

	it("retains a grouped task's context when its history and construction owner use different records", () => {
		const contract = makeWorkflowChainContract(3);
		const [context, history] = contract.records;
		const reading = {
			...readingContract().workflow,
			contextRecordId: context.id,

			readback: [
				{
					recordId: history.id,
					purpose: "Read this record's saved history",
					propertyIds: history.properties.map((property) => property.id),
				},
			],
		};
		contract.workflows.push(reading);
		contract.charter.includedWorkflowIds.push(reading.id);
		const list = {
			...structuredClone(makeContract().lists[0]),
			id: did(9920),
			recordId: history.id,
			actorIds: reading.actorIds,
			scanPropertyIds: reading.readback[0].propertyIds,
			detailPropertyIds: [],
			searchPropertyIds: [],
		};
		contract.lists.push(list);
		const module = contract.moduleCompositions[1];
		module.role = "form-and-queue";
		module.workflowIds.push(reading.id);
		module.listIds.push(list.id);
		const parsed = appDesignContractSchema.parse(contract);
		expect(designConstructionIssues(parsed)).toEqual([]);
		const plan = deriveBuildPlan({ contract: parsed, revision });
		expect(plan.slices).toHaveLength(3);
		const brief = deriveSliceExecutionBrief({
			contract: parsed,
			revision,
			plan,
			sliceId: plan.slices[1].id,
		});
		expect(brief.readWorkflows).toEqual([reading]);
		expect(brief.records.map((record) => record.id)).toContain(context.id);
		expect(brief.recordRealizations.map((record) => record.recordId)).toContain(
			context.id,
		);
		expect(renderBriefMessage(brief)).toContain(
			JSON.stringify({ id: context.id, name: context.name }).slice(0, -1),
		);
	});

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

	it("preserves external setup on the slice that constructs the reading surface", () => {
		const { contract, workflow } = readingContract();

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
			plan.slices.find((slice) => slice.workflowId === ids.taskRegister),
			"registration slice",
		);
		expect(
			owner.constructionGroups.flatMap((group) => group.elements),
		).toContainEqual({ kind: "workflow", id: workflow.id });
		expect(owner.prerequisiteSliceIds).toEqual([]);
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
