/** Lean, graph-valid design fixtures shared by design/build tests. */

import type { BuildPlan } from "@/lib/agent/design/buildPlan";
import { buildPlanSchema, deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import type { SourceRef } from "@/lib/agent/design/evidence";
import { asDesignId, type DesignId } from "@/lib/agent/design/ids";
import { asMediaAssetId } from "@/lib/domain/multimedia";

export function did(n: number): DesignId {
	return asDesignId(
		`00000000-0000-4000-8000-${n.toString(10).padStart(12, "0")}`,
	);
}

export function fixtureValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`Missing fixture ${label}.`);
	return value;
}

export const FIXTURE_THREAD_ID = "00000000-0000-4000-8000-999999999999";
export const FIXTURE_IMAGE_ASSET_ID = "00000000-0000-4000-8000-000000000880";
export const FIXTURE_IMAGE_DIGEST = "c".repeat(64);

export function messageRef(partIndex = 0) {
	return {
		kind: "message" as const,
		threadId: FIXTURE_THREAD_ID,
		messageId: "m1",
		partIndex,
	} satisfies SourceRef;
}

export function imageRef(
	assetId: string = FIXTURE_IMAGE_ASSET_ID,
	bytesDigest: string = FIXTURE_IMAGE_DIGEST,
) {
	return {
		kind: "image" as const,
		assetId: asMediaAssetId(assetId),
		bytesDigest,
	} satisfies SourceRef;
}

export const ids = {
	contract: did(1),
	actorChw: did(10),
	actorSupervisor: did(11),
	recPatient: did(20),
	recVisit: did(21),
	factName: did(30),
	factAge: did(31),
	factRisk: did(32),
	factVisitSummary: did(33),
	taskRegister: did(70),
	taskVisit: did(71),
	rmPatients: did(90),
	accessSupervisor: did(100),
	navMain: did(110),
	decision: did(120),
	assumption: did(130),
	question: did(140),
	externalSetup: did(160),
	planId: "00000000-0000-4000-8000-000000000900",
	revisionId: "00000000-0000-4000-8000-000000000901",
} as const;

