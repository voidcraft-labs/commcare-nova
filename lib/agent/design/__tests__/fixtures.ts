/**
 * Design-domain test fixtures — one COMPLETE, graph-valid contract plus the
 * build plan that covers it, built from deterministic ids so a failure names
 * a readable coordinate.
 *
 * The contract exercises every collection: two actors, a parent/child record
 * pair, answer/derived/lookup facts with coherent writer sets, a rule, two
 * tasks (one creating the parent, one creating the child through a
 * transition), a read model, a lookup table intent the lookup fact reads, an
 * access policy, navigation, a decision, an assumption, an open question, and
 * two scenarios. Tests clone-and-break it per rule.
 */

import type { BuildPlan } from "@/lib/agent/design/buildPlan";
import { buildPlanSchema } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import type { SourceRef } from "@/lib/agent/design/evidence";
import { asDesignId, type DesignId } from "@/lib/agent/design/ids";
import { asMediaAssetId } from "@/lib/domain/multimedia";

/** Deterministic design id: `did(5)` → `00000000-0000-4000-8000-000000000005`. */
export function did(n: number): DesignId {
	return asDesignId(
		`00000000-0000-4000-8000-${n.toString(10).padStart(12, "0")}`,
	);
}

export const FIXTURE_THREAD_ID = "00000000-0000-4000-8000-999999999999";

/** The image the source-package fixtures project — asset id plus the digest
 *  of the exact bytes the model was shown. */
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
	contract: did(0),
	claimVisits: did(1),
	claimPlatform: did(2),
	actorChw: did(10),
	actorSupervisor: did(11),
	recPatient: did(20),
	recVisit: did(21),
	factName: did(30),
	factAge: did(31),
	factRisk: did(32),
	factVisitSummary: did(33),
	factClinic: did(34),
	ruleRisk: did(40),
	inputName: did(50),
	inputAge: did(51),
	inputSummary: did(52),
	writeName: did(60),
	writeAge: did(61),
	writeRisk: did(62),
	writeVisitSummary: did(63),
	taskRegister: did(70),
	taskVisit: did(71),
	transCreatePatient: did(80),
	transCreateVisit: did(81),
	rmPatients: did(90),
	accessSupervisor: did(100),
	navMain: did(110),
	decision: did(120),
	decisionOptionA: did(121),
	decisionOptionB: did(122),
	assumption: did(130),
	question: did(140),
	scenarioRegister: did(150),
	scenarioQueue: did(151),
	lookupVillages: did(160),
	lookupColVillageName: did(161),
	lookupColClinic: did(162),
	sliceRegister: did(200),
	sliceVisit: did(201),
	planId: "00000000-0000-4000-8000-000000000900",
	revisionId: "00000000-0000-4000-8000-000000000901",
} as const;

