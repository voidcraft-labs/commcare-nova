// components/builder/detail/formSettings/__tests__/ownCaseModel.test.ts
//
// The close form's **Close the case** row as pure state over real
// documents: each choice maps to the stored `closeCondition` and back,
// choosing a condition writes nothing until one is complete, and the
// completed condition is one `updateForm` the commit gate admits. Catches a
// seed committed before the author wrote anything, a second spelling of
// "every time", and a commit the gate would refuse.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Expression, Form, FormType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	closeChoiceOutcome,
	closeConditionCommitPatch,
	closeRowModel,
	nextOwnCaseLocalState,
} from "../ownCaseModel";

function fixture(
	type: FormType,
	closeCondition?: string,
): { readonly doc: BlueprintDoc; readonly form: Form } {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "outcome", label: proseText("Outcome") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "outcome", header: "Outcome" },
				]),
				forms: [
					{
						name: "Discharge",
						type,
						...(closeCondition !== undefined && { closeCondition }),
						fields: [
							f({
								kind: "single_select",
								id: "outcome",
								label: proseText("Outcome"),
								options: [
									{ value: "recovered", label: "Recovered" },
									{ value: "referred", label: "Referred" },
								],
							}),
						],
					},
				],
			},
		],
	});
	const form = doc.forms[doc.formOrder[doc.moduleOrder[0]][0]];
	return { doc, form };
}

/** A close form with nothing stored, and the condition an author
 *  completes on it: read from the same document storing it, so it names
 *  that document's question and choice. */
function awaitingFixture(): {
	readonly doc: BlueprintDoc;
	readonly form: Form;
	readonly condition: Expression;
} {
	const stored = fixture("close", "#form/outcome = 'recovered'");
	const condition = stored.form.closeCondition;
	if (condition === undefined)
		throw new Error("The fixture stores no close condition.");
	const doc = produce(stored.doc, (draft) => {
		delete draft.forms[stored.form.uuid].closeCondition;
	});
	return { doc, form: doc.forms[stored.form.uuid], condition };
}

function updateForm(form: Form, patch: Record<string, unknown>): Mutation {
	return { kind: "updateForm", uuid: form.uuid, patch } as Mutation;
}

function commit(doc: BlueprintDoc, mutation: Mutation) {
	return {
		verdict: mutationCommitVerdict(doc, [mutation], LOOKUP_CONTEXT_UNAVAILABLE),
		next: produce(doc, (draft) => {
			applyMutations(draft, [mutation]);
		}),
	};
}

describe("Close the case on a close form", () => {
	it("reads Every time when no condition is stored", () => {
		const { form } = fixture("close");
		expect(closeRowModel(form, null)).toEqual({
			choice: "every-time",
			condition: undefined,
			awaitingCondition: false,
		});
	});

	it("reads When a condition is true over a stored condition", () => {
		const { form } = fixture("close", "#form/outcome = 'recovered'");
		expect(closeRowModel(form, null)).toMatchObject({
			choice: "condition",
			awaitingCondition: false,
		});
		expect(closeRowModel(form, null)?.condition).toEqual(form.closeCondition);
	});

	it("has no row off a close form", () => {
		for (const type of ["followup", "registration", "survey"] as const) {
			expect(closeRowModel(fixture(type).form, null)).toBeUndefined();
		}
	});

	it("choosing a condition over nothing stored awaits it and writes nothing", () => {
		const { form } = fixture("close");
		const outcome = closeChoiceOutcome(form, "condition");
		expect(outcome).toEqual({ kind: "await-condition" });
		const local = nextOwnCaseLocalState(form.uuid, outcome);
		expect(closeRowModel(form, local)).toEqual({
			choice: "condition",
			condition: undefined,
			awaitingCondition: true,
		});
		// Another form's awaited condition says nothing about this one.
		const other = fixture("close").form;
		expect(closeRowModel(other, local)?.choice).toBe("every-time");
	});

	it("a completed condition is one updateForm the gate admits, and reads back as the condition", () => {
		const { doc, form, condition } = awaitingFixture();
		expect(closeChoiceOutcome(form, "condition")).toEqual({
			kind: "await-condition",
		});
		const { verdict, next } = commit(
			doc,
			updateForm(form, closeConditionCommitPatch(condition)),
		);
		expect(verdict.ok).toBe(true);
		const stored = next.forms[form.uuid];
		expect(stored.closeCondition).toEqual(condition);
		expect(closeRowModel(stored, null)).toMatchObject({ choice: "condition" });
		// The landed condition ends the awaited state.
		expect(closeChoiceOutcome(stored, "condition")).toEqual({
			kind: "unchanged",
		});
	});

	it("Every time over a stored condition clears it, as an update the gate admits", () => {
		const { doc, form } = fixture("close", "#form/outcome = 'recovered'");
		const outcome = closeChoiceOutcome(form, "every-time");
		expect(outcome).toEqual({
			kind: "commit",
			patch: { closeCondition: null },
		});
		if (outcome.kind !== "commit") throw new Error("Expected a commit.");
		const { verdict, next } = commit(doc, updateForm(form, outcome.patch));
		expect(verdict.ok).toBe(true);
		expect(next.forms[form.uuid].closeCondition).toBeUndefined();
		expect(closeRowModel(next.forms[form.uuid], null)?.choice).toBe(
			"every-time",
		);
	});

	it("Every time over nothing stored changes nothing", () => {
		const { form } = fixture("close");
		expect(closeChoiceOutcome(form, "every-time")).toEqual({
			kind: "unchanged",
		});
	});
});