export function makeContract(): AppDesignContract {
	return appDesignContractSchema.parse({
		schemaVersion: 1,
		id: ids.contract,
		charter: {
			appName: "CHW patient visits",
			objective:
				"Help community health workers register patients and record visits with supervisor oversight.",
			appCount: 1,
			projectScope: "current-project",
			includedWorkflowIds: [ids.taskRegister, ids.taskVisit],
			excludedWorkflows: ["Billing"],
			deliveryContext: "offline-first",
			initialWorkflowId: ids.taskRegister,
		},
		actors: [
			{
				id: ids.actorChw,
				name: "Community health worker",
				goals: ["Register patients and record visits quickly"],
				responsibilities: ["Conduct home visits"],
				workContext: ["Often works offline"],
				constraints: ["Short visit windows"],
			},
			{
				id: ids.actorSupervisor,
				name: "Supervisor",
				goals: ["Monitor visit coverage"],
				responsibilities: ["Review the patient queue"],
				workContext: ["Clinic office"],
				constraints: [],
			},
		],
		records: [
			{
				id: ids.recPatient,
				name: "Patient",
				purpose: "A person receiving home visits.",
				lifecycleStates: ["active"],
				properties: [
					{
						id: ids.factName,
						name: "Patient name",
						meaning: "The patient's full name.",
						dataShape: "text",
						sensitivity: "ordinary",
						requiredWhen: "Always during registration",
					},
					{
						id: ids.factAge,
						name: "Age",
						meaning: "The patient's age in years.",
						dataShape: "integer",
						sensitivity: "ordinary",
					},
					{
						id: ids.factRisk,
						name: "Risk level",
						meaning: "The triage level used for follow-up.",
						dataShape: "single-choice",
						sensitivity: "sensitive",
						choiceValues: ["routine", "priority"],
					},
				],
			},
			{
				id: ids.recVisit,
				name: "Visit",
				purpose: "One completed home visit.",
				parentRecordId: ids.recPatient,
				relationshipMeaning: "A visit belongs to the visited patient.",
				lifecycleStates: ["recorded"],
				properties: [
					{
						id: ids.factVisitSummary,
						name: "Visit summary",
						meaning: "What happened during the visit.",
						dataShape: "text",
						sensitivity: "sensitive",
					},
				],
			},
		],
		workflows: [
			{
				id: ids.taskRegister,
				name: "Register patient",
				actorIds: [ids.actorChw],
				goal: "Create a usable patient record.",
				trigger: "A community health worker meets a new patient.",
				prerequisiteWorkflowIds: [],
				prerequisites: ["The worker knows the patient's name"],
				inputs: [
					{
						handle: "patient_name",
						name: "Patient name",
						purpose: "Identify the patient",
						propertyId: ids.factName,
					},
					{
						handle: "age",
						name: "Age",
						purpose: "Support triage",
						propertyId: ids.factAge,
					},
				],
				decisions: [
					{
						handle: "triage",
						name: "Triage patient",
						statement: "Patients under five are priority; others are routine.",
						inputPropertyIds: [ids.factAge],
						outcomes: ["priority", "routine"],
					},
				],
				recordEffects: [
					{
						handle: "create_patient",
						recordId: ids.recPatient,
						kind: "create",
						writes: [
							{
								propertyId: ids.factName,
								value: "Patient name answer",
								unanswered: "preserve",
							},
							{
								propertyId: ids.factAge,
								value: "Age answer",
								unanswered: "preserve",
							},
							{
								propertyId: ids.factRisk,
								value: "Triage outcome",
								unanswered: "preserve",
							},
						],
						outcome: "An active patient record is available for visits.",
					},
				],
				readback: [
					{
						recordId: ids.recPatient,
						purpose: "Confirm the saved patient",
						propertyIds: [ids.factName, ids.factRisk],
					},
				],
				exceptions: ["A missing name blocks submission"],
				externalRequirementIds: [],
				acceptanceExamples: [
					{
						name: "Register a priority patient",
						given: ["The worker is signed in"],
						when: ["The worker submits a name and an age under five"],
						expectedResults: ["The patient is saved with priority risk"],
					},
				],
			},
			{
				id: ids.taskVisit,
				name: "Record visit",
				actorIds: [ids.actorChw],
				goal: "Save a visit against an existing patient.",
				trigger: "The worker completes a home visit.",
				contextRecordId: ids.recPatient,
				prerequisiteWorkflowIds: [ids.taskRegister],
				prerequisites: ["The patient is registered"],
				inputs: [
					{
						handle: "visit_summary",
						name: "Visit summary",
						purpose: "Record what happened",
						propertyId: ids.factVisitSummary,
					},
				],
				decisions: [],
				recordEffects: [
					{
						handle: "create_visit",
						recordId: ids.recVisit,
						kind: "create",
						sourceRecordId: ids.recPatient,
						writes: [
							{
								propertyId: ids.factVisitSummary,
								value: "Visit summary answer",
								unanswered: "preserve",
							},
						],
						outcome: "A visit is linked to the selected patient.",
					},
				],
				readback: [
					{
						recordId: ids.recVisit,
						purpose: "Confirm the recorded visit",
						propertyIds: [ids.factVisitSummary],
					},
				],
				exceptions: ["A missing patient prevents the visit"],
				externalRequirementIds: [],
				acceptanceExamples: [
					{
						name: "Record one visit",
						given: ["A patient exists"],
						when: ["The worker submits a visit summary"],
						expectedResults: ["A linked visit is saved"],
					},
				],
			},
		],
		lists: [
			{
				id: ids.rmPatients,
				name: "Patients",
				actorIds: [ids.actorChw, ids.actorSupervisor],
				recordId: ids.recPatient,
				purpose: "Find a patient and start a visit.",
				filters: ["Active patients"],
				sort: ["Patient name ascending"],
				scanPropertyIds: [ids.factName, ids.factRisk],
				detailPropertyIds: [ids.factAge],
				searchPropertyIds: [ids.factName],
				selectionWorkflowId: ids.taskVisit,
				emptyStateMeaning: "No patients are available yet.",
			},
		],
		access: [
			{
				id: ids.accessSupervisor,
				actorId: ids.actorSupervisor,
				targets: [{ kind: "list", id: ids.rmPatients }],
				capabilities: ["discover", "view"],
				condition: "The worker has the supervisor role",
			},
		],
		navigation: [
			{
				id: ids.navMain,
				name: "Patient care",
				purpose: "Keep registration and patient work together.",
				actorIds: [ids.actorChw, ids.actorSupervisor],
				workflowIds: [ids.taskRegister, ids.taskVisit],
				listIds: [ids.rmPatients],
				orderRationale: "Registration comes before follow-up.",
			},
		],
		externalRequirements: [],
		decisions: [
			{
				id: ids.decision,
				question: "How should visits relate to patients?",
				decision: "Each visit is a child record of one patient.",
				rationale:
					"This preserves visit history without overwriting the patient.",
			},
		],
		assumptions: [
			{
				id: ids.assumption,
				statement:
					"Workers can identify the correct patient before recording a visit.",
				consequenceIfWrong: "The workflow needs stronger patient matching.",
			},
		],
		openQuestions: [],
	});
}

