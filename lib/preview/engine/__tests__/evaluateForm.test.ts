import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	evaluatePreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { simpleSearchInputDef } from "@/lib/domain";
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

it("honors the authored selection maximum for a form that closes several records", async () => {
	const doc = await createEvaluationApp({
		name: "Loans",
		case_type: "loan",
		selection: { kind: "multiple", maximum: 1 },
		forms: [
			{
				name: "Return",
				type: "close",
				fields: [{ kind: "text", id: "note", label: "Note" }],
			},
		],
	});
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Return",
	)?.uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	const context = {
		identity,
		cases: {
			rows: ["drill", "saw"].map((case_id) => ({
				case_id,
				app_id: doc.appId,
				case_type: "loan",
				owner_id: identity.ownerId,
				status: "open" as const,
				opened_on: null,
				modified_on: null,
				closed_on: null,
				case_name: case_id,
				external_id: null,
				parent_case_id: null,
				properties: {},
			})),
			indices: [],
		},
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
	};
	const allowed = await evaluateForm(
		doc,
		{ formUuid, answers: [], caseIds: ["drill"] },
		context,
	);
	expect(allowed.valid).toBe(true);
	expect(allowed.submission).toMatchObject({
		kind: "close",
		caseIds: ["drill"],
	});
	await expect(
		evaluateForm(
			doc,
			{ formUuid, answers: [], caseIds: ["drill", "saw"] },
			context,
		),
	).rejects.toBeInstanceOf(FormEvaluationInputError);
});

it("uses the running Search's date-range values in a no-matches registration", async () => {
	const inputUuid = testUuid("evaluation-dates");
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			inputUuid,
			"visit_date",
			"Dates",
			"date-range",
			"visit_date",
		),
	];
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "visit_date", label: "Date", data_type: "date" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListOnly: true,
				caseSearchConfig: { searchFirst: true },
				caseListConfig: config,
				forms: [
					{
						name: "Register",
						type: "registration",
						entry: { kind: "search-no-matches" },
						fields: [
							f({
								id: "name",
								kind: "text",
								label: "Name",
								default_value: {
									parts: [
										{ kind: "search-answer-ref", searchInputUuid: inputUuid },
									],
								},
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	expect(
		evaluatePreparedMutationCandidate(
			prepareMutationCandidate(doc, admitMutationBatch([])),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).ok,
	).toBe(true);
	const formUuid = Object.values(doc.forms)[0].uuid;
	const identity = previewAsMe({ id: "worker" }, doc);
	if (!identity) throw new Error("Evaluation fixture is incomplete.");
	const result = await evaluateForm(
		doc,
		{
			formUuid,
			answers: [],
			searchAnswers: [
				{ name: "visit_date:from", value: "2025-01-02" },
				{ name: "visit_date:to", value: "2025-03-04" },
			],
		},
		{
			identity,
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		},
	);
	expect(result.valid).toBe(true);
	expect(result.fields).toContainEqual(
		expect.objectContaining({
			path: "name",
			value: "__range__2025-01-02__2025-03-04",
		}),
	);
});
