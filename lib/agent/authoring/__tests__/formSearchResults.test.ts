// A form check of a form that reads what its search found runs that search
// first, as the worker reaches it. A Search action its display condition
// hides is one the worker never runs, which no searchAnswers can change.

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { eq, literal, term } from "@/lib/domain/expression";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { evaluateForm } from "@/lib/preview/engine/evaluateForm";
import { previewAsMe } from "@/lib/preview/engine/identity";
import { formSearchContext } from "../evaluationContext";

const MODULE = testUuid("form-search-module");
const FORM = testUuid("form-search-form");

function searchedForm(shown: boolean) {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("form-search-name"), "case_name", "Name"),
					],
					searchInputs: [
						simpleSearchInputDef(
							testUuid("form-search-input"),
							"patient_name",
							"Patient name",
							"text",
							"case_name",
						),
					],
				},
				caseSearchConfig: {
					formsReadSearch: true,
					searchButtonDisplayCondition: eq(
						literal("a"),
						literal(shown ? "a" : "b"),
					),
				},
				forms: [
					{
						uuid: FORM,
						name: "Check in",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								id: "found",
								calculate: {
									kind: "count",
									via: { kind: "cases", source: "search-results", where: [] },
								},
							}),
						],
					},
				],
			},
		],
	});
}

function check(
	doc: ReturnType<typeof searchedForm>,
	searchAnswers?: { name: string; value: string }[],
) {
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (identity === null) throw new Error("The fixture has no worker.");
	return formSearchContext(
		doc,
		{
			formUuid: FORM,
			...(searchAnswers === undefined ? {} : { searchAnswers }),
		},
		{
			device: webAppsDevice(),
			appId: undefined,
			identity,
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
			store: undefined,
			restoreScope: undefined,
			scenario: false,
		},
	);
}

it.each([
	["pressing Search with its defaults", undefined],
	["supplying answers", [{ name: "patient_name", value: "Kofi" }]],
])(
	"names the hidden Search action, not missing answers, when %s",
	async (_case, answers) => {
		await expect(check(searchedForm(false), answers)).rejects.toThrow(
			/Search action is hidden for this worker/,
		);
	},
);

it("runs a shown search, which an unpublished workspace finds nothing for", async () => {
	await expect(check(searchedForm(true))).resolves.toEqual({
		searchAnswers: [],
		searchResults: { rows: [], totalMatches: 0 },
	});
});

it.each([
	["separate", "1/2/2024 to 3/9/2024"],
	["searchFirst", "__range__2024-01-02__2024-03-09"],
	["skipToResults", "1/2/2024 to 3/9/2024"],
] as const)(
	"keeps the %s Search answer in the evaluated form's calculation",
	async (entry, expected) => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "period", label: "Dates", data_type: "date" }],
				},
			],
			modules: [
				{
					uuid: MODULE,
					name: "Patients",
					caseType: "patient",
					caseListMenuItem: {},
					caseSearchConfig: {
						formsReadSearch: true,
						...(entry === "skipToResults" && { workflow: "skipToResults" }),
					},
					caseListRegistrationForm: { formUuid: FORM },
					caseListConfig: {
						columns: [
							plainColumn(testUuid("dates-column"), "case_name", "Name"),
						],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("dates-period"),
								"period",
								"Dates",
								"date-range",
								"period",
								{ default: term(literal("1/2/2024 to 3/9/2024")) },
							),
						],
					},
					forms: [
						{
							uuid: FORM,
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "hidden",
									id: "period_answer",
									calculate: "#search/period",
								}),
								...(entry === "separate"
									? []
									: [
											f({
												kind: "hidden",
												id: "matches",
												calculate: {
													kind: "count",
													via: {
														kind: "cases",
														source: "search-results",
														where: [],
													},
												},
											}),
										]),
							],
						},
					],
				},
			],
		});
		const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
		if (!identity) throw new Error("Missing test worker");
		const world = {
			identity,
			device: webAppsDevice(),
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		};
		const search = await check(doc);
		const form = await evaluateForm(
			doc,
			{ formUuid: FORM, answers: [] },
			{ ...world, ...search },
		);
		expect(form.fields).toContainEqual(
			expect.objectContaining({ path: "period_answer", value: expected }),
		);
		if (entry !== "separate")
			expect(form.fields).toContainEqual(
				expect.objectContaining({ path: "matches", value: "0" }),
			);
	},
);