export function parseContract(contract: AppDesignContract): AppDesignContract {
	return appDesignContractSchema.parse(contract);
}

export function cloneContract(contract: AppDesignContract): AppDesignContract {
	return structuredClone(contract);
}

/** Large deterministic fixture: thirteen included workflows, each with
 * one record/property it alone constructs. It is deliberately semantically
 * plain so projection tests can see accidental cross-workflow leakage. */
export function makeThirteenWorkflowContract(): AppDesignContract {
	const workflowIds = Array.from({ length: 13 }, (_, index) =>
		did(3000 + index),
	);
	const recordIds = Array.from({ length: 13 }, (_, index) => did(1000 + index));
	const propertyIds = Array.from({ length: 13 }, (_, index) =>
		did(2000 + index),
	);
	const base = makeContract();
	return appDesignContractSchema.parse({
		...base,
		charter: {
			...base.charter,
			includedWorkflowIds: workflowIds,
			initialWorkflowId: workflowIds[0],
		},
		actors: [base.actors[0]],
		records: recordIds.map((recordId, index) => ({
			id: recordId,
			name: `Workflow ${index + 1} record`,
			purpose: `Store the result of workflow ${index + 1}.`,
			lifecycleStates: ["active"],
			properties: [
				{
					id: propertyIds[index],
					name: `Workflow ${index + 1} value`,
					meaning: `The value collected only by workflow ${index + 1}.`,
					dataShape: "text",
					sensitivity: "ordinary",
				},
			],
		})),
		workflows: workflowIds.map((workflowId, index) => ({
			id: workflowId,
			name: `Workflow ${index + 1}`,
			actorIds: [ids.actorChw],
			goal: `Complete workflow ${index + 1}.`,
			trigger: `The worker starts workflow ${index + 1}.`,
			prerequisiteWorkflowIds: index === 0 ? [] : [workflowIds[index - 1]],
			prerequisites: index === 0 ? [] : [`Workflow ${index} is complete`],
			inputs: [
				{
					handle: `workflow_${index + 1}_value`,
					name: `Workflow ${index + 1} value`,
					purpose: `Capture workflow ${index + 1}'s value`,
					propertyId: propertyIds[index],
				},
			],
			decisions: [],
			recordEffects: [
				{
					handle: `create_workflow_${index + 1}_record`,
					recordId: recordIds[index],
					kind: "create",
					writes: [
						{
							propertyId: propertyIds[index],
							value: `Workflow ${index + 1} answer`,
							unanswered: "preserve",
						},
					],
					outcome: `Workflow ${index + 1}'s record is saved.`,
				},
			],
			readback: [
				{
					recordId: recordIds[index],
					purpose: `Confirm workflow ${index + 1}'s saved value`,
					propertyIds: [propertyIds[index]],
				},
			],
			exceptions: [],
			externalRequirementIds: [],
			acceptanceExamples: [
				{
					name: `Complete workflow ${index + 1}`,
					given: ["The worker is signed in"],
					when: [`The worker submits workflow ${index + 1}`],
					expectedResults: [`Workflow ${index + 1}'s record is saved`],
				},
			],
		})),
		lists: [],
		access: [],
		navigation: [],
		externalRequirements: [],
		decisions: [],
		assumptions: [],
		openQuestions: [],
	});
}

export function makeBuildPlan(): BuildPlan {
	return deriveBuildPlan({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		planId: ids.planId,
	});
}

export function parsePlan(plan: BuildPlan): BuildPlan {
	return buildPlanSchema.parse(plan);
}
