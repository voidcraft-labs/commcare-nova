/**
 * The direct-write lowering rule — one table over the §13.11 conditions, plus
 * the property derivation.
 */

import { describe, expect, it } from "vitest";
import { did, ids, makeContract } from "@/lib/agent/design/__tests__/fixtures";
import type {
	FactDefinition,
	Task,
	TaskInput,
} from "@/lib/agent/design/contract";
import {
	directCaseWritePlan,
	type FormLoweringContext,
} from "@/lib/agent/design/directCaseWrite";

const contract = makeContract();

function task(): Task {
	const found = contract.tasks.find((entry) => entry.id === ids.taskRegister);
	if (found === undefined) throw new Error("fixture task missing");
	return structuredClone(found);
}

function input(): TaskInput {
	const found = task().inputs.find((entry) => entry.id === ids.inputName);
	if (found === undefined) throw new Error("fixture input missing");
	return found;
}

function fact(): FactDefinition {
	const found = contract.facts.find((entry) => entry.id === ids.factName);
	if (found === undefined) throw new Error("fixture fact missing");
	return structuredClone(found);
}

const OPEN_CONTEXT: FormLoweringContext = {
	caseType: "patient",
	directSlotTaken: false,
	repeatScopeCompatible: true,
};

function plan(overrides: {
	input?: TaskInput;
	fact?: FactDefinition;
	task?: Task;
	formContext?: Partial<FormLoweringContext>;
}) {
	return directCaseWritePlan({
		input: overrides.input ?? input(),
		fact: overrides.fact ?? fact(),
		task: overrides.task ?? task(),
		formContext: { ...OPEN_CONTEXT, ...overrides.formContext },
	});
}

describe("directCaseWritePlan", () => {
	it("plans a direct write when the fact IS the answer", () => {
		expect(plan({})).toEqual({ kind: "direct", property: "patient_name" });
	});

	const refusals: {
		name: string;
		build: () => ReturnType<typeof plan>;
	}[] = [
		{
			name: "the fact is derived by a rule, not answered",
			build: () => {
				const derived = fact();
				derived.source = { kind: "derived", ruleId: ids.ruleRisk };
				return plan({ fact: derived });
			},
		},
		{
			name: "the fact reads reference data",
			build: () => {
				const lookup = fact();
				lookup.source = {
					kind: "lookup",
					lookupIntentId: ids.lookupVillages,
					columnIntentId: ids.lookupColClinic,
				};
				return plan({ fact: lookup });
			},
		},
		{
			name: "the fact reads session context",
			build: () => {
				const session = fact();
				session.source = { kind: "session", value: "current worker" };
				return plan({ fact: session });
			},
		},
		{
			name: "the fact is a fixed constant",
			build: () => {
				const constant = fact();
				constant.source = { kind: "constant", value: "clinic-a" };
				return plan({ fact: constant });
			},
		},
		{
			name: "the fact arrives from outside the app",
			build: () => {
				const external = fact();
				external.source = { kind: "external" };
				return plan({ fact: external });
			},
		},
		{
			name: "the answer that sources the fact is a DIFFERENT input",
			build: () => {
				const other = fact();
				other.source = { kind: "answer", taskInputId: ids.inputAge };
				return plan({ fact: other });
			},
		},
		{
			name: "the input persists to another fact",
			build: () => {
				const ephemeral = { ...input(), factId: ids.factAge };
				return plan({ input: ephemeral });
			},
		},
		{
			name: "the input is ephemeral and persists to nothing",
			build: () => {
				const { factId: _factId, ...rest } = input();
				return plan({ input: rest as TaskInput });
			},
		},
		{
			name: "no write intent and no writer list names this task",
			build: () => {
				const orphan = task();
				orphan.writes = [];
				const unwritten = fact();
				unwritten.writerTaskIds = [];
				return plan({ task: orphan, fact: unwritten });
			},
		},
		{
			name: "the value is an attachment",
			build: () => {
				const photo = fact();
				photo.dataShape = "attachment";
				return plan({ fact: photo });
			},
		},
		{
			name: "the shape was never settled",
			build: () => {
				const vague = fact();
				vague.dataShape = "unknown";
				return plan({ fact: vague });
			},
		},
		{
			name: "the repeat scope does not match",
			build: () => plan({ formContext: { repeatScopeCompatible: false } }),
		},
		{
			name: "the field's one direct-write slot is already claimed",
			build: () => plan({ formContext: { directSlotTaken: true } }),
		},
		{
			name: "the fact name has no case-property spelling",
			build: () => {
				const unnameable = fact();
				unnameable.name = "!!!";
				return plan({ fact: unnameable });
			},
		},
	];

	for (const refusal of refusals) {
		it(`refuses a direct write when ${refusal.name}`, () => {
			expect(refusal.build()).toBeNull();
		});
	}

	it("accepts every storable scalar shape", () => {
		for (const shape of [
			"text",
			"integer",
			"decimal",
			"boolean",
			"date",
			"datetime",
			"single-choice",
			"multiple-choice",
			"location",
		] as const) {
			const typed = fact();
			typed.dataShape = shape;
			expect(plan({ fact: typed })).toEqual({
				kind: "direct",
				property: "patient_name",
			});
		}
	});

	it("accepts a transition-borne write through the contract's writer list", () => {
		/* The visit summary's write intent lives on the transition the task
		 * triggers, not on the task itself — the graph validator proves the
		 * writer list covers both, so the rule reads it rather than demanding a
		 * direct write intent. */
		const visitTask = contract.tasks.find((t) => t.id === ids.taskVisit);
		const summaryInput = visitTask?.inputs.find(
			(entry) => entry.id === ids.inputSummary,
		);
		const summaryFact = contract.facts.find(
			(entry) => entry.id === ids.factVisitSummary,
		);
		if (!visitTask || !summaryInput || !summaryFact) {
			throw new Error("fixture visit objects missing");
		}
		expect(visitTask.writes).toEqual([]);
		expect(
			directCaseWritePlan({
				input: summaryInput,
				fact: summaryFact,
				task: visitTask,
				formContext: { ...OPEN_CONTEXT, caseType: "visit" },
			}),
		).toEqual({ kind: "direct", property: "visit_summary" });
	});

	it("slugifies the fact name into the case property", () => {
		const named = fact();
		named.name = "Date of  Birth!";
		named.id = did(999);
		named.source = { kind: "answer", taskInputId: ids.inputName };
		const pointed = { ...input(), factId: named.id };
		const writer = task();
		named.writerTaskIds = [writer.id];
		expect(plan({ input: pointed, fact: named, task: writer })).toEqual({
			kind: "direct",
			property: "date_of_birth",
		});
	});
});
