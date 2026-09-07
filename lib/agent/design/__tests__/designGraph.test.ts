import { describe, expect, it } from "vitest";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import {
	appDesignContractSchema,
	designConstructionIssues,
	designConstructionQuestionRequirements,
	type ExistingLookupChoiceSource,
	existingLookupChoicePostChangeIssues,
} from "@/lib/agent/design/contract";
import { designIdentityCollisions } from "@/lib/agent/design/graph";
import { computeLookupChoiceProjectionAttestation } from "@/lib/agent/design/lookupChoiceAttestation";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
import {
	addPatientReviewWorkflow,
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeContract,
	makeLookupContract,
	makeNestedMenuContract,
	makeThirteenWorkflowContract,
	messageRef,
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
const EXISTING_ROW_ONE_ID = lookupRowIdSchema.parse(
	"018f0000-0000-7000-8000-000000000004",
);
const EXISTING_ROW_TWO_ID = lookupRowIdSchema.parse(
	"018f0000-0000-7000-8000-000000000005",
);

function existingInspection(tableRevision = "7") {
	return computeLookupChoiceProjectionAttestation({
		tableRevision: lookupRevisionSchema.parse(tableRevision),
		tableName: "Risk levels",
		valueColumnLabel: "Value",
		labelColumnLabel: "Label",
		rows: [
			{ rowId: EXISTING_ROW_ONE_ID, value: "routine", label: "Routine" },
			{ rowId: EXISTING_ROW_TWO_ID, value: "priority", label: "Priority" },
		],
	});
}

function messages(value: unknown): string {
	const result = appDesignContractSchema.safeParse(value);
	return result.success
		? ""
		: result.error.issues.map((issue) => issue.message).join("\n");
}

function graphIssues(value: unknown) {
	const result = appDesignContractSchema.safeParse(value);
	expect(result.success).toBe(false);
	if (result.success)
		throw new Error("Expected graph admission to refuse the candidate.");
	return result.error.issues.map(({ code, path }) => ({ code, path }));
}

function constructionMessages(value: ReturnType<typeof makeContract>): string {
	return designConstructionIssues(appDesignContractSchema.parse(value))
		.map((issue) => issue.message)
		.join("\n");
}

describe("lean Design Contract graph", () => {
	it("accepts one-tier parent-first module composition", () => {
		const contract = makeNestedMenuContract();
		expect(constructionMessages(contract)).toBe("");
	});

	it("rejects a materialization-root module placed after a later-owned sibling", () => {
		const contract = cloneContract(makeThirteenWorkflowContract());
		const first = fixtureValue(contract.moduleCompositions[0], "first module");
		const second = fixtureValue(
			contract.moduleCompositions[1],
			"second module",
		);
		contract.moduleCompositions.splice(0, 2, second, first);

		expect(messages(contract)).toContain(
			"construction owner must be the same as or later than its preceding sibling's owner",
		);
	});

	it("rejects a child menu that is ordered before its parent", () => {
		const contract = cloneContract(makeNestedMenuContract());
		contract.moduleCompositions.reverse();
		expect(messages(contract)).toContain(
			"A parent module composition must appear before its child",
		);
	});

	it("rejects a second submenu tier", () => {
		const contract = cloneContract(makeNestedMenuContract());
		const child = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		contract.moduleCompositions.push({
			...structuredClone(child),
			id: did(881),
			name: "Deep follow-up",
			parentModuleCompositionId: child.id,
		});
		expect(messages(contract)).toContain("Nova supports one submenu tier");
	});

	it("rejects a different-record child beneath a queue-only parent", () => {
		const contract = cloneContract(makeNestedMenuContract());
		const parent = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.modulePatients,
			),
			"parent module composition",
		);
		const child = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		parent.role = "queue-only";
		child.hostRecordId = ids.recVisit;

		expect(messages(contract)).toContain(
			"A child menu beneath a queue-only parent must host the same record",
		);
	});

	it("requires every module owner to own the module's initial surface", () => {
		const contract = cloneContract(makeNestedMenuContract());
		const parent = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.modulePatients,
			),
			"parent module composition",
		);
		const child = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		parent.listIds = [];
		child.workflowIds = [ids.taskRegister];
		for (const form of contract.formCompositions) {
			form.moduleCompositionId =
				form.workflowId === ids.taskRegister ? child.id : parent.id;
		}
		expect(messages(contract)).toContain(
			"construction owner must also own its initial form or case-list surface",
		);
	});

	it("rejects a different-record child built before the parent's first form", () => {
		const contract = cloneContract(makeNestedMenuContract());
		const parent = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.modulePatients,
			),
			"parent module composition",
		);
		const child = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		child.workflowIds = [ids.taskRegister];
		child.hostRecordId = ids.recVisit;
		for (const form of contract.formCompositions) {
			form.moduleCompositionId =
				form.workflowId === ids.taskRegister ? child.id : parent.id;
		}

		expect(messages(contract)).toContain(
			"must be owned by the same workflow as or a later workflow than the parent menu's first form",
		);
	});

	it("rejects a child viewer built after a parent-menu form creates its cases", () => {
		const contract = cloneContract(makeNestedMenuContract());
		const child = fixtureValue(
			contract.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"child module composition",
		);
		child.hostRecordId = ids.recVisit;
		const parentWriter = fixtureValue(
			contract.workflows.find((workflow) => workflow.id === ids.taskRegister),
			"parent writer workflow",
		);
		const visitCreate = fixtureValue(
			contract.workflows
				.find((workflow) => workflow.id === ids.taskVisit)
				?.recordEffects.find(
					(effect) =>
						effect.kind === "create" && effect.recordId === ids.recVisit,
				),
			"visit create effect",
		);
		parentWriter.recordEffects.push({
			...structuredClone(visitCreate),
			handle: "create_visit_from_registration",
		});

		expect(messages(contract)).toContain(
			"must be owned by the same workflow as or an earlier workflow than the first such form",
		);
	});

	it("admits manual Zulu localization even when automatic translation is unavailable", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "zul" },
			targets: [
				{
					language: { language: "zul" },
					seedFrom: { language: "eng" },
					strategy: "copy-only",
				},
			],
		};
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(
			designConstructionIssues(appDesignContractSchema.parse(contract)),
		).toEqual([]);
	});

	it("admits automatic English-to-Spanish translation", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "eng" },
					strategy: "translate-with-nova",
				},
			],
		};
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(
			designConstructionIssues(appDesignContractSchema.parse(contract)),
		).toEqual([]);
	});

	it("refuses automatic English-to-Zulu translation at construction", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "zul" },
					seedFrom: { language: "eng" },
					strategy: "translate-with-nova",
				},
			],
		};
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(constructionMessages(contract)).toContain(
			"this pair isn't covered yet",
		);
	});

	it("rejects cyclic target-language copy dependencies", () => {
		const contract = cloneContract(makeContract());
		contract.charter.localization = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa" },
					seedFrom: { language: "fra" },
					strategy: "copy-only",
				},
				{
					language: { language: "fra" },
					seedFrom: { language: "spa" },
					strategy: "copy-only",
				},
			],
		};
		expect(messages(contract)).toContain("without a cycle");
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
		expect(
			appDesignContractSchema.parse(contract).workflows[0]?.inputs[0]
				?.validation,
		).toEqual({
			rule: "When answered, the phone number must contain at least seven digits.",
			message: "Enter a valid phone number.",
		});

		const withoutValidation = cloneContract(makeContract());
		expect(appDesignContractSchema.safeParse(withoutValidation).success).toBe(
			true,
		);
	});

	it("keeps additive collections required in the live domain schema", () => {
		const incomplete = cloneContract(makeContract()) as unknown as Record<
			string,
			unknown
		>;
		delete incomplete.moduleCompositions;
		delete incomplete.formCompositions;
		delete incomplete.lookupTables;
		expect(graphIssues(incomplete)).toEqual([
			{ code: "invalid_type", path: ["moduleCompositions"] },
			{ code: "invalid_type", path: ["formCompositions"] },
			{ code: "invalid_type", path: ["lookupTables"] },
		]);
	});

	it("requires one module owner for every accepted list and navigation entry", () => {
		const missing = cloneContract(makeContract());
		const moduleComposition = fixtureValue(
			missing.moduleCompositions[0],
			"module composition",
		);
		moduleComposition.role = "form-host";
		moduleComposition.listIds = [];
		moduleComposition.navigationIds = [];
		expect(constructionMessages(missing)).toContain(
			"Every accepted list needs exactly one module composition",
		);
		expect(constructionMessages(missing)).toContain(
			"Every accepted navigation entry needs exactly one module composition",
		);

		const repeated = cloneContract(makeContract());
		const existingModule = fixtureValue(
			repeated.moduleCompositions[0],
			"module composition",
		);
		repeated.moduleCompositions.push({
			...structuredClone(existingModule),
			id: did(799),
			name: "Repeated placement",
			role: "queue-only",
			selection: undefined,
		});
		expect(constructionMessages(repeated)).toContain(
			"Give repeated placements distinct list identities",
		);
		expect(constructionMessages(repeated)).toContain(
			"Give repeated destinations distinct navigation identities",
		);
	});

	it("is closed and rejects duplicate semantic identities", () => {
		const unknown = { ...makeContract(), surprise: true };
		expect(graphIssues(unknown)).toEqual([
			{ code: "unrecognized_keys", path: [] },
		]);

		const duplicate = cloneContract(makeContract());
		if (!duplicate.records[0]) throw new Error("fixture record missing");
		duplicate.records[0].id = ids.actorChw;
		expect(graphIssues(duplicate)).toContainEqual({
			code: "custom",
			path: ["records", 0, "id"],
		});
	});

	it("refuses nested lookup declarations that reuse an actor or property identity", () => {
		const contract = makeLookupContract();
		const table = fixtureValue(contract.lookupTables[0], "created lookup");
		if (table.kind !== "create") throw new Error("Expected created table.");
		fixtureValue(table.columns[0], "value column").id = ids.actorChw;
		fixtureValue(table.rows[0], "routine row").id = ids.factRisk;
		expect(designIdentityCollisions(contract)).toEqual([
			{
				path: ["lookupTables", 0, "columns", 0, "id"],
				priorPath: ["actors", 0, "id"],
			},
			{
				path: ["lookupTables", 0, "rows", 0, "id"],
				priorPath: ["records", 0, "properties", 2, "id"],
			},
		]);
	});

	it("finds declaration collisions during an incomplete lookup change without counting references", () => {
		const partial = {
			actors: [{ id: ids.actorChw }],
			lookupTables: [
				{
					id: ids.lookupRisk,
					kind: "modify-existing",
					operations: [
						{ kind: "add-column", column: { id: ids.actorChw } },
						{
							kind: "add-row",
							rowId: ids.lookupRiskRoutine,
							cells: [
								{
									column: { kind: "designed-column", columnId: ids.actorChw },
									value: "routine",
								},
							],
						},
						{ kind: "update-row", rowId: ids.lookupRiskRoutine },
						{ kind: "replace-rows", rows: [{ id: ids.lookupRiskRoutine }] },
					],
				},
			],
		};
		expect(designIdentityCollisions(partial)).toEqual([
			{
				path: ["lookupTables", 0, "operations", 0, "column", "id"],
				priorPath: ["actors", 0, "id"],
			},
			{
				path: ["lookupTables", 0, "operations", 3, "rows", 0, "id"],
				priorPath: ["lookupTables", 0, "operations", 1, "rowId"],
			},
		]);
	});

	it("keeps section and flat-layout item declarations in the global identity namespace", () => {
		const partial = {
			formCompositions: [
				{
					id: ids.formRegister,
					layout: {
						kind: "sectioned",
						sections: [
							{ id: ids.sectionRegisterIdentity, items: [{ id: did(8001) }] },
						],
					},
				},
				{
					id: ids.formVisit,
					layout: {
						kind: "flat",
						items: [{ id: ids.sectionRegisterIdentity }, { id: did(8001) }],
					},
				},
			],
		};
		expect(designIdentityCollisions(partial)).toEqual([
			{
				path: ["formCompositions", 1, "layout", "items", 0, "id"],
				priorPath: ["formCompositions", 0, "layout", "sections", 0, "id"],
			},
			{
				path: ["formCompositions", 1, "layout", "items", 1, "id"],
				priorPath: [
					"formCompositions",
					0,
					"layout",
					"sections",
					0,
					"items",
					0,
					"id",
				],
			},
		]);
	});

	it("requires each workflow exactly once while allowing a reordered charter", () => {
		const contract = cloneContract(makeContract());
		contract.charter.includedWorkflowIds.reverse();
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		contract.charter.includedWorkflowIds.push(ids.taskRegister);
		expect(graphIssues(contract)).toEqual([
			{ code: "custom", path: ["charter", "includedWorkflowIds"] },
		]);
		contract.charter.includedWorkflowIds = [ids.taskRegister];
		expect(graphIssues(contract)).toEqual([
			{ code: "custom", path: ["charter", "includedWorkflowIds"] },
		]);
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
		disabled.formCompositions = disabled.formCompositions.filter(
			(form) => form.workflowId !== disabledWorkflow.id,
		);
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

	it("admits human media readiness", () => {
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
		contract.moduleCompositions.unshift({
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
		expect(graphIssues(records)).toEqual([
			{ code: "custom", path: ["records", 0, "parentRecordId"] },
			{ code: "custom", path: ["records", 1, "parentRecordId"] },
		]);

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
		expect(graphIssues(navigation)).toEqual([
			{ code: "custom", path: ["navigation", 0, "parentNavigationId"] },
			{ code: "custom", path: ["navigation", 1, "parentNavigationId"] },
		]);
		records.records[0].parentRecordId = did(9001);
		expect(graphIssues(records)).toEqual([
			{ code: "custom", path: ["records", 0, "parentRecordId"] },
		]);
		navigation.navigation[0].parentNavigationId = did(9002);
		expect(graphIssues(navigation)).toEqual([
			{ code: "custom", path: ["navigation", 0, "parentNavigationId"] },
		]);
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
		const selection = fixtureValue(
			moduleComposition.selection,
			"module selection",
		);
		selection.workflowIds.push(parallel.id, convergent.id);
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
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection: existingInspection(),
		};
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(
			designConstructionIssues(appDesignContractSchema.parse(contract)),
		).toEqual([]);

		risk.choiceValues = ["routine", "urgent"];
		expect(messages(contract)).toContain("either inline values");
	});

	it("authors a source-grounded table by semantic identity and requires a real app use", () => {
		const contract = cloneContract(makeContract());
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "designed-project-lookup",
			tableId: ids.lookupRisk,
			valueColumnId: ids.lookupRiskValue,
			labelColumnId: ids.lookupRiskLabel,
		};
		contract.lookupTables.push({
			kind: "create",
			id: ids.lookupRisk,
			name: "Risk levels",
			tag: "risk_levels",
			purpose: "Reuse the same triage values wherever risk is shown.",
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
				summary: "The request establishes the routine and priority values.",
			},
		});
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(
			designConstructionIssues(appDesignContractSchema.parse(contract)),
		).toEqual([]);

		delete risk.choiceSource;
		risk.choiceValues = ["routine", "priority"];
		expect(messages(contract)).toContain("must be used");
	});

	it("refuses incomplete designed choices and references without stable identities", () => {
		const contract = cloneContract(makeContract());
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		const nameBased = {
			...contract,
			records: contract.records.map((record, recordIndex) =>
				recordIndex === 0
					? {
							...record,
							properties: record.properties.map((property) =>
								property.id === ids.factRisk
									? {
											...property,
											choiceSource: {
												kind: "existing-project-lookup",
												table: "Risk levels",
												valueColumn: "value",
												labelColumn: "label",
											},
										}
									: property,
							),
						}
					: record,
			),
		};
		expect(appDesignContractSchema.safeParse(nameBased).success).toBe(false);

		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection: existingInspection(),
		};
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
	});

	it("requires source-backed approval and expected revision for existing-table changes", () => {
		const contract = cloneContract(makeContract());
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection: existingInspection(),
		};
		contract.lookupTables.push({
			kind: "modify-existing",
			id: ids.lookupRisk,
			tableId: EXISTING_TABLE_ID,
			expectedTableRevision: lookupRevisionSchema.parse("7"),
			purpose: "Keep the shared labels aligned with the approved wording.",
			authorization: {
				kind: "explicit-user-approval",
				sourceRefs: [messageRef()],
				impactSummary:
					"The approved label edit affects every app using this Project table.",
			},
			operations: [
				{
					kind: "update-column",
					columnId: EXISTING_LABEL_COLUMN_ID,
					label: "Risk label",
				},
			],
		});
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);

		const raw = structuredClone(contract) as unknown as Record<string, unknown>;
		const changes = raw.lookupTables as Array<Record<string, unknown>>;
		delete changes[0]?.authorization;
		expect(appDesignContractSchema.safeParse(raw).success).toBe(false);
	});

	it("requires complete constructible existing-choice evidence and protects its columns", () => {
		const contract = cloneContract(makeContract());
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection: {
				...existingInspection(),
				distinctValueCount: 1,
				duplicateValueCount: 1,
			},
		};
		expect(constructionMessages(contract)).toContain(
			"at least two distinct real saved values",
		);

		risk.choiceSource.inspection = existingInspection();
		contract.lookupTables.push({
			kind: "modify-existing",
			id: ids.lookupRisk,
			tableId: EXISTING_TABLE_ID,
			expectedTableRevision: lookupRevisionSchema.parse("8"),
			purpose: "Apply the approved shared-table correction.",
			authorization: {
				kind: "direct-user-request",
				sourceRefs: [messageRef()],
				impactSummary: "This affects every app that uses the Project table.",
			},
			operations: [
				{ kind: "remove-column", columnId: EXISTING_VALUE_COLUMN_ID },
			],
		});
		expect(messages(contract)).toContain(
			"cannot remove a saved-value or label",
		);
		const changedTable = fixtureValue(
			contract.lookupTables[0],
			"changed table",
		);
		if (changedTable.kind !== "modify-existing")
			throw new Error("Expected existing table change.");
		changedTable.operations = [
			{
				kind: "update-column",
				columnId: EXISTING_LABEL_COLUMN_ID,
				label: "Display label",
			},
		];
		expect(constructionMessages(contract)).toContain(
			"same inspected table revision",
		);

		const impossibleDelete = structuredClone(contract) as unknown as Record<
			string,
			unknown
		>;
		const changes = impossibleDelete.lookupTables as Array<
			Record<string, unknown>
		>;
		changes[0] = { ...changes[0], operations: [{ kind: "remove-table" }] };
		expect(appDesignContractSchema.safeParse(impossibleDelete).success).toBe(
			false,
		);
	});

	it("treats an existing update-row as a complete row replacement", () => {
		const contract = cloneContract(makeContract());
		const source: ExistingLookupChoiceSource = {
			kind: "existing-project-lookup",
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection: existingInspection(),
		};
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		risk.choiceSource = source;
		contract.lookupTables.push({
			kind: "modify-existing",
			id: ids.lookupRisk,
			tableId: EXISTING_TABLE_ID,
			expectedTableRevision: lookupRevisionSchema.parse("7"),
			purpose: "Replace one shared lookup row exactly as requested.",
			authorization: {
				kind: "direct-user-request",
				sourceRefs: [messageRef()],
				impactSummary: "This replaces the complete shared row.",
			},
			operations: [
				{
					kind: "update-row",
					rowId: EXISTING_ROW_ONE_ID,
					cells: [
						{
							column: {
								kind: "existing-column",
								columnId: EXISTING_VALUE_COLUMN_ID,
							},
							value: "routine_updated",
						},
					],
					rowEvidence: {
						sourceRefs: [messageRef()],
						summary: "The request supplies the replacement saved value.",
					},
				},
			],
		});
		expect(
			existingLookupChoicePostChangeIssues(
				appDesignContractSchema.parse(contract),
				source,
				[
					{
						rowId: EXISTING_ROW_ONE_ID,
						value: "routine",
						label: "Routine",
					},
					{
						rowId: EXISTING_ROW_TWO_ID,
						value: "priority",
						label: "Priority",
					},
				],
				["choiceSource"],
			).map((issue) => issue.message),
		).toContain(
			"Every existing lookup row needs a nonblank label before this controlled choice can be built.",
		);
	});

	it("keeps a 5000-row existing-table choice attestation bounded", () => {
		const contract = cloneContract(makeContract());
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		const inspection = computeLookupChoiceProjectionAttestation({
			tableRevision: lookupRevisionSchema.parse("9"),
			tableName: "Every facility",
			valueColumnLabel: "Facility code",
			labelColumnLabel: "Facility name",
			rows: Array.from({ length: 5_000 }, (_, index) => ({
				rowId: `018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
				value: `facility_${index}`,
				label: `Facility ${index}`,
			})),
		});
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection,
		};
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
		expect(JSON.stringify(risk.choiceSource).length).toBeLessThan(750);
		expect(JSON.stringify(risk.choiceSource)).not.toContain('"rows"');

		const unbounded = structuredClone(contract) as unknown as {
			records: Array<{
				properties: Array<{ choiceSource?: { inspection?: unknown } }>;
			}>;
		};
		const rawSource = unbounded.records[0]?.properties.find(
			(property) => property.choiceSource !== undefined,
		)?.choiceSource;
		if (rawSource === undefined) throw new Error("expected raw choice source");
		rawSource.inspection = { ...inspection, rows: [] };
		expect(appDesignContractSchema.safeParse(unbounded).success).toBe(false);
	});

	it("keeps writes, readback, and list properties on the named record", () => {
		const write = cloneContract(makeContract());
		write.workflows[0]?.recordEffects[0]?.writes.push({
			propertyId: ids.factVisitSummary,
			value: "Wrong record",
			unanswered: "preserve",
		});
		expect(graphIssues(write)).toEqual([
			{
				code: "custom",
				path: ["workflows", 0, "recordEffects", 0, "writes", 3, "propertyId"],
			},
		]);

		const readback = cloneContract(makeContract());
		readback.workflows[0]?.readback[0]?.propertyIds.push(ids.factVisitSummary);
		expect(graphIssues(readback)).toEqual([
			{
				code: "custom",
				path: ["workflows", 0, "readback", 0, "propertyIds", 2],
			},
		]);

		const list = cloneContract(makeContract());
		list.lists[0]?.scanPropertyIds.push(ids.factVisitSummary);
		expect(graphIssues(list)).toEqual([
			{ code: "custom", path: ["lists", 0, "scanPropertyIds", 2] },
		]);
	});

	it("requires exact module-wide workflow coverage without requiring a WorkList", () => {
		const valid = cloneContract(makeContract());
		const module = valid.moduleCompositions[0];
		const selection = module?.selection;
		if (module === undefined || selection === undefined)
			throw new Error("fixture selection missing");
		module.selection = {
			workflowIds: selection.workflowIds,
			cases: "several",
			maximum: 12,
		};
		expect(appDesignContractSchema.safeParse(valid).success).toBe(true);

		const wrongContext = cloneContract(makeContract());
		if (wrongContext.moduleCompositions[0]?.selection === undefined)
			throw new Error("fixture selection missing");
		wrongContext.moduleCompositions[0].selection = {
			workflowIds: [ids.taskRegister],
			cases: "several",
			maximum: 12,
		};
		expect(messages(wrongContext)).toContain(
			"use the module's record as its selected context",
		);
		expect(messages(wrongContext)).toContain(
			"must exactly name every selected-record and close workflow",
		);

		const incomplete = cloneContract(makeContract());
		addPatientReviewWorkflow(incomplete);
		expect(messages(incomplete)).toContain(
			"must exactly name every selected-record and close workflow",
		);
		fixtureValue(incomplete.moduleCompositions[0], "patient module").selection =
			{
				workflowIds: [ids.taskVisit, ids.taskReview],
				cases: "one",
			};
		expect(appDesignContractSchema.safeParse(incomplete).success).toBe(true);

		const duplicate = cloneContract(makeContract());
		fixtureValue(duplicate.moduleCompositions[0], "patient module").selection =
			{
				workflowIds: [ids.taskVisit, ids.taskVisit],
				cases: "one",
			};
		expect(messages(duplicate)).toContain(
			"name each affected workflow exactly once",
		);

		const missing = cloneContract(makeContract());
		if (missing.moduleCompositions[0] === undefined)
			throw new Error("fixture module composition missing");
		delete missing.moduleCompositions[0].selection;
		expect(messages(missing)).toContain("module-wide selection setting");

		const listless = cloneContract(makeContract());
		const listlessModule = fixtureValue(
			listless.moduleCompositions[0],
			"patient module",
		);
		listlessModule.role = "form-host";
		listlessModule.listIds = [];
		listless.lists = [];
		listless.access = [];
		fixtureValue(listless.navigation[0], "patient navigation").listIds = [];
		expect(appDesignContractSchema.safeParse(listless).success).toBe(true);

		const nested = cloneContract(makeNestedMenuContract());
		const parent = fixtureValue(
			nested.moduleCompositions.find(
				(composition) => composition.id === ids.modulePatients,
			),
			"patient module",
		);
		const child = fixtureValue(
			nested.moduleCompositions.find(
				(composition) => composition.id === ids.moduleVisits,
			),
			"visit module",
		);
		parent.role = "queue-only";
		parent.workflowIds = [ids.taskRegister];
		child.workflowIds = [ids.taskRegister, ids.taskVisit];
		for (const form of nested.formCompositions) {
			form.moduleCompositionId = child.id;
		}
		delete child.selection;
		parent.selection = {
			workflowIds: [ids.taskVisit],
			cases: "several",
			maximum: 12,
		};
		expect(appDesignContractSchema.safeParse(nested).success).toBe(true);

		child.selection = {
			workflowIds: [ids.taskVisit],
			cases: "one",
		};
		expect(messages(nested)).toContain(
			"same-record child beneath a queue-only module",
		);
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

	it("keeps stored single choices readable but refuses incomplete new construction", () => {
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
		expect(graphIssues(actor)).toEqual([
			{ code: "custom", path: ["workflows", 0, "actorIds", 1] },
			{ code: "custom", path: ["formCompositions"] },
		]);

		const unsupported = cloneContract(makeContract());
		unsupported.externalRequirements.push({
			id: ids.externalSetup,
			name: "Generate audio",
			kind: "unsupported",
			description: "Nova would need to generate an audio prompt.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: false,
		});
		expect(graphIssues(unsupported)).toEqual([
			{
				code: "custom",
				path: ["externalRequirements", 0, "blocksConstruction"],
			},
		]);
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
		expect(graphIssues(blocked)).toEqual([
			{
				code: "custom",
				path: ["externalRequirements", 0, "blocksConstruction"],
			},
		]);

		blocked.openQuestions.push({
			id: ids.question,
			question: "Which existing audio prompt should this app use?",
			blocking: true,
			relatedElementIds: [ids.externalSetup],
		});
		const admitted = appDesignContractSchema.parse(blocked);
		expect(designConstructionIssues(admitted)).toEqual([
			expect.objectContaining({ path: ["openQuestions", 0] }),
		]);
		expect(designConstructionQuestionRequirements(admitted)).toEqual(
			blocked.openQuestions,
		);
		expect(() =>
			deriveBuildPlan({
				contract: admitted,
				revision: { id: "accepted", digest: "digest" },
			}),
		).toThrow("Accepted design is not constructible: openQuestions.0:");
	});

	it.each(["app", "decision", "assumption"] as const)(
		"keeps a blocking %s question in the user-input gate",
		(target) => {
			const contract = cloneContract(makeContract());
			const relatedElementIds =
				target === "app"
					? [contract.id]
					: target === "decision"
						? [ids.decision]
						: [ids.assumption];
			contract.openQuestions.push({
				id: ids.question,
				question: "Which agreed scope should the app implement?",
				blocking: true,
				relatedElementIds,
			});
			const admitted = appDesignContractSchema.parse(contract);
			expect(designConstructionIssues(admitted)).toEqual([
				expect.objectContaining({ path: ["openQuestions", 0] }),
			]);
			expect(designConstructionQuestionRequirements(admitted)).toEqual(
				contract.openQuestions,
			);
			admitted.openQuestions[0] = {
				...fixtureValue(admitted.openQuestions[0], "question"),
				blocking: false,
			};
			expect(
				designConstructionIssues(appDesignContractSchema.parse(admitted)),
			).toEqual([]);
		},
	);

	it("requires a blocking question to identify the app elements it can change", () => {
		const contract = cloneContract(makeContract());
		contract.openQuestions.push({
			id: ids.question,
			question: "Which scope should be built?",
			blocking: true,
			relatedElementIds: [],
		});
		expect(graphIssues(contract)).toEqual([
			{ code: "custom", path: ["openQuestions", 0, "relatedElementIds"] },
		]);
	});
});
