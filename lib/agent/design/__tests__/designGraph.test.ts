/**
 * validateDesignGraph — clone-and-break coverage of every deterministic
 * graph rule over one complete, valid fixture contract.
 */

import { describe, expect, it } from "vitest";
import {
	appDesignContractSchema,
	effectiveLookupColumnEvidence,
	effectiveTaskInputEvidence,
} from "@/lib/agent/design/contract";
import { asDesignId } from "@/lib/agent/design/ids";
import { cloneContract, did, ids, imageRef, makeContract } from "./fixtures";

function messagesOf(
	result: ReturnType<typeof appDesignContractSchema.safeParse>,
) {
	if (result.success) return [];
	return result.error.issues.map((issue) => issue.message);
}

describe("validateDesignGraph", () => {
	it("accepts the complete fixture contract", () => {
		const result = appDesignContractSchema.safeParse(makeContract());
		expect(result.success, JSON.stringify(messagesOf(result), null, 2)).toBe(
			true,
		);
	});

	it("round-trips the fixture through parse unchanged", () => {
		const contract = makeContract();
		const parsed = appDesignContractSchema.parse(contract);
		expect(parsed).toEqual(contract);
	});

	it("inherits evidence at nested task-input and lookup-column boundaries", () => {
		const contract = cloneContract(makeContract());
		const task = contract.tasks[0];
		const input = task?.inputs[0];
		const table = contract.lookupIntents[0];
		const column = table?.columns[0];
		if (!task || !input || !table || !column) {
			throw new Error("fixture has nested evidence owners");
		}
		delete input.evidence;
		delete column.evidence;

		const parsed = appDesignContractSchema.parse(contract);
		const parsedTask = parsed.tasks[0];
		const parsedInput = parsedTask?.inputs[0];
		const parsedTable = parsed.lookupIntents[0];
		const parsedColumn = parsedTable?.columns[0];
		if (!parsedTask || !parsedInput || !parsedTable || !parsedColumn) {
			throw new Error("parsed fixture has nested evidence owners");
		}
		expect(effectiveTaskInputEvidence(parsedTask, parsedInput)).toEqual(
			parsedTask.evidence,
		);
		expect(effectiveLookupColumnEvidence(parsedTable, parsedColumn)).toEqual(
			parsedTable.evidence,
		);
	});

	it("rejects unknown keys, closed", () => {
		const contract = cloneContract(makeContract());
		(contract as Record<string, unknown>).surprise = true;
		expect(appDesignContractSchema.safeParse(contract).success).toBe(false);
	});

	it("rejects a duplicate design id across collections", () => {
		const contract = cloneContract(makeContract());
		const record = contract.records[0];
		if (!record) throw new Error("fixture has records");
		record.id = ids.actorChw;
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("already used by");
	});

	it("rejects an evidence reference that resolves to nothing", () => {
		const contract = cloneContract(makeContract());
		contract.actors[0]?.evidence.push(did(9999));
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("appears nowhere");
	});

	it("rejects evidence pointing at a non-claim", () => {
		const contract = cloneContract(makeContract());
		contract.records[0]?.evidence.push(ids.actorChw);
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("source claim");
	});

	it("rejects an explicit claim with only platform sources (schema level)", () => {
		const contract = cloneContract(makeContract());
		const claim = contract.sourceClaims[0];
		if (!claim) throw new Error("fixture has claims");
		claim.sourceRefs = [
			{
				kind: "platform-constraint",
				code: "PREVIEW_AUTOMATIONS_NOT_EXECUTED",
				sourceAnchor: "docs/plans/complex-app-plan.md#what-is-built",
			},
		];
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"message, attachment, or image source reference",
		);
	});

	it("accepts an explicit claim grounded only in an attached image", () => {
		const contract = cloneContract(makeContract());
		const claim = contract.sourceClaims[0];
		if (!claim) throw new Error("fixture has claims");
		claim.sourceRefs = [imageRef()];
		const result = appDesignContractSchema.safeParse(contract);
		expect(result.success, JSON.stringify(messagesOf(result), null, 2)).toBe(
			true,
		);
	});

	it("rejects an uncatalogued platform-constraint code", () => {
		const contract = cloneContract(makeContract());
		const claim = contract.sourceClaims[1];
		if (!claim) throw new Error("fixture has a platform claim");
		(claim.sourceRefs[0] as { code: string }).code = "NOT_A_REAL_CODE";
		expect(appDesignContractSchema.safeParse(contract).success).toBe(false);
	});

	it("rejects an unrepresented, undeferred explicit claim — and accepts it deferred", () => {
		const contract = cloneContract(makeContract());
		contract.sourceClaims.push({
			id: did(3),
			statement: "Supervisors export a monthly CSV report.",
			sourceRefs: [
				{
					kind: "message",
					threadId: "00000000-0000-4000-8000-999999999999",
					messageId: "m1",
					partIndex: 1,
				},
			],
			status: "explicit",
			confidence: 0.9,
		});
		const unowned = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(unowned).join("\n")).toContain("neither represented");

		contract.deferredRequirements.push({
			claimId: did(3),
			reason: "Reporting is out of the first release.",
		});
		expect(appDesignContractSchema.safeParse(contract).success).toBe(true);
	});

	it("rejects a selected option outside the decision", () => {
		const contract = cloneContract(makeContract());
		const decision = contract.decisions[0];
		if (!decision) throw new Error("fixture has a decision");
		decision.selectedOptionId = ids.taskRegister;
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"one of this decision's own options",
		);
	});

	it("rejects a declared writer task with no write intent", () => {
		const contract = cloneContract(makeContract());
		contract.facts
			.find((fact) => fact.id === ids.factVisitSummary)
			?.writerTaskIds.push(ids.taskRegister);
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"carries no write intent for it",
		);
	});

	it("rejects an actual writer missing from the fact's writer list", () => {
		const contract = cloneContract(makeContract());
		const fact = contract.facts.find((f) => f.id === ids.factName);
		if (!fact) throw new Error("fixture has factName");
		fact.writerTaskIds = [];
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"missing from its writer list",
		);
	});

	it("rejects an input whose fact declares a different answer source", () => {
		const contract = cloneContract(makeContract());
		const fact = contract.facts.find((f) => f.id === ids.factAge);
		if (!fact) throw new Error("fixture has factAge");
		fact.source = { kind: "answer", taskInputId: ids.inputName };
		const result = appDesignContractSchema.safeParse(contract);
		const text = messagesOf(result).join("\n");
		expect(text).toContain("persists to a different fact");
	});

	it("rejects a transition write that leaves the target record", () => {
		const contract = cloneContract(makeContract());
		const transition = contract.transitions.find(
			(t) => t.id === ids.transCreateVisit,
		);
		if (!transition) throw new Error("fixture has the visit transition");
		transition.writes[0] = {
			id: ids.writeVisitSummary,
			targetFactId: ids.factName,
			sourceDescription: "Wrong record entirely.",
		};
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"different record than the transition's target",
		);
		// The writer-coherence rule fires too (factName gained taskVisit as an
		// actual writer; factVisitSummary lost taskVisit) — both are real.
	});

	it("rejects a record parent cycle", () => {
		const contract = cloneContract(makeContract());
		const patient = contract.records.find((r) => r.id === ids.recPatient);
		if (!patient) throw new Error("fixture has the patient record");
		patient.parentRecordId = ids.recVisit;
		patient.relationshipMeaning = "cyclic";
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("loops back into itself");
	});

	it("rejects a navigation parent cycle", () => {
		const contract = cloneContract(makeContract());
		const nav = contract.navigation[0];
		if (!nav) throw new Error("fixture has navigation");
		nav.parentNavigationId = nav.id;
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("loops back into itself");
	});

	it("rejects a blocking question naming no affected intent", () => {
		const contract = cloneContract(makeContract());
		const question = contract.openQuestions[0];
		if (!question) throw new Error("fixture has a question");
		question.blocking = true;
		question.relatedIntentIds = [];
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("blocking open question");
	});

	it("rejects a scenario that exercises no task, transition, or read model", () => {
		const contract = cloneContract(makeContract());
		const scenario = contract.acceptanceScenarios[1];
		if (!scenario) throw new Error("fixture has two scenarios");
		scenario.relatedIntentIds = [ids.actorSupervisor];
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"must exercise at least one task",
		);
	});

	it("rejects a lookup-sourced fact naming a table that does not exist", () => {
		const contract = cloneContract(makeContract());
		const fact = contract.facts.find((f) => f.id === ids.factClinic);
		if (fact?.source.kind !== "lookup") throw new Error("fixture has a lookup");
		fact.source.lookupIntentId = did(9996);
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("appears nowhere");
	});

	it("rejects a lookup-sourced fact whose column is not a lookup column", () => {
		const contract = cloneContract(makeContract());
		const fact = contract.facts.find((f) => f.id === ids.factClinic);
		if (fact?.source.kind !== "lookup") throw new Error("fixture has a lookup");
		fact.source.columnIntentId = ids.lookupVillages;
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"must reference a lookup column intent",
		);
	});

	it("rejects a column that belongs to a different lookup table", () => {
		const contract = cloneContract(makeContract());
		contract.lookupIntents.push({
			id: did(9995),
			name: "Clinics",
			purpose: "Every clinic in the district.",
			columns: [
				{
					id: did(9994),
					name: "clinic_code",
					meaning: "The clinic's district code.",
					evidence: [],
				},
			],
			evidence: [],
		});
		const fact = contract.facts.find((f) => f.id === ids.factClinic);
		if (fact?.source.kind !== "lookup") throw new Error("fixture has a lookup");
		// A real column of a real table — just not the table the fact names.
		fact.source.columnIntentId = did(9994);
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain(
			"belongs to a different lookup table",
		);
	});

	it("rejects a duplicate nested lookup column id", () => {
		const contract = cloneContract(makeContract());
		const table = contract.lookupIntents[0];
		const column = table?.columns[0];
		if (!table || !column) throw new Error("fixture has a lookup table");
		column.id = ids.lookupColClinic;
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("already used by");
	});

	it("rejects lookup evidence pointing at a non-claim", () => {
		const contract = cloneContract(makeContract());
		const table = contract.lookupIntents[0];
		if (!table) throw new Error("fixture has a lookup table");
		table.evidence.push(ids.actorChw);
		const column = table.columns[0];
		if (column) column.evidence = [...(column.evidence ?? []), did(9993)];
		const messages = messagesOf(appDesignContractSchema.safeParse(contract));
		expect(messages.join("\n")).toContain("source claim");
		expect(messages.join("\n")).toContain("appears nowhere");
	});

	it("rejects an access target of a non-targetable kind", () => {
		const contract = cloneContract(makeContract());
		const policy = contract.accessPolicies[0];
		if (!policy) throw new Error("fixture has a policy");
		policy.targetIntentIds = [asDesignId(ids.decisionOptionA)];
		const result = appDesignContractSchema.safeParse(contract);
		expect(messagesOf(result).join("\n")).toContain("must reference a");
	});
});
