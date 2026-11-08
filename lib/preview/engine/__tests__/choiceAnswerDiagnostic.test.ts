import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { SetvalueRefusal } from "../answerCast";
import { buildEngineInput } from "../engineInput";
import { evaluateForm, FormEvaluationInputError } from "../evaluateForm";
import { evaluationScenarioCases } from "../evaluationScenario";
import { FormEngine } from "../formEngine";
import { previewAsMe } from "../identity";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const FORM = testUuid("choice-diagnostic-form");
const QUESTION = testUuid("choice-diagnostic-question");
const options = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
];
function fixture(kind: "single_select" | "multi_select") {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "stage", label: "Stage", data_type: kind, options },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: QUESTION,
								id: "stage",
								kind,
								label: "Stage",
								options,
								default_value: "#patient/stage",
							}),
						],
					},
				],
			},
		],
	});
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const input = buildEngineInput(doc, FORM, null);
	if (!input) throw new Error("Missing form input");
	return { doc, input };
}

it.each([
	{ kind: "single_select" as const, value: "retired", refused: true },
	{ kind: "single_select" as const, value: "yes", refused: false },
	{ kind: "single_select" as const, value: "", refused: false },
	{ kind: "multi_select" as const, value: "yes retired", refused: true },
	{
		kind: "multi_select" as const,
		value: "yes  no",
		stored: "yes no",
		refused: false,
	},
])(
	"diagnoses a retained $kind answer $value without rewriting it",
	({ kind, value, stored = value, refused }) => {
		const { input } = fixture(kind);
		const engine = new FormEngine(
			input,
			"patient",
			new Map([["patient", new Map([["stage", value]])]]),
		);
		expect(engine.getState("/data/stage").value).toBe(stored);
		expect(engine.choiceAnswerDiagnostic()).toEqual(
			refused ? { fieldUuid: QUESTION, path: "/data/stage", value } : undefined,
		);
		expect(engine.getState("/data/stage").value).toBe(stored);
		engine.setValue("/data/stage", "no");
		expect(engine.choiceAnswerDiagnostic()).toBeUndefined();
	},
);

it("finds the actual repeat row and forgets a removed row", () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: FORM,
						name: "Survey",
						type: "survey",
						fields: [
							f({
								id: "visits",
								kind: "repeat",
								repeat_mode: "user_controlled",
								children: [
									f({
										uuid: QUESTION,
										id: "answer",
										kind: "multi_select",
										options,
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	const input = buildEngineInput(doc, FORM, null);
	if (!input) throw new Error("Missing form input");
	const engine = new FormEngine(input);
	engine.addRepeat("/data/visits");
	engine.addRepeat("/data/visits");
	engine.setValue("/data/visits[1]/answer", "yes retired");
	expect(engine.choiceAnswerDiagnostic()).toEqual({
		fieldUuid: QUESTION,
		path: "/data/visits[1]/answer",
		value: "yes retired",
	});
	engine.removeRepeat("/data/visits", 1);
	expect(engine.choiceAnswerDiagnostic()).toBeUndefined();
});

it.each([webAppsDevice(), androidDevice()])(
	"form evaluations expose the author check on $platform before accepting replacement answers",
	async (device) => {
		const { doc } = fixture("single_select");
		const identity = previewAsMe({ id: "worker" }, doc);
		if (identity === null) throw new Error("Missing preview identity");
		const cases = evaluationScenarioCases(doc, identity.ownerId, {
			records: [
				{
					id: "old-record",
					caseType: "patient",
					name: "Old record",
					properties: { stage: "retired" },
				},
			],
		});
		const pending = evaluateForm(
			doc,
			{
				formUuid: FORM,
				caseIds: ["old-record"],
				answers: [{ path: "stage", value: "yes" }],
			},
			{
				identity,
				device,
				cases,
				lookup: {
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				},
			},
		);
		await expect(pending).rejects.toBeInstanceOf(FormEvaluationInputError);
		await expect(pending).rejects.toThrow(
			'Nova Preview check: stage holds "retired"',
		);
	},
);

it("refuses a multiple-choice preload with a leading empty selection at entry", () => {
	const { input } = fixture("multi_select");
	expect(
		() =>
			new FormEngine(
				input,
				"patient",
				new Map([["patient", new Map([["stage", " yes"]])]]),
			),
	).toThrow(SetvalueRefusal);
});