export function makeContract(): AppDesignContract {
	return {
		schemaVersion: 1,
		id: ids.contract,
		title: "CHW patient visits",
		objective:
			"Let community health workers register patients and record visits, with supervisor oversight.",
		inScope: ["Patient registration", "Visit recording"],
		outOfScope: ["Billing"],
		sourceClaims: [
			{
				id: ids.claimVisits,
				statement:
					"Community health workers register patients and record a summary for each visit.",
				sourceRefs: [messageRef()],
				status: "explicit",
				confidence: 0.95,
			},
			{
				id: ids.claimPlatform,
				statement:
					"Preview will not execute reminder automations; they need manual HQ setup.",
				sourceRefs: [
					{
						kind: "platform-constraint",
						code: "PREVIEW_AUTOMATIONS_NOT_EXECUTED",
						sourceAnchor: "docs/plans/complex-app-plan.md#what-is-built",
					},
				],
				status: "inferred",
				confidence: 1,
			},
		],
		actors: [
			{
				id: ids.actorChw,
				name: "Community health worker",
				goals: ["Register patients and record visits quickly"],
				responsibilities: ["Home visits"],
				workContext: ["Offline household visits"],
				authority: ["Creates patients and visits"],
				constraints: ["Short visit windows"],
				failureRisks: ["Missed follow-ups"],
				evidence: [ids.claimVisits],
			},
			{
				id: ids.actorSupervisor,
				name: "Supervisor",
				goals: ["Monitor visit coverage"],
				responsibilities: ["Review queues"],
				workContext: ["Clinic office"],
				authority: ["Views all patients"],
				constraints: [],
				failureRisks: [],
				evidence: [],
			},
		],
		records: [
			{
				id: ids.recPatient,
				name: "Patient",
				purpose: "A person receiving home visits.",
				lifecycleStates: ["active"],
				evidence: [ids.claimVisits],
			},
			{
				id: ids.recVisit,
				name: "Visit",
				purpose: "One completed home visit.",
				parentRecordId: ids.recPatient,
				relationshipMeaning: "A visit belongs to the visited patient.",
				lifecycleStates: ["recorded"],
				evidence: [ids.claimVisits],
			},
		],
		facts: [
			{
				id: ids.factName,
				recordId: ids.recPatient,
				name: "patient_name",
				meaning: "The patient's full name.",
				dataShape: "text",
				source: { kind: "answer", taskInputId: ids.inputName },
				sensitivity: "ordinary",
				writerTaskIds: [ids.taskRegister],
				readerIds: [ids.rmPatients],
				evidence: [ids.claimVisits],
			},
			{
				id: ids.factAge,
				recordId: ids.recPatient,
				name: "age",
				meaning: "The patient's age in years.",
				dataShape: "integer",
				source: { kind: "answer", taskInputId: ids.inputAge },
				sensitivity: "ordinary",
				writerTaskIds: [ids.taskRegister],
				readerIds: [ids.ruleRisk],
				evidence: [ids.claimVisits],
			},
			{
				id: ids.factRisk,
				recordId: ids.recPatient,
				name: "risk_level",
				meaning: "Derived triage level.",
				dataShape: "text",
				source: { kind: "derived", ruleId: ids.ruleRisk },
				sensitivity: "sensitive",
				writerTaskIds: [ids.taskRegister],
				readerIds: [ids.rmPatients],
				evidence: [ids.claimVisits],
			},
			{
				id: ids.factVisitSummary,
				recordId: ids.recVisit,
				name: "visit_summary",
				meaning: "What happened during the visit.",
				dataShape: "text",
				source: { kind: "answer", taskInputId: ids.inputSummary },
				sensitivity: "ordinary",
				writerTaskIds: [ids.taskVisit],
				readerIds: [],
				evidence: [ids.claimVisits],
			},
			{
				/* Reference data: read from the Project's village table, so no
				 * task writes it. */
				id: ids.factClinic,
				recordId: ids.recPatient,
				name: "catchment_clinic",
				meaning: "The clinic that covers the patient's village.",
				dataShape: "text",
				source: {
					kind: "lookup",
					lookupIntentId: ids.lookupVillages,
					columnIntentId: ids.lookupColClinic,
				},
				sensitivity: "ordinary",
				writerTaskIds: [],
				readerIds: [ids.rmPatients],
				evidence: [ids.claimVisits],
			},
		],
		rules: [
			{
				id: ids.ruleRisk,
				name: "Risk from age",
				statement: "Patients aged 60 or older are high risk.",
				inputIds: [ids.factAge],
				outputFactIds: [ids.factRisk],
				evidence: [ids.claimVisits],
			},
		],
		tasks: [
			{
				id: ids.taskRegister,
				name: "Register patient",
				actorId: ids.actorChw,
				goal: "Create the patient record at first contact.",
				trigger: "First household visit",
				preconditions: [],
				inputs: [
					{
						id: ids.inputName,
						name: "Name",
						purpose: "Identify the patient.",
						factId: ids.factName,
						evidence: [ids.claimVisits],
					},
					{
						id: ids.inputAge,
						name: "Age",
						purpose: "Assess risk.",
						factId: ids.factAge,
						evidence: [ids.claimVisits],
					},
				],
				decisionRuleIds: [ids.ruleRisk],
				writes: [
					{
						id: ids.writeName,
						targetFactId: ids.factName,
						sourceDescription: "The name answer, verbatim.",
					},
					{
						id: ids.writeAge,
						targetFactId: ids.factAge,
						sourceDescription: "The age answer, verbatim.",
					},
					{
						id: ids.writeRisk,
						targetFactId: ids.factRisk,
						sourceDescription: "Derived from age.",
						ruleId: ids.ruleRisk,
					},
				],
				transitionIds: [ids.transCreatePatient],
				readBackIds: [ids.rmPatients],
				exceptionPaths: ["Patient declines registration"],
				evidence: [ids.claimVisits],
			},
			{
				id: ids.taskVisit,
				name: "Record visit",
				actorId: ids.actorChw,
				goal: "Capture what happened during a visit.",
				trigger: "A completed home visit",
				contextRecordId: ids.recPatient,
				preconditions: ["Patient is registered"],
				inputs: [
					{
						id: ids.inputSummary,
						name: "Visit summary",
						purpose: "Record the visit outcome.",
						factId: ids.factVisitSummary,
						evidence: [ids.claimVisits],
					},
				],
				decisionRuleIds: [],
				writes: [],
				transitionIds: [ids.transCreateVisit],
				readBackIds: [],
				exceptionPaths: [],
				evidence: [ids.claimVisits],
			},
		],
		transitions: [
			{
				id: ids.transCreatePatient,
				name: "Patient registered",
				targetRecordId: ids.recPatient,
				transitionKind: "create",
				writes: [],
				outcomeDescription: "A new patient record exists.",
				evidence: [ids.claimVisits],
			},
			{
				id: ids.transCreateVisit,
				name: "Visit recorded",
				sourceRecordId: ids.recPatient,
				targetRecordId: ids.recVisit,
				transitionKind: "create",
				writes: [
					{
						id: ids.writeVisitSummary,
						targetFactId: ids.factVisitSummary,
						sourceDescription: "The visit summary answer.",
					},
				],
				outcomeDescription: "A visit record exists under the patient.",
				evidence: [ids.claimVisits],
			},
		],
		readModels: [
			{
				id: ids.rmPatients,
				name: "My patients",
				actorIds: [ids.actorChw, ids.actorSupervisor],
				recordId: ids.recPatient,
				decisionSupported: "Which patient needs a visit next.",
				filters: ["Active patients only"],
				sortIntent: ["Highest risk first"],
				scanFactIds: [ids.factName, ids.factRisk],
				detailFactIds: [
					ids.factName,
					ids.factAge,
					ids.factRisk,
					ids.factClinic,
				],
				searchFactIds: [ids.factName],
				selectionTaskId: ids.taskVisit,
				emptyStateMeaning: "No registered patients yet.",
				evidence: [ids.claimVisits],
			},
		],
		lookupIntents: [
			{
				id: ids.lookupVillages,
				name: "Villages",
				purpose:
					"The catchment villages a CHW covers and the clinic each reports to.",
				columns: [
					{
						id: ids.lookupColVillageName,
						name: "village_name",
						meaning: "The village's name as workers know it.",
						evidence: [ids.claimVisits],
					},
					{
						id: ids.lookupColClinic,
						name: "clinic_name",
						meaning: "The clinic covering that village.",
						evidence: [ids.claimVisits],
					},
				],
				evidence: [ids.claimVisits],
			},
		],
		accessPolicies: [
			{
				id: ids.accessSupervisor,
				actorId: ids.actorSupervisor,
				targetIntentIds: [ids.rmPatients],
				capability: "view",
				evidence: [ids.claimVisits],
			},
		],
		navigation: [
			{
				id: ids.navMain,
				actorIds: [ids.actorChw],
				name: "Patients",
				purpose: "Everything a CHW does starts from the patient list.",
				entryTaskIds: [ids.taskRegister],
				readModelIds: [ids.rmPatients],
				orderRationale: "Registration first; the queue drives daily work.",
			},
		],
		decisions: [
			{
				id: ids.decision,
				question: "Are visits their own record or fields on the patient?",
				options: [
					{
						id: ids.decisionOptionA,
						description: "Visits are child records of the patient.",
						consequences: ["Visit history is queryable per patient."],
					},
					{
						id: ids.decisionOptionB,
						description: "The patient carries only the latest visit.",
						consequences: ["History is lost on each new visit."],
					},
				],
				selectedOptionId: ids.decisionOptionA,
				rationale: "Visit history drives supervision.",
				evidence: [ids.claimVisits],
			},
		],
		assumptions: [
			{
				id: ids.assumption,
				statement: "One CHW covers one patient at a time — no team handoffs.",
				consequenceIfWrong: "Queues would need shared ownership.",
				evidence: [ids.claimPlatform],
			},
		],
		openQuestions: [
			{
				id: ids.question,
				question: "Should closed patients be archivable?",
				structuralImpact: "local",
				blocking: false,
				relatedIntentIds: [ids.taskVisit],
			},
		],
		acceptanceScenarios: [
			{
				id: ids.scenarioRegister,
				name: "Register a new patient",
				actorId: ids.actorChw,
				given: ["The CHW is at a household"],
				when: ["They register a patient with name and age"],
				// biome-ignore lint/suspicious/noThenProperty: scenario vocabulary; array value
				then: ["The patient appears in the queue with a risk level"],
				relatedIntentIds: [ids.taskRegister, ids.rmPatients],
				evidence: [ids.claimVisits],
			},
			{
				id: ids.scenarioQueue,
				name: "Supervisor reviews the queue",
				actorId: ids.actorSupervisor,
				given: ["Patients exist"],
				when: ["The supervisor opens the patient queue"],
				// biome-ignore lint/suspicious/noThenProperty: scenario vocabulary; array value
				then: ["Patients are ordered by risk"],
				relatedIntentIds: [ids.rmPatients],
				evidence: [ids.claimVisits],
			},
		],
		deferredRequirements: [],
	};
}

