// components/builder/detail/formSettings/__tests__/ownCaseModel.test.ts
//
// A form's own-case rows as pure state over real documents: the close
// form's **Close the case**, and a registration's **Create the case** and
// **Close the case it creates**. Each choice maps to the stored
// `openCondition` / `closeCondition` and back, choosing a condition writes
// nothing until one is complete, and the completed condition is one
// `updateForm` the commit gate admits. Catches a seed committed before the
// author wrote anything, a second spelling of a stored choice (a
// registration's stored `true()` shown as a card), a commit to the wrong
// property, and a commit the gate would refuse.

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Expression, Form, FormType } from "@/lib/domain";
import { matchAll } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import {
	closeChoiceOutcome,
	closeConditionCommitPatch,
	closeRowModel,
	nextOwnCaseLocal,
	nextOwnCaseLocalState,
	type OwnCaseLocalState,
	type OwnCaseRowKey,
	ownCaseChoiceOutcome,
	ownCaseConditionCommitPatch,
	ownCaseRowModels,
	ownCaseRows,
	settleOwnCaseRow,
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

/** A registration of a patient with a name and an outcome question, and
 *  optionally stored open and close conditions (source text parsed in the
 *  form's own slots, so `true()` is the stored `match-all` node). */
function registrationFixture(conditions: {
	readonly openCondition?: string;
	readonly closeCondition?: string;
}): { readonly doc: BlueprintDoc; readonly form: Form } {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "outcome", label: proseText("Outcome") },
				],
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
						name: "Register",
						type: "registration",
						...conditions,
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
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

/** A registration with nothing stored, and a condition an author completes
 *  on it, read from the same document storing it in `property`. */
function awaitingRegistration(property: "openCondition" | "closeCondition"): {
	readonly doc: BlueprintDoc;
	readonly form: Form;
	readonly condition: Expression;
} {
	const stored = registrationFixture({
		[property]: "#form/outcome = 'recovered'",
	});
	const condition = stored.form[property];
	if (condition === undefined)
		throw new Error(`The fixture stores no ${property}.`);
	const doc = produce(stored.doc, (draft) => {
		delete draft.forms[stored.form.uuid][property];
	});
	return { doc, form: doc.forms[stored.form.uuid], condition };
}

function row(
	form: Form,
	key: OwnCaseRowKey,
	local: OwnCaseLocalState | null = null,
) {
	const found = ownCaseRowModels(form, local).find((r) => r.key === key);
	if (found === undefined) throw new Error(`The form has no ${key} row.`);
	return found;
}

describe("the rows each form type has", () => {
	it("a close form has Close the case, a registration Create the case then Close the case it creates, the rest none", () => {
		expect(ownCaseRows("close").map((r) => [r.label, r.slot])).toEqual([
			["Close the case", "form_close_condition"],
		]);
		expect(ownCaseRows("registration").map((r) => [r.label, r.slot])).toEqual([
			["Create the case", "form_open_condition"],
			["Close the case it creates", "form_close_condition"],
		]);
		expect(ownCaseRows("followup")).toEqual([]);
		expect(ownCaseRows("survey")).toEqual([]);
		expect(ownCaseRowModels(fixture("followup").form, null)).toEqual([]);
		expect(ownCaseRowModels(fixture("survey").form, null)).toEqual([]);
	});

	it("Close the case it creates offers Never, Every time and When a condition is true", () => {
		expect(ownCaseRows("registration")[1].choices.map((c) => c.label)).toEqual([
			"Never",
			"Every time",
			"When a condition is true",
		]);
	});
});

