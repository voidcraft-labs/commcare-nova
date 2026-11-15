// A form check of a form whose menu reads the search, given no answers,
// reads each Search field's starting value, as the Search screen fills its
// prompts. A starting value over data the worker's device lacks (the primary
// place of a worker assigned nowhere) stops that search on a phone, and the
// check says so in the words Preview shows, as an input error rather than an
// evaluator fault.

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, simpleSearchInputDef } from "@/lib/domain";
import { sessionUser, term } from "@/lib/domain/expression";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { FormEvaluationInputError } from "@/lib/preview/engine/evaluateForm";
import { previewAsMe } from "@/lib/preview/engine/identity";
import { formsReadSearchFormAnswers } from "../evaluationContext";

const MODULE = testUuid("forms-read-search-answers-module");
const FORM = testUuid("forms-read-search-answers-form");

function searchStartingOn(key: "commcare_first_name" | "commcare_location_id") {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(
							testUuid("forms-read-search-answers-name"),
							"case_name",
							"Name",
						),
					],
					searchInputs: [
						simpleSearchInputDef(
							testUuid("forms-read-search-answers-input"),
							"patient_name",
							"Patient name",
							"text",
							"case_name",
							{ default: term(sessionUser(key)) },
						),
					],
				},
				caseSearchConfig: { formsReadSearch: true },
				forms: [
					{
						uuid: FORM,
						name: "Check in",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}

function answers(doc: ReturnType<typeof searchStartingOn>) {
	const identity = previewAsMe({ id: "worker", name: "Amina Diallo" }, doc);
	if (identity === null) throw new Error("The fixture has no worker.");
	return formsReadSearchFormAnswers(
		doc,
		{ formUuid: FORM },
		{
			identity,
			device: webAppsDevice(),
			cases: { rows: [], indices: [] },
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		},
	);
}

it("reads each Search field's starting value from the worker's session", () => {
	expect(answers(searchStartingOn("commcare_first_name"))).toEqual([
		{ name: "patient_name", value: "Amina" },
	]);
});

it("reports a starting value over a key the worker's device lacks as the refusal a phone shows", () => {
	const read = () => answers(searchStartingOn("commcare_location_id"));
	expect(read).toThrow(FormEvaluationInputError);
	expect(read).toThrow(/worker information you don't have/);
});
