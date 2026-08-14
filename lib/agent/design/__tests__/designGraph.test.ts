import { describe, expect, it } from "vitest";
import {
	appDesignContractSchema,
	designConstructionIssues,
} from "@/lib/agent/design/contract";
import {
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeContract,
} from "./fixtures";

function messages(value: unknown): string {
	const result = appDesignContractSchema.safeParse(value);
	return result.success
		? ""
		: result.error.issues.map((issue) => issue.message).join("\n");
}

function constructionMessages(value: ReturnType<typeof makeContract>): string {
	return designConstructionIssues(value)
		.map((issue) => issue.message)
		.join("\n");
}

describe("lean Design Contract graph", () => {
	it("accepts and round-trips a task-complete contract", () => {
		const contract = makeContract();
		expect(appDesignContractSchema.parse(contract)).toEqual(contract);
	});

	it("preserves optional semantic input validation without making it a quota", () => {
		const contract = cloneContract(makeContract());
		const input = fixtureValue(
			contract.workflows[0]?.inputs[0],
			"first workflow input",
		);
		input.validation = {
			rule: "When answered, the phone number must contain at least seven digits.",
			message: "Enter a valid phone number.",
		};
		expect(appDesignContractSchema.parse(contract)).toEqual(contract);

		const withoutValidation = cloneContract(makeContract());
		expect(appDesignContractSchema.safeParse(withoutValidation).success).toBe(
			true,
		);
	});

	it("reads historical v1 contracts without composition but refuses them for new construction", () => {
		const historical = cloneContract(makeContract()) as unknown as Record<
			string,
			unknown
		>;
		delete historical.moduleCompositions;
		delete historical.formCompositions;
		const parsed = appDesignContractSchema.parse(historical);
		expect(parsed.moduleCompositions).toEqual([]);
		expect(parsed.formCompositions).toEqual([]);
		expect(constructionMessages(parsed)).toContain("module composition");
		expect(constructionMessages(parsed)).toContain("form composition");
	});

	it("is closed and rejects duplicate semantic identities", () => {
		const unknown = { ...makeContract(), surprise: true };
		expect(appDesignContractSchema.safeParse(unknown).success).toBe(false);

		const duplicate = cloneContract(makeContract());
		if (!duplicate.records[0]) throw new Error("fixture record missing");
		duplicate.records[0].id = ids.actorChw;
		expect(messages(duplicate)).toContain("already used");
	});

	it("enforces the one-app charter's complete workflow boundary", () => {
		const contract = cloneContract(makeContract());
		contract.charter.includedWorkflowIds = [ids.taskRegister];
		expect(messages(contract)).toContain("include every workflow");
	});

	it("admits no unsupported media feature, empty shell, or unresolved build contract", () => {
		const media = cloneContract(makeContract()) as unknown as {
			workflows: Array<{ authoredFeatures: string[] }>;
		};
		const mediaWorkflow = media.workflows[0];
		if (mediaWorkflow === undefined)
			throw new Error("fixture workflow missing");
		mediaWorkflow.authoredFeatures = ["generated-media"];
		expect(messages(media)).toContain("Invalid option");

		const disabled = cloneContract(makeContract());
		const disabledWorkflow = fixtureValue(
			disabled.workflows[0],
			"first workflow",
		);
		disabledWorkflow.inputs = [];
		disabledWorkflow.decisions = [];
		disabledWorkflow.recordEffects = [];
		disabledWorkflow.authoredFeatures = [];
		disabledWorkflow.readback = [];
		expect(constructionMessages(disabled)).toContain("empty workflow shell");

		/* The authored blocking flag is the construction gate. A non-blocking
		 * question beside concrete design — the spelling for a decision the
		 * user delegated or a production-hardening note — never forces a user
		 * pause; the concreteness checks still catch unbuildable design. */
		const delegated = cloneContract(makeContract());
		delegated.openQuestions.push({
			id: ids.question,
			question: "What calculation should this workflow perform?",
			blocking: false,
			relatedElementIds: [ids.taskRegister],
		});
		expect(constructionMessages(delegated)).toBe("");

		const unresolved = cloneContract(makeContract());
		unresolved.openQuestions.push({
			id: ids.question,
			question: "What calculation should this workflow perform?",
			blocking: true,
			relatedElementIds: [ids.taskRegister],
		});
		expect(constructionMessages(unresolved)).toContain(
			"must be answered or its workflow explicitly excluded",
		);
	});

	it("admits human media readiness but rejects structurally empty workflows", () => {
		const readiness = cloneContract(makeContract());
		readiness.externalRequirements.push({
			id: ids.externalSetup,
			name: "Existing image",
			kind: "user-prerequisite",
			description:
				"An administrator must upload an image before Nova can attach the existing asset.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: false,
		});
		expect(constructionMessages(readiness)).toBe("");

		const empty = cloneContract(makeContract());
		const workflow = fixtureValue(empty.workflows[0], "first workflow");
		workflow.inputs = [];
		workflow.decisions = [];
		workflow.recordEffects = [];
		workflow.authoredFeatures = [];
		workflow.readback = [];
		expect(constructionMessages(empty)).toContain("empty workflow shell");
	});

	it("treats unresolved actor construction as a blocking design question", () => {
		const contract = cloneContract(makeContract());
		contract.openQuestions.push({
			id: ids.question,
			question: "Which worker property distinguishes this actor?",
			blocking: true,
			relatedElementIds: [ids.actorChw],
		});
		expect(constructionMessages(contract)).toContain(
			"must be answered or its workflow explicitly excluded",
		);
	});

	it("does not mistake a concrete pending status value for deferred design work", () => {
		const contract = cloneContract(makeContract());
		const write = contract.workflows[0]?.recordEffects[0]?.writes[0];
		if (write === undefined) throw new Error("fixture write missing");
		write.value = "pending";
		expect(constructionMessages(contract)).toBe("");
	});

	it("does not infer construction state from domain prose", () => {
		const contract = cloneContract(makeContract());
		const workflow = fixtureValue(contract.workflows[0], "first workflow");
		workflow.goal = "Process deferred referrals in a follow-up form";
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Existing image",
			kind: "user-prerequisite",
			description:
				"Nova cannot upload the image; an administrator must upload it before runtime.",
			relatedWorkflowIds: [workflow.id],
			blocksConstruction: false,
		});
		expect(constructionMessages(contract)).toBe("");
	});

	it("admits a form-only workflow with no record mutation", () => {
		const contract = cloneContract(makeContract());
		const workflow = fixtureValue(contract.workflows[0], "first workflow");
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
		const sharedModule = fixtureValue(
			contract.moduleCompositions[0],
			"shared module composition",
		);
		sharedModule.workflowIds = [ids.taskVisit];
		contract.moduleCompositions.push({
			id: did(780),
			name: "Standalone survey",
			purpose: "Host the form-only survey without a record context.",
			role: "form-host",
			workflowIds: [ids.taskRegister],
			actorIds: [ids.actorChw],
			navigationIds: [],
			listIds: [],
			orderRationale: "Keep the standalone task available before record work.",
			icon: { kind: "builtin", slug: "default" },
			roleSeparationRationale:
				"A standalone form cannot share the patient record host.",
		});
		const formComposition = fixtureValue(
			contract.formCompositions[0],
			"first form composition",
		);
		formComposition.moduleCompositionId = did(780);
		formComposition.mode = "standalone";
		formComposition.layout = {
			kind: "flat",
			rationale: "One standalone answer has no useful grouping boundary.",
			items: [
				{
					kind: "input",
					id: did(781),
					inputHandle: "survey_answer",
					labelMarkdown: "Survey answer",
				},
			],
		};
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(constructionMessages(contract)).toBe("");
	});

	it("keeps a child create effect from turning a selected-context workflow into registration", () => {
		const contract = cloneContract(makeContract());
		const visitForm = fixtureValue(
			contract.formCompositions.find(
				(composition) => composition.workflowId === ids.taskVisit,
			),
			"visit form composition",
		);
		visitForm.mode = "registration";
		expect(messages(contract)).toContain(
			"a child record it creates is an effect, not the form host",
		);
	});

	it("rejects a conditional primary create on an unconditional registration form", () => {
		const contract = cloneContract(makeContract());
		const registration = fixtureValue(
			contract.workflows.find((workflow) => workflow.id === ids.taskRegister),
			"registration workflow",
		);
		const create = fixtureValue(
			registration.recordEffects.find((effect) => effect.kind === "create"),
			"primary create",
		);
		create.condition = "The worker gave consent";
		expect(messages(contract)).toContain(
			"registration form always creates its hosted record",
		);
		expect(messages(contract)).toContain(
			"standalone form with a conditional create effect",
		);
	});

	it("rejects record and navigation cycles", () => {
		const records = cloneContract(makeContract());
		if (!records.records[0]) throw new Error("fixture record missing");
		records.records[0].parentRecordId = ids.recVisit;
		expect(messages(records)).toContain("must not form a cycle");

		const navigation = cloneContract(makeContract());
		navigation.navigation.push({
			id: did(800),
			name: "Nested",
			purpose: "Test nesting",
			actorIds: [ids.actorChw],
			workflowIds: [],
			listIds: [],
			parentNavigationId: ids.navMain,
			orderRationale: "Nested after main",
		});
		if (!navigation.navigation[0])
			throw new Error("fixture navigation missing");
		navigation.navigation[0].parentNavigationId = did(800);
		expect(messages(navigation)).toContain("must not form a cycle");
	});

	it("rejects workflow dependency cycles and duplicate local handles", () => {
		const cycle = cloneContract(makeContract());
		cycle.workflows[0]?.prerequisiteWorkflowIds.push(ids.taskVisit);
		expect(messages(cycle)).toContain("must not form a cycle");

		const handles = cloneContract(makeContract());
		const workflow = handles.workflows[0];
		if (!workflow) throw new Error("fixture workflow missing");
		const decision = fixtureValue(workflow.decisions[0], "first decision");
		const input = fixtureValue(workflow.inputs[0], "first input");
		workflow.decisions[0] = {
			...decision,
			handle: input.handle,
		};
		expect(messages(handles)).toContain("handles must be unique");
	});

	it("accepts convergent workflow dependencies and requires a root first workflow", () => {
		const diamond = cloneContract(makeContract());
		const visit = fixtureValue(diamond.workflows[1], "visit workflow");
		const parallel = {
			...structuredClone(visit),
			id: did(801),
			name: "Parallel visit preparation",
			prerequisiteWorkflowIds: [ids.taskRegister],
		};
		const convergent = {
			...structuredClone(visit),
			id: did(802),
			name: "Convergent follow-up",
			prerequisiteWorkflowIds: [ids.taskVisit, parallel.id],
		};
		diamond.workflows.push(parallel, convergent);
		diamond.charter.includedWorkflowIds.push(parallel.id, convergent.id);
		const moduleComposition = fixtureValue(
			diamond.moduleCompositions[0],
			"module composition",
		);
		moduleComposition.workflowIds.push(parallel.id, convergent.id);
		const visitComposition = fixtureValue(
			diamond.formCompositions[1],
			"visit form composition",
		);
		for (const [workflowId, offset] of [
			[parallel.id, 0],
			[convergent.id, 10],
		] as const) {
			diamond.formCompositions.push({
				...structuredClone(visitComposition),
				id: did(810 + offset),
				workflowId,
				layout: {
					kind: "flat",
					rationale: "The copied test workflow has one concise input.",
					items: [
						{
							kind: "input",
							id: did(811 + offset),
							inputHandle: "visit_summary",
							labelMarkdown: "Visit summary",
						},
					],
				},
			});
		}
		expect(appDesignContractSchema.safeParse(diamond).success).toBe(true);

		const dependentRoot = cloneContract(makeContract());
		dependentRoot.charter.initialWorkflowId = ids.taskVisit;
		expect(messages(dependentRoot)).toContain(
			"initial workflow must not depend",
		);
	});

	it("requires form-only inputs to declare a data shape", () => {
		const contract = cloneContract(makeContract());
		contract.workflows[0]?.inputs.push({
			handle: "temporary_note",
			name: "Temporary note",
			purpose: "Do not save this answer",
		});
		expect(messages(contract)).toContain("declare its data shape");
	});

	it("requires choices only for form-only choice inputs", () => {
		const missingChoices = cloneContract(makeContract());
		missingChoices.workflows[0]?.inputs.push({
			handle: "temporary_choice",
			name: "Temporary choice",
			purpose: "Choose without saving",
			dataShape: "single-choice",
		});
		expect(messages(missingChoices)).toContain("must name its allowed values");

		const strayChoices = cloneContract(makeContract());
		strayChoices.workflows[0]?.inputs.push({
			handle: "temporary_note",
			name: "Temporary note",
			purpose: "Capture without saving",
			dataShape: "text",
			choiceValues: ["not applicable"],
		});
		expect(messages(strayChoices)).toContain("Only a form-only choice input");
	});

	it("carries an existing Project lookup as the alternative to inline choices", () => {
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
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(designConstructionIssues(contract)).toEqual([]);

		risk.choiceValues = ["routine", "urgent"];
		expect(messages(contract)).toContain("either inline values");
	});

	it("keeps writes, readback, and list properties on the named record", () => {
		const write = cloneContract(makeContract());
		write.workflows[0]?.recordEffects[0]?.writes.push({
			propertyId: ids.factVisitSummary,
			value: "Wrong record",
			unanswered: "preserve",
		});
		expect(messages(write)).toContain("target record");

		const readback = cloneContract(makeContract());
		readback.workflows[0]?.readback[0]?.propertyIds.push(ids.factVisitSummary);
		expect(messages(readback)).toContain("record being shown");

		const list = cloneContract(makeContract());
		list.lists[0]?.scanPropertyIds.push(ids.factVisitSummary);
		expect(messages(list)).toContain("only properties of its record");
	});

	it("requires real choice values", () => {
		const contract = cloneContract(makeContract());
		const risk = contract.records[0]?.properties.find(
			(property) => property.id === ids.factRisk,
		);
		if (!risk) throw new Error("fixture risk property missing");
		delete risk.choiceValues;
		expect(messages(contract)).toContain("must name its allowed values");
	});

	it("keeps persisted v1 single choices readable but refuses them for new construction", () => {
		const contract = cloneContract(makeContract());
		const risk = contract.records[0]?.properties.find(
			(property) => property.id === ids.factRisk,
		);
		if (!risk) throw new Error("fixture risk property missing");
		risk.choiceValues = ["priority"];
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(designConstructionIssues(contract)).toEqual([
			expect.objectContaining({
				message: expect.stringContaining("at least two distinct real values"),
			}),
		]);
	});

	it("rejects unresolved references and unsupported promises", () => {
		const actor = cloneContract(makeContract());
		actor.workflows[0]?.actorIds.push(did(9999));
		expect(messages(actor)).toContain("does not exist");

		const unsupported = cloneContract(makeContract());
		unsupported.externalRequirements.push({
			id: ids.externalSetup,
			name: "Generate audio",
			kind: "unsupported",
			description: "Nova would need to generate an audio prompt.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: false,
		});
		expect(messages(unsupported)).toContain("must block");
	});

	it("keeps construction-blocking dependencies tied to a user question", () => {
		const blocked = cloneContract(makeContract());
		blocked.externalRequirements.push({
			id: ids.externalSetup,
			name: "Existing audio prompt",
			kind: "existing-reference",
			description: "Choose an already-uploaded audio prompt.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: true,
		});
		blocked.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		expect(messages(blocked)).toContain("blocking user question");

		blocked.openQuestions.push({
			id: ids.question,
			question: "Which existing audio prompt should this app use?",
			blocking: true,
			relatedElementIds: [ids.externalSetup],
		});
		expect(appDesignContractSchema.safeParse(blocked).success).toBe(true);
	});
});
