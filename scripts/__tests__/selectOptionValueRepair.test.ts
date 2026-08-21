import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
import { planSelectOptionValueRepair } from "../lib/selectOptionValueRepair";

function option(value: string, label: string, n: number) {
	return { uuid: testUuid(`opt-${n}`), value, label: proseText(label) };
}

/** The text parts of a stored expression, joined; reference parts are
 *  identity nodes with no text of their own. */
function textParts(expression: unknown): string {
	const parts = (
		expression as { parts?: Array<{ kind: string; text?: string }> }
	)?.parts;
	return (parts ?? [])
		.map((part) => (part.kind === "text" ? (part.text ?? "") : ""))
		.join("");
}

describe("planSelectOptionValueRepair", () => {
	it("leaves a clean document alone", () => {
		const doc = toPersistableDoc(
			buildDoc({
				appName: "Clean",
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "answer",
										optionsSource: {
											kind: "inline",
											options: [option("yes", "Yes", 1), option("no", "No", 2)],
										},
									}),
								],
							},
						],
					},
				],
			}),
		);
		const plan = planSelectOptionValueRepair(doc);
		expect(plan.rewrites).toEqual([]);
		expect(plan.casePropertyRewrites).toEqual([]);
		expect(plan.targetDoc).toEqual(doc);
	});

	it("renames a field's values and its catalog's values together, rewrites the close condition, and lands gate-clean", () => {
		const fieldUuid = testUuid("status-field");
		const doc = toPersistableDoc(
			buildDoc({
				appName: "Program",
				caseTypes: [
					{
						name: "client",
						properties: [
							{
								name: "stage",
								label: "Stage",
								data_type: "single_select",
								options: [
									{ value: "in progress", label: "In progress" },
									{ value: "done", label: "Done" },
								],
							},
						],
					},
				],
				modules: [
					{
						name: "Clients",
						caseType: "client",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "name",
										caseWrite: { caseType: "client", property: "case_name" },
									}),
								],
							},
							{
								name: "Update",
								type: "close",
								closeCondition: { field: "stage", answer: "in progress" },
								fields: [
									f({
										kind: "single_select",
										id: "stage",
										uuid: fieldUuid,
										caseWrite: { caseType: "client", property: "stage" },
										optionsSource: {
											kind: "inline",
											options: [
												option("in progress", "In progress", 1),
												option("done", "Done", 2),
											],
										},
									}),
								],
							},
						],
					},
				],
			}),
		);
		expect(
			evaluateCommit({
				nextDoc: hydratePersistedBlueprint(doc),
				lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			}).ok,
		).toBe(false);

		const plan = planSelectOptionValueRepair(doc);
		expect(plan.rewrites.map((r) => [r.where.kind, r.from, r.to])).toEqual([
			["catalog-option", "in progress", "in_progress"],
			["field-option", "in progress", "in_progress"],
		]);
		expect(plan.closeConditionRewrites).toBe(1);
		expect(plan.casePropertyRewrites).toEqual([
			{
				caseType: "client",
				property: "stage",
				values: new Map([["in progress", "in_progress"]]),
			},
		]);
		expect(plan.literalRewrites).toEqual([]);
		expect(plan.literalReferences).toEqual([]);
		const updateForm = Object.values(plan.targetDoc.forms).find(
			(form) => form?.name === "Update",
		);
		expect(updateForm?.closeCondition?.answer).toBe("in_progress");
		// The source document is untouched.
		expect(
			Object.values(doc.forms).find((form) => form?.name === "Update")
				?.closeCondition?.answer,
		).toBe("in progress");
		const after = evaluateCommit({
			nextDoc: hydratePersistedBlueprint(plan.targetDoc),
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		});
		expect(after.ok ? [] : after.findings.map((e) => e.message)).toEqual([]);
	});

	it("steps past a sibling that already holds the slug and follows the rename into the expression comparing against it", () => {
		const doc = toPersistableDoc(
			buildDoc({
				appName: "Survey",
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "answer",
										optionsSource: {
											kind: "inline",
											options: [
												option("a b", "A b", 1),
												option("a_b", "A b again", 2),
												option("", "Not applicable", 3),
											],
										},
									}),
									f({
										kind: "hidden",
										id: "flag",
										calculate: "if(/data/answer = 'a b', 1, 0)",
									}),
								],
							},
						],
					},
				],
			}),
		);
		const plan = planSelectOptionValueRepair(doc);
		expect(plan.rewrites.map((r) => [r.from, r.to, r.problem])).toEqual([
			["a b", "a_b_2", "whitespace"],
			["", "not_applicable", "empty"],
		]);
		expect(plan.casePropertyRewrites).toEqual([]);
		expect(plan.literalRewrites).toEqual([
			{ carrier: "field flag", slot: "calculate", value: "a b", to: "a_b_2" },
		]);
		expect(plan.literalReferences).toEqual([]);
		const flag = Object.values(plan.targetDoc.fields).find(
			(field) => field?.id === "flag",
		);
		// The stored expression is parts-based: the reference is its own part
		// and the literal lives whole inside a text part.
		expect(
			textParts(flag?.kind === "hidden" ? flag.calculate : undefined),
		).toBe("if( = 'a_b_2', 1, 0)");
	});

	it("leaves a literal alone when the same old value was renamed two different ways", () => {
		const doc = toPersistableDoc(
			buildDoc({
				appName: "Survey",
				modules: [
					{
						name: "Visits",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [
									// Two unbound selects: each is its own value space, and
									// each has a different free slug for "a b".
									f({
										kind: "single_select",
										id: "first",
										optionsSource: {
											kind: "inline",
											options: [
												option("a b", "A b", 1),
												option("a_b", "Taken", 2),
											],
										},
									}),
									f({
										kind: "single_select",
										id: "second",
										optionsSource: {
											kind: "inline",
											options: [
												option("a b", "A b", 3),
												option("other", "Other", 4),
											],
										},
									}),
									f({
										kind: "hidden",
										id: "flag",
										calculate: "if(/data/first = 'a b', 1, 0)",
									}),
								],
							},
						],
					},
				],
			}),
		);
		const plan = planSelectOptionValueRepair(doc);
		expect(plan.rewrites.map((r) => r.to)).toEqual(["a_b_2", "a_b"]);
		expect(plan.literalRewrites).toEqual([]);
		expect(plan.literalReferences).toEqual([
			{ carrier: "field flag", slot: "calculate", value: "a b" },
		]);
		const flag = Object.values(plan.targetDoc.fields).find(
			(field) => field?.id === "flag",
		);
		// The stored expression is parts-based: the reference is its own part
		// and the literal lives whole inside a text part.
		expect(
			textParts(flag?.kind === "hidden" ? flag.calculate : undefined),
		).toBe("if( = 'a b', 1, 0)");
	});
});
