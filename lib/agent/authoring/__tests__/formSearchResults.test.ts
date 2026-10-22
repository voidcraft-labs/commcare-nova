// A form check of a form that reads what its search found runs that search
// first, as the worker reaches it. A Search action its display condition
// hides is one the worker never runs, which no searchAnswers can change.

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { eq, literal } from "@/lib/domain/expression";
import { previewAsMe } from "@/lib/preview/engine/identity";
import { formSearchResults } from "../evaluationContext";

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
					searchFirst: true,
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
	return formSearchResults(
		doc,
		{
			formUuid: FORM,
			...(searchAnswers === undefined ? {} : { searchAnswers }),
		},
		{
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
		rows: [],
		totalMatches: 0,
	});
});