/** Parse the fixture through the real schema — the tests' way of asserting
 *  the fixture itself stays graph-valid. */
export function parseContract(contract: AppDesignContract): AppDesignContract {
	return appDesignContractSchema.parse(contract);
}

/** A scenario helper for clone-and-break tests. */
export function cloneContract(contract: AppDesignContract): AppDesignContract {
	return structuredClone(contract);
}

export function makeBuildPlan(): BuildPlan {
	return {
		schemaVersion: 2,
		designRevisionId: ids.revisionId,
		designRevisionDigest: "a".repeat(64),
		id: ids.planId,
		slices: [
			{
				id: ids.sliceRegister,
				name: "Patient registration and queue",
				goal: "A CHW can register a patient and see the risk-ordered queue.",
				intentIds: [
					ids.recPatient,
					ids.factName,
					ids.factAge,
					ids.factRisk,
					ids.factClinic,
					ids.ruleRisk,
					ids.taskRegister,
					ids.transCreatePatient,
					ids.rmPatients,
					ids.navMain,
					ids.accessSupervisor,
				],
				ownedIntentIds: [
					ids.recPatient,
					ids.factName,
					ids.factAge,
					ids.factRisk,
					ids.factClinic,
					ids.ruleRisk,
					ids.taskRegister,
					ids.transCreatePatient,
					ids.rmPatients,
					ids.navMain,
					ids.accessSupervisor,
				],
				prerequisiteSliceIds: [],
				acceptanceScenarioIds: [ids.scenarioRegister, ids.scenarioQueue],
				risk: "ordinary",
				role: "materialization-root",
				expectedBlueprintAreas: [
					"app",
					"case-catalog",
					"forms",
					"case-list",
					"navigation",
				],
				externalActionIds: [],
			},
			{
				id: ids.sliceVisit,
				name: "Visit recording",
				goal: "A CHW can record a visit under a selected patient.",
				intentIds: [
					ids.recVisit,
					ids.factVisitSummary,
					ids.taskVisit,
					ids.transCreateVisit,
					ids.rmPatients,
				],
				ownedIntentIds: [
					ids.recVisit,
					ids.factVisitSummary,
					ids.taskVisit,
					ids.transCreateVisit,
				],
				prerequisiteSliceIds: [ids.sliceRegister],
				acceptanceScenarioIds: [],
				risk: "cross-record",
				role: "ordinary",
				expectedBlueprintAreas: ["forms", "case-operations"],
				externalActionIds: [],
			},
		],
		externalActions: [],
		intentOwnership: [
			{
				intentId: ids.recPatient,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.factName,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.factAge,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.factRisk,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.factClinic,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.ruleRisk,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.taskRegister,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.transCreatePatient,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.rmPatients,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [ids.sliceVisit],
			},
			{
				intentId: ids.navMain,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.accessSupervisor,
				owningSliceId: ids.sliceRegister,
				contributingSliceIds: [],
			},
			{
				intentId: ids.recVisit,
				owningSliceId: ids.sliceVisit,
				contributingSliceIds: [],
			},
			{
				intentId: ids.factVisitSummary,
				owningSliceId: ids.sliceVisit,
				contributingSliceIds: [],
			},
			{
				intentId: ids.taskVisit,
				owningSliceId: ids.sliceVisit,
				contributingSliceIds: [],
			},
			{
				intentId: ids.transCreateVisit,
				owningSliceId: ids.sliceVisit,
				contributingSliceIds: [],
			},
		],
	};
}

export function parsePlan(plan: BuildPlan): BuildPlan {
	return buildPlanSchema.parse(plan);
}
