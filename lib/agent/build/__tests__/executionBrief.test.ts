import { describe, expect, it } from "vitest";
import {
	blueprintModuleHandle,
	briefDigest,
	deriveSliceExecutionBrief,
	renderBriefMessage,
} from "@/lib/agent/build/executionBrief";
import { buildExecutorTools } from "@/lib/agent/build/executorLoop";
import {
	addPatientReviewWorkflow,
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
	makeNestedMenuContract,
	makeThirteenWorkflowContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";

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
	it("carries one workflow and its semantic construction checklist", () => {
		const brief = briefAt(0);
		expect(brief.workflow.id).toBe(ids.taskRegister);
		expect(brief.constructionChecklist.map((group) => group.groupName)).toEqual(
			brief.slice.constructionGroups.map((group) => group.name),
		);
		expect(brief.constructionChecklist.flatMap((group) => group.items)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: expect.any(String),
					requirement: expect.any(String),
				}),
			]),
		);
		expect(brief.records.map((record) => record.id)).toContain(ids.recPatient);
		expect(brief.actors.map((actor) => actor.id)).toContain(ids.actorChw);
		expect(
			brief.constructionChecklist
				.flatMap((group) => group.items)
				.find((item) => item.kind === "actor")?.requirement,
		).toContain("as workflow context; materialize worker properties");
	});

	it("carries accepted optional input validation into the executor brief", () => {
		const contract = cloneContract(makeContract());
		const input = contract.workflows[0]?.inputs[0];
		if (input === undefined) throw new Error("workflow input fixture missing");
		input.validation = {
			rule: "When answered, the phone number must contain at least seven digits.",
			message: "Enter a valid phone number.",
		};
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const slice = plan.slices[0];
		if (slice === undefined) throw new Error("fixture slice missing");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: slice.id,
		});
		expect(brief.workflow.inputs[0]?.validation).toEqual(input.validation);
		expect(renderBriefMessage(brief)).toContain(
			"When answered, the phone number must contain at least seven digits.",
		);
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

	it("turns accepted composition into exact create/reuse and form realization instructions", () => {
		const registration = briefAt(0);
		const visit = briefAt(1);
		expect(registration.moduleRealizations).toEqual([
			expect.objectContaining({
				compositionId: ids.modulePatients,
				blueprintModuleHandle: blueprintModuleHandle(ids.modulePatients),
				action: "create",
				hostRecord: {
					id: ids.recPatient,
					name: "Patient",
					blueprintCaseType: "patient",
				},
				requiredInitialResultsColumn: {
					kind: "plain",
					field: "case_name",
					header: "Patient",
					visibleInList: true,
				},
				formCompositionIds: [ids.formRegister],
			}),
		]);
		expect(visit.moduleRealizations[0]).not.toHaveProperty(
			"requiredInitialResultsColumn",
		);
		expect(registration.toolProfile.mutationTools).toContain("setMenuMedia");
		expect(registration.toolProfile.blueprintAreas).toContain("case-list");
		expect(registration.toolProfile.mutationTools).toContain(
			"configureCaseList",
		);
		expect(registration.toolProfile.mutationTools).not.toContain(
			"configureCaseSelection",
		);
		expect(registration.toolProfile.mutationTools).not.toContain(
			"configureConnect",
		);
		expect(visit.moduleRealizations).toEqual([
			expect.objectContaining({
				compositionId: ids.modulePatients,
				blueprintModuleHandle: blueprintModuleHandle(ids.modulePatients),
				action: "reuse",
				hostRecord: {
					id: ids.recPatient,
					name: "Patient",
					blueprintCaseType: "patient",
				},
				formCompositionIds: [ids.formVisit],
				selectionRealization: {
					action: "default-one",
					workflowIds: [ids.taskVisit],
					cases: "one",
					selection: null,
				},
			}),
		]);
		expect(visit.formRealizations).toEqual([
			expect.objectContaining({
				compositionId: ids.formVisit,
				moduleCompositionId: ids.modulePatients,
				blueprintFormType: "followup",
				name: "Record visit",
				layout: expect.objectContaining({ kind: "sectioned" }),
				layoutLowering: {
					kind: "nested-group-fields",
					groups: [
						expect.objectContaining({
							compositionSectionId: ids.sectionVisit,
							blueprintFieldKind: "group",
							items: [
								expect.objectContaining({
									compositionItemId: ids.itemVisitSummary,
									blueprintFieldKind: "workflow-input",
									inputHandle: "visit_summary",
									blueprintFieldId: "visit_summary",
								}),
							],
						}),
					],
				},
			}),
		]);
		expect(visit.toolProfile.mutationTools).toContain("setMenuMedia");
		expect(visit.toolProfile.blueprintAreas).not.toContain("case-list");
		expect(visit.toolProfile.mutationTools).not.toContain(
			"configureCaseSelection",
		);
		expect(visit.toolProfile.mutationTools).not.toContain("configureConnect");
		const rendered = renderBriefMessage(visit);
		expect(rendered).toContain("Module and selection realization instructions");
		expect(rendered).toContain("Exact form realization instructions");
		expect(rendered).toContain("Visit notes");
		expect(rendered).toContain("Exact record lowering");
		expect(renderBriefMessage(registration)).toContain(
			'"requiredInitialResultsColumn":{"kind":"plain","field":"case_name","header":"Patient","visibleInList":true}',
		);
		expect(visit.recordRealizations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					recordId: ids.recPatient,
					displayName: "Patient",
					blueprintCaseType: "patient",
				}),
			]),
		);
	});

	it("assigns several-case selection to the workflow that creates its consuming form", () => {
		const contract = cloneContract(makeContract());
		const module = fixtureValue(
			contract.moduleCompositions[0],
			"patient module",
		);
		module.selection = {
			workflowIds: [ids.taskVisit],
			cases: "several",
			maximum: 12,
		};
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const registrationSlice = fixtureValue(
			plan.slices[0],
			"registration slice",
		);
		const visitSlice = fixtureValue(plan.slices[1], "visit slice");
		const registration = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: registrationSlice.id,
		});
		const visit = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: visitSlice.id,
		});

		expect(registration.moduleRealizations[0]).not.toHaveProperty(
			"selectionRealization",
		);
		expect(visit.moduleRealizations[0]?.selectionRealization).toEqual({
			action: "configure-after-forms",
			workflowIds: [ids.taskVisit],
			cases: "several",
			maximum: 12,
			selection: { kind: "multiple", maximum: 12 },
		});
		expect(visit.toolProfile.blueprintAreas).not.toContain("case-list");
		expect(visit.toolProfile.mutationTools).toContain("configureCaseSelection");
		expect(visit.loweringConstraints).toContainEqual(
			expect.objectContaining({
				code: "SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET",
			}),
		);
	});

	it("lowers one module selection only after every affected workflow form", () => {
		const contract = cloneContract(makeContract());
		addPatientReviewWorkflow(contract);
		fixtureValue(contract.moduleCompositions[0], "patient module").selection = {
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "several",
			maximum: 12,
		};
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const visitSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskVisit),
			"visit slice",
		);
		const reviewSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskReview),
			"review slice",
		);
		const visit = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: visitSlice.id,
		});
		const review = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: reviewSlice.id,
		});

		expect(visit.moduleRealizations[0]).not.toHaveProperty(
			"selectionRealization",
		);
		expect(visit.loweringConstraints).toContainEqual(
			expect.objectContaining({
				code: "SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET",
			}),
		);
		expect(review.moduleRealizations[0]?.selectionRealization).toEqual({
			action: "configure-after-forms",
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "several",
			maximum: 12,
			selection: { kind: "multiple", maximum: 12 },
		});
		expect(review.toolProfile.mutationTools).toContain(
			"configureCaseSelection",
		);
		expect(review.loweringConstraints).toContainEqual(
			expect.objectContaining({
				code: "SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET",
			}),
		);
	});

	it("carries listless form-host selection in the atomic module creation with its consuming form", () => {
		const contract = cloneContract(makeContract());
		const visit = fixtureValue(
			contract.workflows.find((workflow) => workflow.id === ids.taskVisit),
			"visit workflow",
		);
		visit.prerequisiteWorkflowIds = [];
		visit.prerequisites = [];
		contract.workflows = [visit];
		contract.charter.includedWorkflowIds = [ids.taskVisit];
		contract.charter.initialWorkflowId = ids.taskVisit;
		contract.navigation[0] = {
			...fixtureValue(contract.navigation[0], "main navigation"),
			workflowIds: [ids.taskVisit],
			listIds: [],
		};
		contract.moduleCompositions[0] = {
			...fixtureValue(contract.moduleCompositions[0], "patient module"),
			role: "form-host",
			listIds: [],
			selection: {
				workflowIds: [ids.taskVisit],
				cases: "several",
				maximum: 8,
			},
			workflowIds: [ids.taskVisit],
		};
		contract.lists = [];
		contract.access = [];
		contract.formCompositions = contract.formCompositions.filter(
			(form) => form.workflowId === ids.taskVisit,
		);
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const slice = fixtureValue(plan.slices[0], "visit slice");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: slice.id,
		});

		expect(brief.moduleRealizations[0]?.selectionRealization).toEqual({
			action: "create-with-module",
			workflowIds: [ids.taskVisit],
			cases: "several",
			maximum: 8,
			selection: { kind: "multiple", maximum: 8 },
		});
		expect(brief.toolProfile.mutationTools).not.toContain(
			"configureCaseSelection",
		);
	});

	it("configures a queue-only parent after creating its several-case child consumer", () => {
		const contract = cloneContract(makeNestedMenuContract());
		const visit = fixtureValue(
			contract.workflows.find((workflow) => workflow.id === ids.taskVisit),
			"visit workflow",
		);
		visit.prerequisiteWorkflowIds = [];
		visit.prerequisites = [];
		contract.workflows = [visit];
		contract.charter.includedWorkflowIds = [ids.taskVisit];
		contract.charter.initialWorkflowId = ids.taskVisit;
		contract.formCompositions = contract.formCompositions.filter(
			(form) => form.workflowId === ids.taskVisit,
		);
		contract.navigation[0] = {
			...fixtureValue(contract.navigation[0], "main navigation"),
			workflowIds: [ids.taskVisit],
		};
		const parent = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.modulePatients,
			),
			"patient module",
		);
		parent.role = "queue-only";
		parent.workflowIds = [ids.taskVisit];
		parent.selection = {
			workflowIds: [ids.taskVisit],
			cases: "several",
			maximum: 6,
		};
		const child = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"visit module",
		);
		delete child.selection;
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const slice = fixtureValue(plan.slices[0], "visit slice");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: slice.id,
		});

		expect(brief.moduleRealizations).toEqual([
			expect.objectContaining({
				compositionId: ids.modulePatients,
				selectionRealization: expect.objectContaining({
					action: "configure-after-forms",
					selection: { kind: "multiple", maximum: 6 },
				}),
			}),
			expect.objectContaining({
				compositionId: ids.moduleVisits,
				selectionRealization: expect.objectContaining({
					action: "create-with-module",
					selection: { kind: "multiple", maximum: 6 },
				}),
			}),
		]);
		expect(brief.toolProfile.mutationTools).toContain("configureCaseSelection");
	});

	it("carries parent and sibling closure into a child menu brief", () => {
		const contract = makeNestedMenuContract();
		const childWorkflow = fixtureValue(
			contract.workflows.find((workflow) => workflow.id === ids.taskVisit),
			"child workflow",
		);
		childWorkflow.prerequisiteWorkflowIds = [];
		childWorkflow.prerequisites = [];
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const slice = fixtureValue(
			plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
			"child workflow slice",
		);
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: slice.id,
		});
		expect(
			brief.moduleRealizations.map((entry) => entry.compositionId),
		).toEqual([ids.modulePatients, ids.moduleVisits]);
		expect(brief.moduleRealizations[0]).toMatchObject({
			action: "reuse",
			parentModuleCompositionId: null,
			afterSiblingModuleCompositionId: null,
		});
		expect(brief.moduleRealizations[1]).toMatchObject({
			action: "create",
			parentModuleCompositionId: ids.modulePatients,
			afterSiblingModuleCompositionId: null,
		});
		expect(brief.prerequisiteWorkflows.map((workflow) => workflow.id)).toEqual([
			ids.taskRegister,
		]);
		expect(renderBriefMessage(brief)).toContain(
			`"parentModuleCompositionId":"${ids.modulePatients}"`,
		);
	});

	it("lowers semantic record names to stable Blueprint case-type keys", () => {
		const contract = cloneContract(makeContract());
		const patient = contract.records.find(
			(record) => record.id === ids.recPatient,
		);
		if (patient === undefined) throw new Error("patient fixture missing");
		patient.name = "Household";
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const slice = plan.slices[0];
		if (slice === undefined) throw new Error("fixture slice missing");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: slice.id,
		});
		expect(
			brief.recordRealizations.find(
				(record) => record.recordId === ids.recPatient,
			),
		).toMatchObject({
			displayName: "Household",
			blueprintCaseType: "household",
		});
		expect(brief.moduleRealizations[0]?.hostRecord).toMatchObject({
			name: "Household",
			blueprintCaseType: "household",
		});
	});

	it("carries app-wide decisions only on materialization", () => {
		expect(briefAt(0).decisions.map((decision) => decision.id)).toEqual([
			ids.decision,
		]);
		expect(briefAt(1).decisions).toEqual([]);
	});

	it("keeps thirteen workflow briefs local and projects every tool profile offline", () => {
		const contract = makeThirteenWorkflowContract();
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			planId: ids.planId,
		});
		let stableToolFingerprint: string | undefined;
		for (const [index, slice] of plan.slices.entries()) {
			const brief = deriveSliceExecutionBrief({
				contract,
				revision: REVISION,
				plan,
				sliceId: slice.id,
			});
			const propertyIds = brief.records.flatMap((record) =>
				record.properties.map((property) => property.id),
			);
			expect(propertyIds).toEqual([contract.records[index]?.properties[0]?.id]);
			const tools = buildExecutorTools(brief);
			const toolNames = Object.keys(tools);
			expect(toolNames).toEqual(
				expect.arrayContaining([
					"searchBlueprint",
					"createModule",
					"finishWorkflow",
					"reportExecutionBlocker",
				]),
			);
			expect(toolNames).not.toEqual(
				expect.arrayContaining(["readBatch", "stageBatch"]),
			);
			const projected = JSON.stringify(tools);
			stableToolFingerprint ??= projected;
			expect(projected).toBe(stableToolFingerprint);
			for (const toolName of [
				...brief.toolProfile.readTools,
				...brief.toolProfile.mutationTools,
			]) {
				expect(projected).toContain(JSON.stringify(toolName));
			}
			if (index > 0) {
				expect(brief.toolProfile.blueprintAreas).not.toContain("users");
				expect(brief.toolProfile.blueprintAreas).not.toContain(
					"case-operations",
				);
			}
		}
	});

	it("carries the materialized preceding sibling into a later root-module brief", () => {
		const contract = makeThirteenWorkflowContract();
		for (const workflow of contract.workflows) {
			workflow.prerequisiteWorkflowIds = [];
			workflow.prerequisites = [];
		}
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const firstSlice = fixtureValue(plan.slices[0], "first module owner slice");
		const secondSlice = fixtureValue(
			plan.slices[1],
			"second module owner slice",
		);
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: secondSlice.id,
		});

		expect(secondSlice.prerequisiteSliceIds).toEqual([firstSlice.id]);
		expect(brief.prerequisiteWorkflows.map((workflow) => workflow.id)).toEqual([
			firstSlice.workflowId,
		]);
		expect(brief.moduleRealizations).toEqual([
			expect.objectContaining({
				compositionId: contract.moduleCompositions[0]?.id,
				action: "reuse",
				afterSiblingModuleCompositionId: null,
			}),
			expect.objectContaining({
				compositionId: contract.moduleCompositions[1]?.id,
				action: "create",
				afterSiblingModuleCompositionId: contract.moduleCompositions[0]?.id,
			}),
		]);
	});

	it("includes the owning record for a property read from an earlier workflow", () => {
		const contract = makeThirteenWorkflowContract();
		const earlierProperty = contract.records[0]?.properties[0];
		const laterWorkflow = contract.workflows[1];
		if (earlierProperty === undefined || laterWorkflow === undefined) {
			throw new Error("thirteen-workflow fixture is incomplete");
		}
		laterWorkflow.decisions.push({
			handle: "earlier_value_decision",
			name: "Use earlier value",
			statement: "Use the value established by the earlier workflow.",
			inputPropertyIds: [earlierProperty.id],
			outcomes: ["continue", "stop"],
		});
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			planId: ids.planId,
		});
		const slice = plan.slices[1];
		if (slice === undefined) throw new Error("later slice missing");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: slice.id,
		});
		expect(
			brief.records.some((record) =>
				record.properties.some(
					(property) => property.id === earlierProperty.id,
				),
			),
		).toBe(true);
	});

	it("carries linked external requirements as context", () => {
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Worker setup",
			kind: "runtime-readiness",
			description: "Configure workers before runtime.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: false,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			planId: ids.planId,
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
	});
	it("binds exact revision, plan, constraints, and capability boundary", () => {
		const brief = briefAt(0);
		expect(brief.designRevisionId).toBe(REVISION.id);
		expect(brief.buildPlanId).toBe(makeBuildPlan().id);
		const constraintCodes = brief.loweringConstraints.map(
			(entry) => entry.code,
		);
		expect(constraintCodes).toContain("WORKER_SCHEMA_AND_ROLES_NOT_PUSHED");
		expect(constraintCodes).toContain("SINGLE_DIRECT_CASE_WRITE_PER_FIELD");
		expect(constraintCodes).not.toContain("PREVIEW_AUTOMATIONS_NOT_EXECUTED");
		expect(constraintCodes).toContain("CASE_SEARCH_IS_LIVE_AND_ONLINE");
		expect(brief.capabilityBoundary.sessionBoundary).toEqual({
			appCount: 1,
			projectScope: "current-project",
		});
	});

	it("mounts only the declared media and automation families", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows[0];
		if (workflow === undefined) throw new Error("fixture workflow missing");
		workflow.authoredFeatures = ["existing-media", "automation"];
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			planId: ids.planId,
		});
		const slice = plan.slices[0];
		if (slice === undefined) throw new Error("fixture slice missing");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: slice.id,
		});
		expect(brief.toolProfile.mutationTools).toEqual(
			expect.arrayContaining(["setMenuMedia", "addAutomations"]),
		);
		expect(brief.loweringConstraints.map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"PREVIEW_AUTOMATIONS_NOT_EXECUTED",
				"AUTOMATION_HQ_MANUAL_SETUP",
			]),
		);
	});

	it("renders a concise workflow-scoped executor message", () => {
		const message = renderBriefMessage(briefAt(1));
		expect(message).toContain("One-app charter");
		expect(message).toContain("Record visit");
		expect(message).toContain("Semantic construction checklist");
		expect(message).not.toContain("constructionGroupIds");
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
