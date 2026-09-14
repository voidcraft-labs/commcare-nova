import { expect, it } from "vitest";
import { evaluateForm, FormEvaluationInputError } from "../evaluateForm";
import { previewAsMe } from "../identity";
import { previewLookupData } from "../lookupEvaluation";
import { createEvaluationApp } from "./evaluationFixture";

it("evaluates worker-only validation, branch state and a proposed named record without changing the document", async () => {
	const doc = await createEvaluationApp({
		name: "People",
		case_type: "person",
		forms: [
			{
				name: "Register",
				type: "registration",
				recordName: "#form/name",
				fields: [
					{
						kind: "text",
						id: "name",
						label: "Name",
						required: true,
						validate: {
							expr: "regex(#form/name, '^[A-Z][a-z]+$')",
							msg: "Use a capitalized name",
						},
					},
					{ kind: "int", id: "age", label: "Age", required: true },
					{
						kind: "text",
						id: "guardian",
						label: "Guardian",
						relevant: "#form/age < 18",
						required: true,
						caseWrite: { caseType: "person", property: "guardian" },
					},
				],
			},
		],
	});
	const before = structuredClone(doc);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Register",
	)?.uuid;
	const identity = previewAsMe({ id: "member", name: "Member" }, doc);
	if (!identity || !formUuid)
		throw new Error("Evaluation fixture is incomplete.");
	const context = {
		identity,
		cases: { rows: [], indices: [] },
		lookup: previewLookupData({
			projectRevision: "0",
			definitions: [],
			rowsByTable: new Map(),
		}),
	};
	const invalid = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [
				{ path: "name", value: "ada" },
				{ path: "age", value: "17" },
			],
		},
		context,
	);
	expect(invalid.valid).toBe(false);
	expect(invalid).not.toHaveProperty("submission");
	expect(invalid.fields).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: "name",
				valid: false,
				error: "Use a capitalized name",
			}),
			expect.objectContaining({
				path: "guardian",
				visible: true,
				required: true,
				valid: false,
			}),
		]),
	);
	const adult = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [
				{ path: "name", value: "Ada" },
				{ path: "age", value: "18" },
			],
		},
		context,
	);
	expect(adult.valid).toBe(true);
	expect(adult.fields).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ path: "guardian", visible: false }),
		]),
	);
	expect(adult.submission).toMatchObject({
		kind: "registration",
		primary: { caseName: "Ada" },
	});
	expect(doc).toEqual(before);
	await expect(
		evaluateForm(
			doc,
			{ formUuid, answers: [{ path: "missing", value: "x" }] },
			context,
		),
	).rejects.toBeInstanceOf(FormEvaluationInputError);
});

it("evaluates separate repeat answers and refuses writes to a calculated value", async () => {
	const doc = await createEvaluationApp({
		name: "Visits",
		forms: [
			{
				name: "Checklist",
				type: "survey",
				fields: [
					{
						kind: "repeat",
						id: "visits",
						label: "Visits",
						repeat: { mode: "user_controlled" },
					},
					{
						kind: "int",
						id: "rating",
						parentUuid: "visits",
						label: "Rating",
						required: true,
						validate: { expr: ". >= 1 and . <= 5", msg: "Use 1 through 5" },
					},
					{
						kind: "hidden",
						id: "total",
						calculate: "sum(#form/visits/rating)",
					},
				],
			},
		],
	});
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Checklist",
	)?.uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const context = {
		identity,
		cases: { rows: [], indices: [] },
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
	};
	const result = await evaluateForm(
		doc,
		{
			formUuid,
			repeats: [{ path: "visits", count: 2 }],
			answers: [
				{ path: "visits[0]/rating", value: "2" },
				{ path: "visits[1]/rating", value: "4" },
			],
		},
		context,
	);
	expect(result.valid).toBe(true);
	expect(result.fields).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ path: "visits[0]/rating", value: "2" }),
			expect.objectContaining({ path: "visits[1]/rating", value: "4" }),
			expect.objectContaining({ path: "total", value: "6" }),
		]),
	);
	await expect(
		evaluateForm(
			doc,
			{ formUuid, answers: [{ path: "total", value: "99" }] },
			context,
		),
	).rejects.toBeInstanceOf(FormEvaluationInputError);
});
