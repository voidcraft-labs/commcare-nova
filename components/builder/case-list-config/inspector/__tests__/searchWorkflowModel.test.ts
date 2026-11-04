/**
 * Contract: When this menu opens commits exactly each choice's patch, and
 * withholds a choice for exactly one reason: a platform the app runs on
 * that can't run it (that platform's picker line), else the gate's sentence
 * for the choice's own batch. The gate reasons are read from the production
 * commit verdict over a real document, so a planner that stopped producing
 * the refused batch, or a model that dropped the gate's sentence, fails here.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { availableLookupContext } from "@/lib/__tests__/lookupFixtures";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { Mutation } from "@/lib/doc/types";
import { offeredChoiceRefusal } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	type Platform,
	platformPickerLine,
	platformRefusal,
} from "@/lib/domain/platforms";
import {
	formsReadSearchMutations,
	formsReadSearchOffered,
	formsReadSearchRefusal,
	SEARCH_WORKFLOW_CHOICES,
	type SearchWorkflowChoice,
	searchWorkflowCanvasLines,
	searchWorkflowChoiceRefusal,
	searchWorkflowMutations,
	searchWorkflowNoteFeature,
	searchWorkflowPatch,
} from "../searchWorkflowModel";

const MODULE = testUuid("workflow-model-module");
const VISIT = testUuid("workflow-model-visit");
const REGISTER = testUuid("workflow-model-register");
const NAME_INPUT = testUuid("workflow-model-name-input");

const LOOKUPS = availableLookupContext([]);

const BOTH: readonly Platform[] = ["web-apps", "android"];
const WEB_APPS: readonly Platform[] = ["web-apps"];
const ANDROID: readonly Platform[] = ["android"];

function choice(workflow: SearchWorkflowChoice["workflow"]) {
	const found = SEARCH_WORKFLOW_CHOICES.find(
		(candidate) => candidate.workflow === workflow,
	);
	if (found === undefined) throw new Error(`No choice ${workflow}.`);
	return found;
}

/** A searchable patient list with a follow-up form and, when asked, a
 *  registration form on its menu, which keeps its forms from reading the
 *  search (`FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE`). It runs only in
 *  Web Apps unless told otherwise, where forms can read the search. */
function searchableApp(options: {
	readonly registration: boolean;
	readonly formsReadSearch?: true;
	readonly runsOnlyOn?: Platform;
}): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(NAME_INPUT, "name", "Name", "text", "case_name"),
	];
	return buildDoc({
		appName: "Workflow model",
		appSettings: {
			...NEW_APP_SETTINGS,
			runsOnlyOn: options.runsOnlyOn ?? "web-apps",
		},
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig:
					options.formsReadSearch === undefined
						? {}
						: { formsReadSearch: true },
				forms: [
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
					...(options.registration
						? [
								{
									uuid: REGISTER,
									name: "Register",
									type: "registration" as const,
									fields: [
										f({
											kind: "text",
											id: "case_name",
											label: "Name",
											caseWrite: {
												caseType: "patient",
												property: "case_name",
											},
										}),
									],
								},
							]
						: []),
				],
			},
		],
	});
}

/** The gate's sentence for a batch, as the builder's review gives it. */
function gateSentence(
	doc: BlueprintDoc,
	batch: readonly Mutation[],
): string | undefined {
	const verdict = mutationCommitVerdict(doc, [...batch], LOOKUPS);
	return verdict.ok ? undefined : offeredChoiceRefusal(verdict.findings);
}

describe("each choice writes its patch", () => {
	it("Search first clears the stored workflow", () => {
		expect(searchWorkflowPatch("searchFirst")).toEqual({ workflow: null });
	});

	it("Results first stores skipToResults", () => {
		expect(searchWorkflowPatch("skipToResults")).toEqual({
			workflow: "skipToResults",
		});
	});

	it("Case list first clears Forms read the search in the same patch", () => {
		expect(searchWorkflowPatch("listFirst")).toEqual({
			workflow: "listFirst",
			formsReadSearch: null,
		});
		expect(searchWorkflowMutations(MODULE, "listFirst")).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { workflow: "listFirst", formsReadSearch: null },
			},
		]);
	});

	it("the switch writes formsReadSearch true on and null off", () => {
		const off = searchableApp({ registration: false });
		expect(formsReadSearchMutations(off, MODULE, true)).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { formsReadSearch: true },
			},
		]);
		const on = searchableApp({ registration: false, formsReadSearch: true });
		expect(formsReadSearchMutations(on, MODULE, false)).toEqual([
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {},
				caseSearchConfigPatch: { formsReadSearch: null },
			},
		]);
		expect(formsReadSearchMutations(on, MODULE, true)).toEqual([]);
	});

	it("each patch the model writes is one the gate admits on a menu that can take it", () => {
		const reading = searchableApp({
			registration: false,
			formsReadSearch: true,
		});
		expect(
			mutationCommitVerdict(
				reading,
				searchWorkflowMutations(MODULE, "skipToResults"),
				LOOKUPS,
			).ok,
		).toBe(true);
		const phone = searchableApp({ registration: true, runsOnlyOn: "android" });
		for (const workflow of ["skipToResults", "listFirst"] as const)
			expect(
				mutationCommitVerdict(
					phone,
					searchWorkflowMutations(MODULE, workflow),
					LOOKUPS,
				).ok,
			).toBe(true);
	});

	it("offers the switch under Search first and Results first only", () => {
		expect(formsReadSearchOffered("searchFirst")).toBe(true);
		expect(formsReadSearchOffered("skipToResults")).toBe(true);
		expect(formsReadSearchOffered("listFirst")).toBe(false);
	});

	it("states Search first's and Results first's notes, and none for Case list first", () => {
		expect(searchWorkflowNoteFeature("searchFirst")).toBe("search-first");
		expect(searchWorkflowNoteFeature("skipToResults")).toBe("skip-to-results");
		expect(searchWorkflowNoteFeature("listFirst")).toBeUndefined();
	});
});

