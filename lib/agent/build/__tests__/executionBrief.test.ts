import { describe, expect, it } from "vitest";
import {
	blueprintModuleHandle,
	briefDigest,
	deriveSliceExecutionBrief as deriveAdmittedSliceExecutionBrief,
	renderBriefMessage,
} from "@/lib/agent/build/executionBrief";
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
	makeWorkflowChainContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan as deriveAdmittedBuildPlan } from "@/lib/agent/design/buildPlan";

import { appDesignContractSchema } from "@/lib/agent/design/contract";

function deriveBuildPlan(args: Parameters<typeof deriveAdmittedBuildPlan>[0]) {
	appDesignContractSchema.parse(args.contract);
	return deriveAdmittedBuildPlan(args);
}
function deriveSliceExecutionBrief(
	args: Parameters<typeof deriveAdmittedSliceExecutionBrief>[0],
) {
	appDesignContractSchema.parse(args.contract);
	return deriveAdmittedSliceExecutionBrief(args);
}

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
	it("carries the complete registration scope and its ordered construction checklist", () => {
		const brief = briefAt(0);
		const contract = makeContract();
		expect(brief.workflow).toEqual(contract.workflows[0]);
		expect(brief.records).toEqual([contract.records[0]]);
		expect(brief.actors).toEqual(contract.actors);
		expect(brief.lists).toEqual(contract.lists);
		expect(brief.access).toEqual(contract.access);
		expect(brief.navigation).toEqual(contract.navigation);
		expect(
			brief.constructionChecklist.map((group) =>
				group.items.map((item) => item.kind),
			),
		).toEqual([
			["actor", "actor", "record", "property", "property", "property"],
			[
				"workflow",
				"form-composition",
				"composition-section",
				"composition-item",
				"composition-section",
				"composition-item",
				"composition-item",
			],
			["list"],
			["access", "navigation", "module-composition"],
		]);
		expect(brief.constructionChecklist[0]?.items).toEqual([
			{
				kind: "actor",
				requirement:
					"Use actor Community health worker as workflow context; materialize worker properties, user types, or personas only where an accepted executable condition/reference or explicit authored-worker requirement needs them.",
			},
			{
				kind: "actor",
				requirement:
					"Use actor Supervisor as workflow context; materialize worker properties, user types, or personas only where an accepted executable condition/reference or explicit authored-worker requirement needs them.",
			},
			{ kind: "record", requirement: "Declare record Patient." },
			{
				kind: "property",
				requirement: "Declare and author Patient name as text.",
			},
			{ kind: "property", requirement: "Declare and author Age as integer." },
			{
				kind: "property",
				requirement: "Declare and author Risk level as single-choice.",
			},
		]);
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
						{
							compositionSectionId: ids.sectionVisit,
							blueprintFieldKind: "group",
							labelMarkdown: "## Visit notes",
							items: [
								{
									compositionItemId: ids.itemVisitSummary,
									blueprintFieldKind: "workflow-input",
									inputHandle: "visit_summary",
									blueprintFieldId: "visit_summary",
								},
							],
						},
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
		expect(visit.recordRealizations).toEqual([
			{
				recordId: ids.recPatient,
				displayName: "Patient",
				blueprintCaseType: "patient",
			},
			{
				recordId: ids.recVisit,
				displayName: "Visit",
				blueprintCaseType: "visit",
				parentBlueprintCaseType: "patient",
			},
		]);
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
		const viewerListId = did(904);
		const viewerId = did(905);
		contract.lists.push({
			...fixtureValue(contract.lists[0], "patient list"),
			id: viewerListId,
			name: "Patient directory",
		});
		contract.moduleCompositions.push({
			id: viewerId,
			name: "Patient directory",
			purpose: "Offer another patient viewer without a case-loading form.",
			parentModuleCompositionId: parent.id,
			role: "queue-only",
			workflowIds: [ids.taskVisit],
			hostRecordId: parent.hostRecordId,
			actorIds: [...parent.actorIds],
			navigationIds: [],
			listIds: [viewerListId],
			orderRationale: "Keep the follow-up action before the secondary viewer.",
			icon: { kind: "builtin", slug: "default" },
			roleSeparationRationale:
				"This viewer has no form that consumes the parent selection.",
		});
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
			expect.objectContaining({
				compositionId: viewerId,
			}),
		]);
		expect(
			fixtureValue(
				brief.moduleRealizations.find(
					(realization) => realization.compositionId === viewerId,
				),
				"non-consuming viewer realization",
			),
		).not.toHaveProperty("selectionRealization");
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

	it("keeps worker provisioning separate from deployment prerequisites", () => {
		expect(briefAt(0).capabilityBoundary.externalPrerequisites).toEqual([
			"uploading or recording media before Nova can attach it",
			"provisioning workers and shared resources",
		]);
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Release the app",
			kind: "deployment-readiness",
			description: "A person builds and releases the app in HQ.",
			relatedWorkflowIds: [ids.taskVisit],
			blocksConstruction: false,
		});
		fixtureValue(contract.workflows[1], "visit").externalRequirementIds.push(
			ids.externalSetup,
		);
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: fixtureValue(plan.slices[1], "visit slice").id,
		});
		expect(brief.capabilityBoundary.externalPrerequisites).toEqual([
			"uploading or recording media before Nova can attach it",
			"CommCare HQ feature, build, release, and deployment steps that require a person",
		]);
	});

	it("keeps record keys distinct when a display name resembles another record's UUID suffix", () => {
		const contract = makeWorkflowChainContract(3);
		const first = fixtureValue(contract.records[0], "first record");
		first.name = "Risk review";
		fixtureValue(contract.records[1], "second record").name = "Risk-review";
		fixtureValue(contract.records[2], "third record").name =
			`risk_review_${first.id.replaceAll("-", "")}`;
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const keys = plan.slices.map((slice) => {
			const brief = deriveSliceExecutionBrief({
				contract,
				revision: REVISION,
				plan,
				sliceId: slice.id,
			});
			return fixtureValue(
				brief.recordRealizations.find(
					(record) =>
						record.recordId ===
						contract.workflows.find(
							(workflow) => workflow.id === slice.workflowId,
						)?.recordEffects[0]?.recordId,
				),
				"owned record",
			).blueprintCaseType;
		});
		expect(keys).toEqual([
			`risk_review_${did(1000).replaceAll("-", "")}`,
			`risk_review_${did(1001).replaceAll("-", "")}`,
			`risk_review_${did(1000).replaceAll("-", "")}_${did(1002).replaceAll("-", "")}`,
		]);
	});

	it.each([
		{ names: ["Household", "Visit"], expected: ["household", "visit"] },
		{
			names: ["case", "form", "parent", "user"],
			expected: ["case_record", "form_record", "parent_record", "user_record"],
		},
		{ names: ["123 homes", "!!!"], expected: ["record_123_homes", "record"] },
		{
			names: ["Same name", "Same-name"],
			expected: [0, 1].map(
				(index) => `same_name_${did(1000 + index).replaceAll("-", "")}`,
			),
		},
		{
			names: ["a".repeat(256), `${"a".repeat(255)}b`],
			expected: [0, 1].map(
				(index) =>
					`${"a".repeat(222)}_${did(1000 + index).replaceAll("-", "")}`,
			),
		},
	])(
		"lowers and bounds the complete record catalog independently of record order: $names",
		({ names, expected }) => {
			const contract = makeWorkflowChainContract(names.length);
			contract.records.forEach((record, index) => {
				record.name = fixtureValue(names[index], "name");
			});
			const project = () => {
				const plan = deriveBuildPlan({ contract, revision: REVISION });
				return plan.slices.map((slice, index) => {
					const brief = deriveSliceExecutionBrief({
						contract,
						revision: REVISION,
						plan,
						sliceId: slice.id,
					});
					const key = fixtureValue(
						brief.recordRealizations.find(
							(record) => record.recordId === did(1000 + index),
						),
						"owned record",
					).blueprintCaseType;
					expect(
						brief.moduleRealizations.find(
							(module) => module.compositionId === did(4000 + index),
						)?.hostRecord?.blueprintCaseType,
					).toBe(key);
					return key;
				});
			};
			expect(project()).toEqual(expected);
			contract.records.reverse();
			expect(project()).toEqual(expected);
		},
	);

	it("carries flat layout guidance, record summaries, and inputs in accepted order", () => {
		const contract = makeContract();
		const form = fixtureValue(contract.formCompositions[1], "visit form");
		form.layout = {
			kind: "flat",
			rationale: "Keep this short visit together.",
			items: [
				{
					kind: "guidance",
					id: did(9010),
					markdown: "**Review** the selected patient first.",
				},
				{
					kind: "record-summary",
					id: did(9011),
					recordId: ids.recPatient,
					propertyIds: [ids.factName, ids.factAge],
					purpose: "Confirm the patient.",
				},
				{
					kind: "input",
					id: ids.itemVisitSummary,
					inputHandle: "visit_summary",
					labelMarkdown: "Visit notes",
				},
			],
		};
		const plan = deriveBuildPlan({ contract, revision: REVISION });
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: fixtureValue(plan.slices[1], "visit").id,
		});
		expect(brief.formRealizations[0]?.layoutLowering).toEqual({
			kind: "root-fields",
			items: [
				{
					compositionItemId: did(9010),
					blueprintFieldKind: "label",
					markdown: "**Review** the selected patient first.",
				},
				{
					compositionItemId: did(9011),
					blueprintFieldKind: "label",
					recordSummary: {
						recordId: ids.recPatient,
						propertyIds: [ids.factName, ids.factAge],
						purpose: "Confirm the patient.",
					},
				},
				{
					compositionItemId: ids.itemVisitSummary,
					blueprintFieldKind: "workflow-input",
					inputHandle: "visit_summary",
					blueprintFieldId: "visit_summary",
				},
			],
		});
	});

	it("carries app-wide decisions only on materialization", () => {
		expect(briefAt(0).decisions.map((decision) => decision.id)).toEqual([
			ids.decision,
		]);
		expect(briefAt(1).decisions).toEqual([]);
	});

	it("keeps thirteen workflow briefs local while carrying prior menus only as placement context", () => {
		const contract = makeThirteenWorkflowContract();
		const before = structuredClone(contract);
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			planId: ids.planId,
		});
		const planBefore = structuredClone(plan);
		for (const [index, slice] of plan.slices.entries()) {
			const brief = deriveSliceExecutionBrief({
				contract,
				revision: REVISION,
				plan,
				sliceId: slice.id,
			});
			expect(brief.workflow).toEqual(contract.workflows[index]);
			expect(brief.records).toEqual([contract.records[index]]);
			expect(brief.recordRealizations).toEqual([
				{
					recordId: did(1000 + index),
					displayName: `Workflow ${index + 1} record`,
					blueprintCaseType: `workflow_${index + 1}_record`,
				},
			]);
			expect(brief.formCompositions).toEqual([
				contract.formCompositions[index],
			]);
			expect(
				brief.moduleRealizations.map(({ compositionId, action }) => ({
					compositionId,
					action,
				})),
			).toEqual(
				Array.from({ length: index + 1 }, (_, position) => ({
					compositionId: did(4000 + position),
					action: position === index ? "create" : "reuse",
				})),
			);
			expect(brief.prerequisiteWorkflows).toEqual(
				index === 0
					? []
					: [
							{
								id: did(3000 + index - 1),
								name: `Workflow ${index}`,
								goal: `Complete workflow ${index}.`,
							},
						],
			);
			expect(brief.lists).toEqual([]);
			expect(brief.access).toEqual([]);
			expect(brief.navigation).toEqual([]);
			expect(brief.externalRequirements).toEqual([]);
			expect(brief.externalActions).toEqual([]);
		}
		expect(contract).toEqual(before);
		expect(plan).toEqual(planBefore);
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
		expect(constraintCodes).toContain("REPEATED_EVENTS_ARE_CHILD_RECORDS");
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

	it("renders every JSON context section losslessly and omits absent work", () => {
		const brief = briefAt(1);
		const message = renderBriefMessage(brief);
		const sections = new Map(
			message
				.split(/(?:^|\n\n)## /)
				.filter(Boolean)
				.map((block) => {
					const boundary = block.indexOf("\n");
					return [block.slice(0, boundary), block.slice(boundary + 1)];
				}),
		);
		expect(
			JSON.parse(
				fixtureValue(sections.get("Workflow semantics"), "workflow section"),
			),
		).toEqual(brief.workflow);
		expect(
			JSON.parse(
				fixtureValue(sections.get("Capability boundary"), "capability section"),
			),
		).toEqual(brief.capabilityBoundary);
		for (const [heading, expected] of [
			[
				"Prerequisite workflows already established",
				brief.prerequisiteWorkflows,
			],
			["Actors", brief.actors],
			["Records and properties", brief.records],
			["Exact record lowering", brief.recordRealizations],
			["Lists and searches", brief.lists],
			["Access", brief.access],
			["Navigation", brief.navigation],
			["Module composition", brief.moduleCompositions],
			["Form composition", brief.formCompositions],
			[
				"Module and selection realization instructions",
				brief.moduleRealizations,
			],
			["Exact form realization instructions", brief.formRealizations],
		] as const) {
			if (expected.length === 0) {
				expect(sections.has(heading)).toBe(false);
				continue;
			}
			expect(
				fixtureValue(sections.get(heading), heading)
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toEqual(expected);
		}
		for (const absent of [
			"App decisions",
			"App assumptions",
			"External requirements",
			"External actions",
		]) {
			expect(sections.has(absent)).toBe(false);
		}
		expect(sections.get("Semantic construction checklist")).toContain(
			"Declare record Visit.",
		);
		expect(sections.get("Semantic construction checklist")).not.toContain(
			"Declare record Patient.",
		);
	});

	it("has a stable digest and refuses unknown slices", () => {
		const original = briefAt(0);
		expect(briefDigest(JSON.parse(JSON.stringify(original)))).toBe(
			briefDigest(original),
		);
		expect(
			briefDigest({ ...original, designRevisionDigest: "c".repeat(64) }),
		).not.toBe(briefDigest(original));
		expect(
			briefDigest({ ...original, buildPlanDigest: "d".repeat(64) }),
		).not.toBe(briefDigest(original));
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
