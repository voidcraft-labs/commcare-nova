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

describe("lean Design Contract graph", () => {
	it("accepts and round-trips a task-complete contract", () => {
		const contract = makeContract();
		expect(appDesignContractSchema.parse(contract)).toEqual(contract);
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
			timing: "before-construction",
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
			timing: "before-construction",
			blocksConstruction: true,
		});
		blocked.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		expect(messages(blocked)).toContain("blocking user question");

		blocked.openQuestions.push({
			id: ids.question,
			question: "Which existing audio prompt should this app use?",
			structuralImpact: "local",
			blocking: true,
			relatedElementIds: [ids.externalSetup],
		});
		expect(appDesignContractSchema.safeParse(blocked).success).toBe(true);
	});
});
