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
	taskReview: did(72),
	rmPatients: did(90),
	accessSupervisor: did(100),
	navMain: did(110),
	modulePatients: did(170),
	moduleVisits: did(180),
	formRegister: did(171),
	formVisit: did(172),
	sectionRegisterIdentity: did(173),
	sectionRegisterTriage: did(174),
	itemRegisterName: did(175),
	itemRegisterAge: did(176),
	itemRegisterGuidance: did(177),
	sectionVisit: did(178),
	itemVisitSummary: did(179),
	formReview: did(181),
	sectionReview: did(182),
	itemReviewSummary: did(183),
	decision: did(120),
	assumption: did(130),
	question: did(140),
	externalSetup: did(160),
	lookupRisk: did(190),
	lookupRiskValue: did(191),
	lookupRiskLabel: did(192),
	lookupRiskRoutine: did(193),
	lookupRiskPriority: did(194),
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
				authoredFeatures: [],
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
				authoredFeatures: [],
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
		moduleCompositions: [
			{
				id: ids.modulePatients,
				name: "Patient care",
				purpose:
					"Give workers one patient-centered home for registration, selection, and follow-up.",
				role: "form-and-queue",
				selection: {
					workflowIds: [ids.taskVisit],
					cases: "one",
				},
				workflowIds: [ids.taskRegister, ids.taskVisit],
				hostRecordId: ids.recPatient,
				actorIds: [ids.actorChw, ids.actorSupervisor],
				navigationIds: [ids.navMain],
				listIds: [ids.rmPatients],
				orderRationale:
					"Keep registration available before the patient queue and follow-up work.",
				icon: { kind: "builtin", slug: "patient" },
				roleSeparationRationale:
					"The shared patient context is clearer than separate registration and visit menus.",
			},
		],
		formCompositions: [
			{
				id: ids.formRegister,
				workflowId: ids.taskRegister,
				moduleCompositionId: ids.modulePatients,
				name: "Register patient",
				purpose: "Capture the minimum identity and triage information.",
				mode: "registration",
				icon: { kind: "builtin", slug: "register" },
				variant: "shared",
				actorIds: [ids.actorChw],
				layout: {
					kind: "sectioned",
					rationale:
						"Separate patient identity from the age-based triage step so the short form scans cleanly.",
					sections: [
						{
							id: ids.sectionRegisterIdentity,
							headingMarkdown: "## Patient",
							purpose: "Identify the person being registered.",
							items: [
								{
									kind: "input",
									id: ids.itemRegisterName,
									inputHandle: "patient_name",
									labelMarkdown: "**Patient name**",
									hintMarkdown: "Enter the name the household uses.",
								},
							],
						},
						{
							id: ids.sectionRegisterTriage,
							headingMarkdown: "## Triage",
							purpose: "Collect the value used for the priority decision.",
							items: [
								{
									kind: "guidance",
									id: ids.itemRegisterGuidance,
									markdown:
										"Children under five are marked **priority** for follow-up.",
								},
								{
									kind: "input",
									id: ids.itemRegisterAge,
									inputHandle: "age",
									labelMarkdown: "Age in years",
									hintMarkdown: "Use 0 for a child under one year.",
								},
							],
						},
					],
				},
			},
			{
				id: ids.formVisit,
				workflowId: ids.taskVisit,
				moduleCompositionId: ids.modulePatients,
				name: "Record visit",
				purpose: "Record what happened during the selected patient's visit.",
				mode: "selected-record",
				icon: { kind: "builtin", slug: "follow_up" },
				variant: "shared",
				actorIds: [ids.actorChw],
				layout: {
					kind: "sectioned",
					rationale:
						"The patient context and visit note should read as one focused task.",
					sections: [
						{
							id: ids.sectionVisit,
							headingMarkdown: "## Visit notes",
							purpose: "Capture a concise account of the visit.",
							items: [
								{
									kind: "input",
									id: ids.itemVisitSummary,
									inputHandle: "visit_summary",
									labelMarkdown: "What happened during this visit?",
									hintMarkdown:
										"Include important observations and agreed next steps.",
								},
							],
						},
					],
				},
			},
		],
		lookupTables: [],
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

/** Reviewed fixture whose controlled risk values are Project data minted only
 * after this exact design is accepted. */
export function makeLookupContract(): AppDesignContract {
	const contract = appDesignContractSchema.parse(
		structuredClone(makeContract()),
	);
	const risk = contract.records
		.flatMap((record) => record.properties)
		.find((property) => property.id === ids.factRisk);
	if (risk === undefined) throw new Error("Risk fixture property is missing.");
	delete risk.choiceValues;
	risk.choiceSource = {
		kind: "designed-project-lookup",
		tableId: ids.lookupRisk,
		valueColumnId: ids.lookupRiskValue,
		labelColumnId: ids.lookupRiskLabel,
	};
	contract.lookupTables = [
		{
			kind: "create",
			id: ids.lookupRisk,
			name: "Risk levels",
			tag: "risk_levels",
			purpose: "Share the controlled triage values across app surfaces.",
			columns: [
				{
					id: ids.lookupRiskValue,
					wireName: "value",
					label: "Value",
					dataType: "text",
				},
				{
					id: ids.lookupRiskLabel,
					wireName: "label",
					label: "Label",
					dataType: "text",
				},
			],
			rows: [
				{
					id: ids.lookupRiskRoutine,
					cells: [
						{ columnId: ids.lookupRiskValue, value: "routine" },
						{ columnId: ids.lookupRiskLabel, value: "Routine" },
					],
				},
				{
					id: ids.lookupRiskPriority,
					cells: [
						{ columnId: ids.lookupRiskValue, value: "priority" },
						{ columnId: ids.lookupRiskLabel, value: "Priority" },
					],
				},
			],
			rowEvidence: {
				sourceRefs: [messageRef()],
				summary: "The request establishes the two triage levels.",
			},
		},
	];
	return appDesignContractSchema.parse(contract);
}