describe("each disabled reason comes from the platform or the gate", () => {
	it("Case list first takes the list-first picker line where Web Apps is declared", () => {
		for (const platforms of [BOTH, WEB_APPS]) {
			const refusal = platformRefusal("list-first", platforms);
			if (refusal === undefined) throw new Error("list-first runs here.");
			expect(
				searchWorkflowChoiceRefusal(
					choice("listFirst"),
					"searchFirst",
					platforms,
					"a gate sentence",
				),
			).toBe(platformPickerLine(refusal));
		}
		expect(
			searchWorkflowChoiceRefusal(
				choice("listFirst"),
				"searchFirst",
				ANDROID,
				undefined,
			),
		).toBeUndefined();
	});

	it("Search first and Results first are offered on every declaration", () => {
		for (const platforms of [BOTH, WEB_APPS, ANDROID])
			for (const workflow of ["searchFirst", "skipToResults"] as const)
				expect(
					searchWorkflowChoiceRefusal(
						choice(workflow),
						"listFirst",
						platforms,
						undefined,
					),
				).toBeUndefined();
	});

	it("a stored choice shows as it is", () => {
		expect(
			searchWorkflowChoiceRefusal(
				choice("listFirst"),
				"listFirst",
				WEB_APPS,
				"a gate sentence",
			),
		).toBeUndefined();
	});

	it("a choice the platforms run takes the gate's sentence for its batch", () => {
		expect(
			searchWorkflowChoiceRefusal(
				choice("skipToResults"),
				"searchFirst",
				BOTH,
				"a gate sentence",
			),
		).toBe("a gate sentence");
	});

	it("the switch takes the forms-read-search picker line where Android is declared", () => {
		for (const platforms of [BOTH, ANDROID]) {
			const refusal = platformRefusal("forms-read-search", platforms);
			if (refusal === undefined)
				throw new Error("forms-read-search runs here.");
			expect(formsReadSearchRefusal(false, platforms, undefined)).toBe(
				platformPickerLine(refusal),
			);
		}
	});

	it("the switch takes the gate's finding where a registration form keeps it off", () => {
		const doc = searchableApp({ registration: true });
		const sentence = gateSentence(
			doc,
			formsReadSearchMutations(doc, MODULE, true),
		);
		expect(sentence).toBeDefined();
		expect(formsReadSearchRefusal(false, WEB_APPS, sentence)).toBe(sentence);
		const admitted = searchableApp({ registration: false });
		expect(
			gateSentence(admitted, formsReadSearchMutations(admitted, MODULE, true)),
		).toBeUndefined();
	});

	it("turning the switch off is withheld by the gate alone", () => {
		expect(formsReadSearchRefusal(true, ANDROID, undefined)).toBeUndefined();
		expect(formsReadSearchRefusal(true, ANDROID, "a gate sentence")).toBe(
			"a gate sentence",
		);
	});
});

describe("the Search canvas says what the menu does with its search", () => {
	it("names the Search screen that holds only its button under Search first", () => {
		expect(
			searchWorkflowCanvasLines({
				workflow: "searchFirst",
				hasVisibleField: false,
				hasButtonCondition: false,
				formsReadSearch: false,
			}),
		).toEqual([
			"Workers see a Search screen with only its Search button. Choose Results first to show the cases as the menu opens.",
		]);
	});

	it("says the menu opens on the cases under Results first", () => {
		expect(
			searchWorkflowCanvasLines({
				workflow: "skipToResults",
				hasVisibleField: false,
				hasButtonCondition: false,
				formsReadSearch: false,
			}),
		).toEqual([
			"There's nothing to fill in. The menu opens on the cases the search finds, and Cases available decides what workers see.",
		]);
	});

	it("says what a saved Search button condition does while the forms don't read the search", () => {
		expect(
			searchWorkflowCanvasLines({
				workflow: "skipToResults",
				hasVisibleField: true,
				hasButtonCondition: true,
				formsReadSearch: false,
			}),
		).toEqual([
			"While this condition is false, the menu opens on its case list.",
		]);
		expect(
			searchWorkflowCanvasLines({
				workflow: "searchFirst",
				hasVisibleField: true,
				hasButtonCondition: true,
				formsReadSearch: true,
			}),
		).toEqual([]);
	});

	it("says nothing for Case list first", () => {
		expect(
			searchWorkflowCanvasLines({
				workflow: "listFirst",
				hasVisibleField: false,
				hasButtonCondition: true,
				formsReadSearch: false,
			}),
		).toEqual([]);
	});
});
