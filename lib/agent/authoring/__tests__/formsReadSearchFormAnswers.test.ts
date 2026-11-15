// A form check of a form whose menu reads the search, given no answers,
// reads each Search field's starting value, as the Search screen fills its
// prompts. A starting value over data the worker's device lacks (the primary
// place of a worker assigned nowhere) stops that search on a phone, and the
// check says so in the words Preview shows, as an input error rather than an
// evaluator fault.

import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	hiddenSearchInputDef,
	plainColumn,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, sessionUser, term } from "@/lib/domain/expression";
import { readFormSearchAnswers } from "@/lib/preview/caseListRegistration";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { WORKER_INFORMATION_REFUSAL } from "@/lib/preview/engine/dataRefusal";
import { FormEvaluationInputError } from "@/lib/preview/engine/evaluateForm";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { formsReadSearchFormAnswers } from "../evaluationContext";

const MODULE = testUuid("forms-read-search-answers-module");
const FORM = testUuid("forms-read-search-answers-form");

function searchStartingOn(key: "commcare_first_name" | "commcare_location_id") {
	return searchApp([
		simpleSearchInputDef(
			testUuid("forms-read-search-answers-input"),
			"patient_name",
			"Patient name",
			"text",
			"case_name",
			{ default: term(sessionUser(key)) },
		),
	]);
}

function searchApp(searchInputs: SearchInputDef[]) {
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
					searchInputs,
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

function workerOf(doc: ReturnType<typeof searchStartingOn>) {
	const identity = previewAsMe({ id: "worker", name: "Amina Diallo" }, doc);
	if (identity === null) throw new Error("The fixture has no worker.");
	return identity;
}

function answers(
	doc: ReturnType<typeof searchStartingOn>,
	searchAnswers?: { name: string; value: string }[],
) {
	const identity = workerOf(doc);
	return formsReadSearchFormAnswers(
		doc,
		{
			formUuid: FORM,
			...(searchAnswers === undefined ? {} : { searchAnswers }),
		},
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

// The Search screen opens before the form whatever answers the check
// supplies, and it reads each hidden value as it opens
// (`searchRunState.ts::openSearchRunState`, Core's query manager), so a hidden
// value over a key the worker's device lacks stops the search there, as it
// stops Preview's Search screen.
it("reports a hidden value over a key the worker's device lacks, with answers supplied or not", () => {
	const doc = searchApp([
		simpleSearchInputDef(
			testUuid("forms-read-search-answers-input"),
			"patient_name",
			"Patient name",
			"text",
			"case_name",
		),
		hiddenSearchInputDef(
			testUuid("forms-read-search-answers-hidden"),
			"place",
			"Place",
			term(sessionUser("commcare_location_id")),
		),
	]);
	for (const supplied of [
		undefined,
		[{ name: "patient_name", value: "Ada" }],
	]) {
		const read = () => answers(doc, supplied);
		expect(read).toThrow(FormEvaluationInputError);
		expect(read).toThrow(
			/This search doesn't open on a phone\. This search reads worker information you don't have/,
		);
	}
});

/* Preview's form screen reads the same moment: a form of the menu opened by a
 * form link, with no completed search behind it, which Web Apps rebuilds
 * through the menu's query step (`caseListRegistration.ts::readFormSearchAnswers`).
 * It opens the Search screen through the same `openSearchRunState`, so the
 * same app reads the same starting values in both, and is refused at the same
 * step in both. */
function previewFormRead(doc: ReturnType<typeof searchStartingOn>) {
	const module = doc.modules[MODULE];
	return readFormSearchAnswers({
		searchInputs: module?.caseListConfig?.searchInputs ?? [],
		admission: { kind: "not-applicable" },
		formsReadSearch: true,
		searchState: undefined,
		openedByLink: true,
		world: {
			session: previewSessionValues(workerOf(doc), webAppsDevice()),
			environment: {
				doc,
				moduleUuid: MODULE,
				sessionData: {},
				caseDatabase: { rows: [], indices: [] },
			},
		},
	});
}

it("reads the starting values Preview's form screen reads", () => {
	const doc = searchStartingOn("commcare_first_name");
	expect(previewFormRead(doc)).toEqual({
		kind: "read",
		value: new Map([["patient_name", "Amina"]]),
	});
	expect(answers(doc)).toEqual([{ name: "patient_name", value: "Amina" }]);
});

it.each([
	[
		"a hidden value",
		[
			simpleSearchInputDef(
				testUuid("forms-read-search-answers-input"),
				"patient_name",
				"Patient name",
				"text",
				"case_name",
			),
			hiddenSearchInputDef(
				testUuid("forms-read-search-answers-hidden"),
				"place",
				"Place",
				term(sessionUser("commcare_location_id")),
			),
		],
	],
	[
		"a required condition",
		[
			simpleSearchInputDef(
				testUuid("forms-read-search-answers-input"),
				"patient_name",
				"Patient name",
				"text",
				"case_name",
				{
					required: {
						when: eq(
							term(sessionUser("commcare_location_id")),
							literal("north"),
						),
						message: "Add a name",
					},
				},
			),
		],
	],
] as const)(
	"refuses %s over a key the worker's device lacks in Preview's form screen and in the form check alike",
	(_label, inputs) => {
		const doc = searchApp([...inputs]);
		const read = previewFormRead(doc);
		expect(read.kind).toBe("refused");
		if (read.kind === "refused")
			expect(read.refusal.reason).toEqual(WORKER_INFORMATION_REFUSAL);
		expect(() => answers(doc)).toThrow(
			/This search doesn't open on a phone\. This search reads worker information you don't have/,
		);
	},
);

it("reads a completed search's answers on Preview's form screen, opening no Search screen", () => {
	const doc = searchStartingOn("commcare_location_id");
	const read = readFormSearchAnswers({
		searchInputs: doc.modules[MODULE]?.caseListConfig?.searchInputs ?? [],
		admission: { kind: "not-applicable" },
		formsReadSearch: true,
		searchState: {
			kind: "completed",
			attempt: 1,
			submission: "search-1",
			answers: { patient_name: "Ada" },
			matchCount: 1,
		},
		openedByLink: false,
		world: {
			session: previewSessionValues(workerOf(doc), webAppsDevice()),
			environment: { doc, moduleUuid: MODULE, sessionData: {} },
		},
	});
	expect(read).toEqual({
		kind: "read",
		value: new Map([["patient_name", "Ada"]]),
	});
});