export function parseContract(contract: AppDesignContract): AppDesignContract {
	return appDesignContractSchema.parse(contract);
}

export function cloneContract(contract: AppDesignContract): AppDesignContract {
	return structuredClone(contract);
}

/** Add a second patient-context form workflow to exercise module-wide
 * selection coverage. Callers choose the final selection workflowIds after
 * adding it. */
export function addPatientReviewWorkflow(contract: AppDesignContract): void {
	const visitWorkflow = fixtureValue(
		contract.workflows.find((workflow) => workflow.id === ids.taskVisit),
		"visit workflow",
	);
	contract.workflows.push({
		...structuredClone(visitWorkflow),
		id: ids.taskReview,
		name: "Review patient",
		goal: "Review the selected patient's latest information.",
		prerequisiteWorkflowIds: [ids.taskRegister],
		prerequisites: ["The patient is registered"],
	});
	contract.charter.includedWorkflowIds.push(ids.taskReview);
	fixtureValue(contract.navigation[0], "main navigation").workflowIds.push(
		ids.taskReview,
	);
	fixtureValue(
		contract.moduleCompositions[0],
		"patient module composition",
	).workflowIds.push(ids.taskReview);
	const visitForm = fixtureValue(
		contract.formCompositions.find((form) => form.id === ids.formVisit),
		"visit form composition",
	);
	const visitLayout = visitForm.layout;
	if (visitLayout.kind !== "sectioned") {
		throw new Error("Expected sectioned visit form fixture.");
	}
	const reviewForm = structuredClone(visitForm);
	const reviewLayout = reviewForm.layout;
	if (reviewLayout.kind !== "sectioned") {
		throw new Error("Expected cloned sectioned review form fixture.");
	}
	reviewForm.id = ids.formReview;
	reviewForm.workflowId = ids.taskReview;
	reviewForm.name = "Review patient";
	reviewForm.purpose = "Review the selected patient's latest information.";
	reviewLayout.sections[0] = {
		...fixtureValue(reviewLayout.sections[0], "review section"),
		id: ids.sectionReview,
		items: [
			{
				...fixtureValue(
					fixtureValue(reviewLayout.sections[0], "review section").items[0],
					"review item",
				),
				id: ids.itemReviewSummary,
			},
		],
	};
	contract.formCompositions.push(reviewForm);
}

/** One-tier menu fixture: the registration/list home is built first and a
 * later workflow owns a child menu containing its follow-up form. */
export function makeNestedMenuContract(): AppDesignContract {
	const contract = cloneContract(makeContract());
	const parent = fixtureValue(
		contract.moduleCompositions[0],
		"patient module composition",
	);
	contract.moduleCompositions.push({
		id: ids.moduleVisits,
		name: "Patient visits",
		purpose: "Keep follow-up actions together inside the patient menu.",
		parentModuleCompositionId: parent.id,
		role: "form-host",
		selection: {
			workflowIds: [ids.taskVisit],
			cases: "one",
		},
		workflowIds: [ids.taskVisit],
		hostRecordId: ids.recPatient,
		actorIds: [ids.actorChw],
		navigationIds: [],
		listIds: [],
		orderRationale: "Registration and selection precede follow-up work.",
		icon: { kind: "builtin", slug: "default" },
		roleSeparationRationale:
			"The child menu groups the follow-up form without duplicating the patient queue.",
	});
	const visitForm = fixtureValue(
		contract.formCompositions.find(
			(composition) => composition.id === ids.formVisit,
		),
		"visit form composition",
	);
	visitForm.moduleCompositionId = ids.moduleVisits;
	/* This parent is still form-and-queue, so its selection does not propagate
	 * into the child menu. The child owns its own one-case Results setting. Tests
	 * that make the parent queue-only move that setting to the parent. */
	delete parent.selection;
	return appDesignContractSchema.parse(contract);
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
			authoredFeatures: [],
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
		moduleCompositions: workflowIds.map((workflowId, index) => ({
			id: did(4000 + index),
			name: `Workflow ${index + 1}`,
			purpose: `Host workflow ${index + 1}.`,
			role: "form-host",
			workflowIds: [workflowId],
			hostRecordId: recordIds[index],
			actorIds: [ids.actorChw],
			navigationIds: [],
			listIds: [],
			orderRationale: `Follow workflow dependency order at position ${index + 1}.`,
			icon: { kind: "builtin", slug: "default" },
			roleSeparationRationale:
				"This workflow owns a distinct record and therefore a distinct menu home.",
		})),
		formCompositions: workflowIds.map((workflowId, index) => ({
			id: did(5000 + index),
			workflowId,
			moduleCompositionId: did(4000 + index),
			name: `Workflow ${index + 1}`,
			purpose: `Complete workflow ${index + 1}.`,
			mode: "registration",
			icon: { kind: "builtin", slug: "default" },
			variant: "shared",
			actorIds: [ids.actorChw],
			layout: {
				kind: "flat",
				rationale:
					"This fixture has one input and no meaningful grouping boundary.",
				items: [
					{
						kind: "input",
						id: did(6000 + index),
						inputHandle: `workflow_${index + 1}_value`,
						labelMarkdown: `Workflow ${index + 1} value`,
					},
				],
			},
		})),
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