describe("Create the case on a registration", () => {
	it("reads Every time with no openCondition and the stored tree over one", () => {
		expect(row(registrationFixture({}).form, "create")).toMatchObject({
			choice: "every-time",
			condition: undefined,
			awaitingCondition: false,
		});
		const { form } = registrationFixture({
			openCondition: "#form/outcome = 'recovered'",
		});
		expect(row(form, "create")).toMatchObject({
			choice: "condition",
			condition: form.openCondition,
		});
	});

	it("Every time over a stored condition clears openCondition, as an update the gate admits", () => {
		const { doc, form } = registrationFixture({
			openCondition: "#form/outcome = 'recovered'",
		});
		const outcome = ownCaseChoiceOutcome(form, "create", "every-time");
		expect(outcome).toEqual({
			kind: "commit",
			patch: { openCondition: null },
		});
		if (outcome.kind !== "commit") throw new Error("Expected a commit.");
		const { verdict, next } = commit(doc, updateForm(form, outcome.patch));
		expect(verdict.ok).toBe(true);
		expect(next.forms[form.uuid].openCondition).toBeUndefined();
		expect(row(next.forms[form.uuid], "create").choice).toBe("every-time");
		expect(
			ownCaseChoiceOutcome(
				registrationFixture({}).form,
				"create",
				"every-time",
			),
		).toEqual({
			kind: "unchanged",
		});
	});

	it("choosing a condition awaits it, writes nothing, and opens only this row", () => {
		const { form } = registrationFixture({});
		const outcome = ownCaseChoiceOutcome(form, "create", "condition");
		expect(outcome).toEqual({ kind: "await-condition" });
		const local = nextOwnCaseLocal(null, form.uuid, "create", outcome);
		expect(row(form, "create", local)).toMatchObject({
			choice: "condition",
			condition: undefined,
			awaitingCondition: true,
		});
		expect(row(form, "close-created", local)).toMatchObject({
			choice: "never",
			awaitingCondition: false,
		});
		// Abandoning returns the row to its stored choice.
		const settled = settleOwnCaseRow(local, form.uuid, "create");
		expect(settled).toBeNull();
		expect(row(form, "create", settled).choice).toBe("every-time");
	});

	it("a completed condition is one updateForm of openCondition the gate admits", () => {
		const { doc, form, condition } = awaitingRegistration("openCondition");
		const patch = ownCaseConditionCommitPatch(form.type, "create", condition);
		expect(patch).toEqual({ openCondition: condition });
		const { verdict, next } = commit(doc, updateForm(form, patch));
		expect(verdict.ok).toBe(true);
		const stored = next.forms[form.uuid];
		expect(stored.openCondition).toEqual(condition);
		expect(stored.closeCondition).toBeUndefined();
		expect(row(stored, "create")).toMatchObject({
			choice: "condition",
			condition,
		});
		expect(ownCaseChoiceOutcome(stored, "create", "condition")).toEqual({
			kind: "unchanged",
		});
	});
});

