import { describe, expect, it } from "vitest";
import {
	buildPlanSchema,
	buildPlanSchemaFor,
	deriveBuildPlan,
	newPlanAdmissionMessages,
} from "@/lib/agent/design/buildPlan";
import { computeLookupChoiceProjectionAttestation } from "@/lib/agent/design/lookupChoiceAttestation";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
import {
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
	makeNestedMenuContract,
	makeThirteenWorkflowContract,
} from "./fixtures";

const EXISTING_TABLE_ID = lookupTableIdSchema.parse(
	"018f0000-0000-7000-8000-000000000001",
);
const EXISTING_VALUE_COLUMN_ID = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000002",
);
const EXISTING_LABEL_COLUMN_ID = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000003",
);
const EXISTING_ROW_ID = lookupRowIdSchema.parse(
	"018f0000-0000-7000-8000-000000000004",
);
const EXISTING_SECOND_ROW_ID = lookupRowIdSchema.parse(
	"018f0000-0000-7000-8000-000000000005",
);

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
		expect(plan.schemaVersion).toBe(1);
		expect(plan.lookupMaterialization).toBeNull();
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			ids.taskRegister,
			ids.taskVisit,
		]);
		expect(plan.slices[0]?.role).toBe("materialization-root");
		expect(plan.slices[1]?.prerequisiteSliceIds).toEqual([plan.slices[0]?.id]);
	});

	it("adds the parent owner as the child module owner's prerequisite", () => {
		const contract = makeNestedMenuContract();
		const childWorkflow = fixtureValue(
			contract.workflows.find((workflow) => workflow.id === ids.taskVisit),
			"child workflow",
		);
		childWorkflow.prerequisiteWorkflowIds = [];
		childWorkflow.prerequisites = [];
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const parentSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskRegister),
			"parent owner slice",
		);
		const childSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskVisit),
			"child owner slice",
		);
		expect(parentSlice.role).toBe("materialization-root");
		expect(parentSlice.prerequisiteSliceIds).toEqual([]);
		expect(childSlice.prerequisiteSliceIds).toContain(parentSlice.id);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});

	it("adds a different-record parent's first form owner as a prerequisite", () => {
		const contract = cloneContract(makeThirteenWorkflowContract());
		for (const workflow of contract.workflows) {
			workflow.prerequisiteWorkflowIds = [];
			workflow.prerequisites = [];
		}
		const parent = fixtureValue(
			contract.moduleCompositions[0],
			"parent module",
		);
		const displaced = fixtureValue(
			contract.moduleCompositions[1],
			"displaced root module",
		);
		const child = fixtureValue(contract.moduleCompositions[2], "child module");
		const parentOwner = fixtureValue(contract.workflows[0], "parent owner");
		const parentFormOwner = fixtureValue(
			contract.workflows[1],
			"parent form owner",
		);
		const childOwner = fixtureValue(contract.workflows[2], "child owner");
		const parentOwnerForm = fixtureValue(
			contract.formCompositions[0],
			"parent owner form",
		);
		const parentForm = fixtureValue(
			contract.formCompositions[1],
			"later parent form",
		);
		parent.workflowIds = [parentOwner.id, parentFormOwner.id];
		parentForm.moduleCompositionId = parent.id;
		parentOwnerForm.moduleCompositionId = displaced.id;
		displaced.workflowIds = [parentOwner.id, parentFormOwner.id];
		child.parentModuleCompositionId = parent.id;
		contract.moduleCompositions.splice(0, 3, parent, child, displaced);

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const childSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === childOwner.id),
			"child slice",
		);
		const prerequisites = childSlice.prerequisiteSliceIds.map(
			(id) => plan.slices.find((slice) => slice.id === id)?.workflowId,
		);
		expect(prerequisites).toEqual(
			expect.arrayContaining([parentOwner.id, parentFormOwner.id]),
		);
	});

	it("schedules a child viewer before a parent-menu form creates its cases", () => {
		const contract = cloneContract(makeThirteenWorkflowContract());
		for (const workflow of contract.workflows) {
			workflow.prerequisiteWorkflowIds = [];
			workflow.prerequisites = [];
		}
		const parent = fixtureValue(
			contract.moduleCompositions[0],
			"parent module",
		);
		const child = fixtureValue(contract.moduleCompositions[1], "child module");
		const parentOwner = fixtureValue(contract.workflows[0], "parent owner");
		const childOwner = fixtureValue(contract.workflows[1], "child owner");
		const writer = fixtureValue(contract.workflows[2], "parent form writer");
		const writerForm = fixtureValue(
			contract.formCompositions[2],
			"parent form writer composition",
		);
		const childRecord = fixtureValue(
			contract.records.find((record) => record.id === child.hostRecordId),
			"child record",
		);
		const childProperty = fixtureValue(
			childRecord.properties[0],
			"child property",
		);
		const writerEffect = fixtureValue(
			writer.recordEffects[0],
			"writer create effect",
		);
		const writerWrite = fixtureValue(writerEffect.writes[0], "writer value");
		parent.workflowIds = [parentOwner.id, writer.id];
		child.parentModuleCompositionId = parent.id;
		writerForm.moduleCompositionId = parent.id;
		writerEffect.recordId = fixtureValue(
			child.hostRecordId,
			"child host record",
		);
		writerWrite.propertyId = childProperty.id;

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const writerSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === writer.id),
			"writer slice",
		);
		const prerequisites = writerSlice.prerequisiteSliceIds.map(
			(id) => plan.slices.find((slice) => slice.id === id)?.workflowId,
		);
		expect(prerequisites).toContain(childOwner.id);
	});

	it("adds the exact preceding sibling owner as a placement prerequisite", () => {
		const contract = makeThirteenWorkflowContract();
		for (const workflow of contract.workflows) {
			workflow.prerequisiteWorkflowIds = [];
			workflow.prerequisites = [];
		}
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const first = fixtureValue(plan.slices[0], "first module owner slice");
		const second = fixtureValue(plan.slices[1], "second module owner slice");
		const third = fixtureValue(plan.slices[2], "third module owner slice");

		expect(first.role).toBe("materialization-root");
		expect(first.prerequisiteSliceIds).toEqual([]);
		expect(second.prerequisiteSliceIds).toEqual([first.id]);
		expect(third.prerequisiteSliceIds).toEqual([second.id]);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
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

	it("owns shared module composition once and keeps each form layout with its workflow", () => {
		const plan = makeBuildPlan();
		const first = plan.slices.find(
			(slice) => slice.workflowId === ids.taskRegister,
		);
		const second = plan.slices.find(
			(slice) => slice.workflowId === ids.taskVisit,
		);
		const elements = (slice: NonNullable<typeof first>) =>
			slice.constructionGroups.flatMap((group) => group.elements);
		expect(elements(first as NonNullable<typeof first>)).toEqual(
			expect.arrayContaining([
				{ kind: "module-composition", id: ids.modulePatients },
				{ kind: "form-composition", id: ids.formRegister },
				{ kind: "composition-section", id: ids.sectionRegisterIdentity },
				{ kind: "composition-item", id: ids.itemRegisterGuidance },
			]),
		);
		expect(elements(second as NonNullable<typeof second>)).toEqual(
			expect.arrayContaining([
				{ kind: "form-composition", id: ids.formVisit },
				{ kind: "composition-section", id: ids.sectionVisit },
				{ kind: "composition-item", id: ids.itemVisitSummary },
			]),
		);
		expect(
			plan.slices
				.flatMap((slice) => elements(slice))
				.filter((element) => element.id === ids.modulePatients),
		).toHaveLength(1);
	});

	it("derives thirteen exact workflow slices with unique construction ownership", () => {
		const contract = makeThirteenWorkflowContract();
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.slices).toHaveLength(13);
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual(
			contract.charter.includedWorkflowIds,
		);
		const owned = plan.slices.flatMap((slice) =>
			slice.constructionGroups.flatMap((group) =>
				group.elements.map((element) => `${element.kind}:${element.id}`),
			),
		);
		expect(new Set(owned).size).toBe(owned.length);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});

	it("puts the materialization root first and gives it the only app-area owner", () => {
		const contract = cloneContract(makeContract());
		contract.records = [];
		contract.lists = [];
		contract.access = [];
		contract.workflows.forEach((workflow, index) => {
			workflow.contextRecordId = undefined;
			workflow.prerequisiteWorkflowIds = [];
			workflow.prerequisites = [];
			workflow.inputs = [
				{
					handle: `answer_${index}`,
					name: `Answer ${index}`,
					purpose: "Collect one standalone answer",
					dataShape: "text",
				},
			];
			workflow.decisions = [];
			workflow.recordEffects = [];
			workflow.readback = [];
		});
		contract.navigation.forEach((navigation) => {
			navigation.listIds = [];
		});
		contract.charter.initialWorkflowId = ids.taskVisit;

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "9".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.slices[0]?.workflowId).toBe(ids.taskVisit);
		expect(plan.slices[0]?.role).toBe("materialization-root");
		const appOwners = plan.slices.flatMap((slice) =>
			slice.constructionGroups
				.filter((group) => group.blueprintAreas.includes("app"))
				.map((group) => ({ slice, group })),
		);
		expect(appOwners).toHaveLength(1);
		expect(appOwners[0]?.slice.role).toBe("materialization-root");
		expect(appOwners[0]?.group.kind).toBe("workflow");
	});

	it("keeps generic reads permissive while enforcing exact app ownership for derived plans", () => {
		const contract = makeContract();
		const plan = makeBuildPlan();
		const laterGroup = plan.slices
			.slice(1)
			.flatMap((slice) => slice.constructionGroups)
			.find((group) => !group.blueprintAreas.includes("app"));
		if (laterGroup === undefined)
			throw new Error("fixture needs a later group");
		laterGroup.blueprintAreas.push("app");

		expect(buildPlanSchema.safeParse(plan).success).toBe(true);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(false);
	});

	it("derives media and automation areas from explicit workflow semantics", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows[0];
		if (workflow === undefined) throw new Error("fixture workflow missing");
		workflow.authoredFeatures = ["existing-media", "automation"];
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const group = plan.slices[0]?.constructionGroups.find((candidate) =>
			candidate.elements.some((element) => element.kind === "workflow"),
		);
		expect(group?.blueprintAreas).toEqual(
			expect.arrayContaining(["media-references", "automations"]),
		);
	});

	it("mounts case operations for a single effect targeting a non-context record", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows.find(
			(candidate) => candidate.id === ids.taskVisit,
		);
		if (workflow === undefined) throw new Error("visit workflow missing");
		const effect = workflow.recordEffects[0];
		if (effect === undefined) throw new Error("visit effect missing");
		delete effect.sourceRecordId;
		expect(effect.recordId).not.toBe(workflow.contextRecordId);

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const workflowGroup = plan.slices
			.find((slice) => slice.workflowId === workflow.id)
			?.constructionGroups.find((group) => group.kind === "workflow");
		expect(workflowGroup?.blueprintAreas).toContain("case-operations");
	});

	it("plans a standalone form workflow without inventing a record effect", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows[0];
		if (workflow === undefined) throw new Error("fixture workflow missing");
		workflow.inputs = [
			{
				handle: "survey_answer",
				name: "Survey answer",
				purpose: "Collect a standalone response",
				dataShape: "text",
			},
		];
		workflow.decisions = [];
		workflow.recordEffects = [];
		workflow.readback = [];
		expect(() =>
			deriveBuildPlan({
				contract,
				revision: { id: ids.revisionId, digest: "1".repeat(64) },
				planId: ids.planId,
			}),
		).not.toThrow();
	});

	it("authorizes case operations for a standalone conditional primary create", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows.find(
			(candidate) => candidate.id === ids.taskRegister,
		);
		if (workflow === undefined)
			throw new Error("registration workflow missing");
		const effect = workflow.recordEffects[0];
		if (effect === undefined) throw new Error("create effect missing");
		effect.condition = "The worker gave consent";
		const existingModule = contract.moduleCompositions[0];
		if (existingModule === undefined) throw new Error("module missing");
		existingModule.workflowIds = existingModule.workflowIds.filter(
			(id) => id !== workflow.id,
		);
		const standaloneModuleId = did(880);
		contract.moduleCompositions.unshift({
			id: standaloneModuleId,
			name: "Consent registration",
			purpose: "Host conditional registration without selected record context.",
			role: "form-host",
			workflowIds: [workflow.id],
			actorIds: workflow.actorIds,
			navigationIds: [],
			listIds: [],
			orderRationale: "Registration precedes patient follow-up.",
			icon: { kind: "builtin", slug: "default" },
			roleSeparationRationale:
				"Conditional creation cannot use the patient-hosted registration form.",
		});
		const form = contract.formCompositions.find(
			(candidate) => candidate.workflowId === workflow.id,
		);
		if (form === undefined) throw new Error("registration form missing");
		form.moduleCompositionId = standaloneModuleId;
		form.mode = "standalone";

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const workflowGroup = plan.slices
			.find((slice) => slice.workflowId === workflow.id)
			?.constructionGroups.find((group) => group.kind === "workflow");
		expect(workflowGroup?.blueprintAreas).toContain("case-operations");
	});

	it("keeps a list and its queue-only properties with the workflow that materializes its module", () => {
		const contract = cloneContract(makeContract());
		const readOnly = did(34);
		const queueOnly = did(35);
		const patient = contract.records.find(
			(record) => record.id === ids.recPatient,
		);
		const visit = contract.workflows.find(
			(workflow) => workflow.id === ids.taskVisit,
		);
		const list = contract.lists.find((entry) => entry.id === ids.rmPatients);
		if (patient === undefined || visit === undefined || list === undefined) {
			throw new Error("fixture needs patient, visit, and patient list");
		}
		patient.properties.push(
			{
				id: readOnly,
				name: "Imported status",
				meaning: "A status displayed during visits.",
				dataShape: "text",
				sensitivity: "ordinary",
			},
			{
				id: queueOnly,
				name: "Queue marker",
				meaning: "A marker displayed only in the patient queue.",
				dataShape: "text",
				sensitivity: "ordinary",
			},
		);
		visit.readback.push({
			recordId: ids.recPatient,
			purpose: "Show the imported patient status",
			propertyIds: [readOnly],
		});
		list.detailPropertyIds.push(queueOnly);

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const visitSlice = plan.slices.find(
			(slice) => slice.workflowId === ids.taskVisit,
		);
		const visitElements = visitSlice?.constructionGroups.flatMap((group) =>
			group.elements.map((element) => element.id),
		);
		expect(visitElements).toContain(readOnly);
		expect(visitElements).not.toContain(queueOnly);
		const rootGroups = plan.slices[0]?.constructionGroups ?? [];
		expect(
			rootGroups.some((group) =>
				group.elements.some((element) => element.id === queueOnly),
			),
		).toBe(true);
		expect(
			rootGroups.some((group) =>
				group.elements.some((element) => element.id === list.id),
			),
		).toBe(true);
		expect(
			rootGroups.some((group) =>
				group.elements.some((element) => element.id === readOnly),
			),
		).toBe(false);
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

	it("derives construction for a revision-attested existing lookup choice", () => {
		const contract = cloneContract(makeContract());
		const risk = contract.records[0]?.properties.find(
			(property) => property.id === ids.factRisk,
		);
		if (!risk) throw new Error("fixture risk property missing");
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection: computeLookupChoiceProjectionAttestation({
				tableRevision: lookupRevisionSchema.parse("7"),
				tableName: "Referral urgency",
				valueColumnLabel: "Code",
				labelColumnLabel: "Name",
				rows: [
					{
						rowId: EXISTING_ROW_ID,
						value: "routine",
						label: "Routine",
					},
					{
						rowId: EXISTING_SECOND_ROW_ID,
						value: "priority",
						label: "Priority",
					},
				],
			}),
		};
		const visit = contract.workflows.find(
			(workflow) => workflow.id === ids.taskVisit,
		);
		if (visit === undefined) throw new Error("visit workflow missing");
		visit.inputs.push({
			handle: "risk_confirmation",
			name: "Risk confirmation",
			purpose: "Confirm the selected patient's current risk",
			propertyId: ids.factRisk,
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "a".repeat(64) },
			planId: ids.planId,
			lookupMaterialization: {
				receiptId: "00000000-0000-4000-8000-000000000902",
				resultDigest: "b".repeat(64),
				projectRevision: lookupRevisionSchema.parse("7"),
				bindings: [],
			},
		});
		const visitSlice = plan.slices.find(
			(slice) => slice.workflowId === ids.taskVisit,
		);
		const workflowGroup = visitSlice?.constructionGroups.find(
			(group) => group.kind === "workflow",
		);
		expect(workflowGroup?.blueprintAreas).toContain("lookup-references");
	});

	it("refuses blocking external actions until a receipt producer exists", () => {
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Existing media",
			kind: "existing-reference",
			description: "Select an existing Project media asset.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: true,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		contract.openQuestions.push({
			id: ids.question,
			question: "Which existing media asset should be attached?",
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
			blocksConstruction: false,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "e".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.externalActions[0]).toMatchObject({
			kind: "runtime-readiness",
			timing: "after-slice",
		});
		expect(newPlanAdmissionMessages(plan)).toEqual([]);
	});
});