describe("Close the case it creates on a registration", () => {
	it("reads Never with no closeCondition", () => {
		expect(row(registrationFixture({}).form, "close-created")).toEqual(
			expect.objectContaining({
				choice: "never",
				condition: undefined,
				awaitingCondition: false,
			}),
		);
	});

	it("a stored true() reads Every time, never as a card", () => {
		const { form } = registrationFixture({ closeCondition: "true()" });
		expect(form.closeCondition).toEqual(matchAll());
		expect(row(form, "close-created")).toMatchObject({
			choice: "every-time",
			condition: undefined,
			awaitingCondition: false,
		});
	});

	it("a stored condition reads When a condition is true with its tree", () => {
		const { form } = registrationFixture({
			closeCondition: "#form/outcome = 'referred'",
		});
		expect(row(form, "close-created")).toMatchObject({
			choice: "condition",
			condition: form.closeCondition,
		});
	});

	it("Every time stores true() as a tree, and the gate admits it", () => {
		const { doc, form } = registrationFixture({});
		const outcome = ownCaseChoiceOutcome(form, "close-created", "every-time");
		expect(outcome).toEqual({
			kind: "commit",
			patch: { closeCondition: matchAll() },
		});
		if (outcome.kind !== "commit") throw new Error("Expected a commit.");
		const { verdict, next } = commit(doc, updateForm(form, outcome.patch));
		expect(verdict.ok).toBe(true);
		expect(next.forms[form.uuid].closeCondition).toEqual(matchAll());
		expect(row(next.forms[form.uuid], "close-created").choice).toBe(
			"every-time",
		);
		expect(
			ownCaseChoiceOutcome(
				next.forms[form.uuid],
				"close-created",
				"every-time",
			),
		).toEqual({ kind: "unchanged" });
	});

	it("Never clears closeCondition from Every time and from a condition", () => {
		for (const closeCondition of ["true()", "#form/outcome = 'referred'"]) {
			const { doc, form } = registrationFixture({ closeCondition });
			const outcome = ownCaseChoiceOutcome(form, "close-created", "never");
			expect(outcome).toEqual({
				kind: "commit",
				patch: { closeCondition: null },
			});
			if (outcome.kind !== "commit") throw new Error("Expected a commit.");
			const { verdict, next } = commit(doc, updateForm(form, outcome.patch));
			expect(verdict.ok).toBe(true);
			expect(next.forms[form.uuid].closeCondition).toBeUndefined();
			expect(row(next.forms[form.uuid], "close-created").choice).toBe("never");
		}
		expect(
			ownCaseChoiceOutcome(
				registrationFixture({}).form,
				"close-created",
				"never",
			),
		).toEqual({ kind: "unchanged" });
	});

	it("Every time over a stored condition replaces it with true()", () => {
		const { form } = registrationFixture({
			closeCondition: "#form/outcome = 'referred'",
		});
		expect(ownCaseChoiceOutcome(form, "close-created", "every-time")).toEqual({
			kind: "commit",
			patch: { closeCondition: matchAll() },
		});
	});

	it("choosing a condition over Never or Every time awaits it and writes nothing", () => {
		for (const closeCondition of [undefined, "true()"]) {
			const { form } = registrationFixture(
				closeCondition === undefined ? {} : { closeCondition },
			);
			const outcome = ownCaseChoiceOutcome(form, "close-created", "condition");
			expect(outcome).toEqual({ kind: "await-condition" });
			const local = nextOwnCaseLocal(null, form.uuid, "close-created", outcome);
			expect(row(form, "close-created", local)).toMatchObject({
				choice: "condition",
				condition: undefined,
				awaitingCondition: true,
			});
			// Another form's awaited condition says nothing about this one.
			expect(
				row(registrationFixture({}).form, "close-created", local)
					.awaitingCondition,
			).toBe(false);
		}
	});

	it("a completed condition is one updateForm of closeCondition the gate admits", () => {
		const { doc, form, condition } = awaitingRegistration("closeCondition");
		const patch = ownCaseConditionCommitPatch(
			form.type,
			"close-created",
			condition,
		);
		expect(patch).toEqual({ closeCondition: condition });
		const { verdict, next } = commit(doc, updateForm(form, patch));
		expect(verdict.ok).toBe(true);
		const stored = next.forms[form.uuid];
		expect(stored.closeCondition).toEqual(condition);
		expect(stored.openCondition).toBeUndefined();
		expect(row(stored, "close-created")).toMatchObject({
			choice: "condition",
			condition,
		});
	});

	it("both rows can await at once, and settling one keeps the other", () => {
		const { form } = registrationFixture({});
		const both = nextOwnCaseLocal(
			nextOwnCaseLocal(null, form.uuid, "create", { kind: "await-condition" }),
			form.uuid,
			"close-created",
			{ kind: "await-condition" },
		);
		expect(row(form, "create", both).awaitingCondition).toBe(true);
		expect(row(form, "close-created", both).awaitingCondition).toBe(true);
		const one = settleOwnCaseRow(both, form.uuid, "create");
		expect(row(form, "create", one).awaitingCondition).toBe(false);
		expect(row(form, "close-created", one).awaitingCondition).toBe(true);
	});
});

describe("the generic rows on a close form", () => {
	it("read and commit as the close row does", () => {
		const { doc, form, condition } = awaitingFixture();
		expect(row(form, "close")).toMatchObject({ choice: "every-time" });
		expect(ownCaseChoiceOutcome(form, "close", "condition")).toEqual({
			kind: "await-condition",
		});
		const patch = ownCaseConditionCommitPatch(form.type, "close", condition);
		expect(patch).toEqual({ closeCondition: condition });
		const { verdict, next } = commit(doc, updateForm(form, patch));
		expect(verdict.ok).toBe(true);
		expect(row(next.forms[form.uuid], "close")).toMatchObject({
			choice: "condition",
			condition,
		});
	});

	it("a row the form type does not have is refused", () => {
		expect(() =>
			ownCaseChoiceOutcome(fixture("followup").form, "create", "condition"),
		).toThrow(/no "create" row/);
	});
});
