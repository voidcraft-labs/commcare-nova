/** An App Test that meets worker information the worker's device lacks,
 * through the real service: the action's refusal is worded for the surface
 * that stopped and for the worker the session runs as, as Preview words it
 * (`run.ts::appTestDataRefusal`). A worker assigned nowhere holds no place
 * key in the session, so a case list whose filter or Search action's
 * condition reads one stops the list, a menu whose condition reads one stops
 * the menu, a Search field whose starting value, hidden value or required
 * condition reads one stops the Search screen as Preview's opens (or its
 * Search pane, on a list that opens first), a registration's open condition
 * stops the form, and a form's link whose condition reads one, or the list
 * the link opens, stops the next step after the save, which the journey
 * keeps. The Search screen and the links are read in a bounded worker
 * thread, so these also hold that a refusal crosses the thread as one. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	withUserSequences,
} from "@/lib/__tests__/docHelpers";
import { appTestNamespace } from "@/lib/case-store/appTestNamespace";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	type BlueprintDoc,
	hiddenSearchInputDef,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	literal,
	prop,
	sessionUser,
	term,
} from "@/lib/domain/expression/builders";
import type { Platform } from "@/lib/domain/platforms";
import { readPreviewScreen } from "@/lib/preview/engine/dataRefusal";
import {
	previewAsPersona,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { previewLookupData } from "@/lib/preview/engine/lookupEvaluation";
import { serverPreviewDevice } from "@/lib/preview/engine/previewDevice";
import { openSearchRunState } from "@/lib/preview/engine/searchRunState";
import { continueAppTest, startAppTest } from "../service";
import type { AppTestAction } from "../types";

const h = setupAppStateTestDb("app_test_data_refusal_", {
	authSchema: "migrated",
});
const scope = {
	appId: "refusal-app",
	projectId: "refusal-project",
	actorUserId: "author",
};
const LIST_MODULE = testUuid("refusal-list-module");
const MENU_MODULE = testUuid("refusal-menu-module");
const ASHA = testUuid("refusal-asha");
const NAME_INPUT = testUuid("refusal-name-input");
const SURVEY_FORM = testUuid("refusal-survey-form");
const SURVEY_LINK = testUuid("refusal-survey-link");
const HIDDEN_INPUT = testUuid("refusal-hidden-input");
const INTAKE_MODULE = testUuid("refusal-intake-module");
const INTAKE_FORM = testUuid("refusal-intake-form");
const INTAKE_LINK = testUuid("refusal-intake-link");

function placeKey() {
	return term(sessionUser("commcare_location_id"));
}

/** Where the app reads the place key: the case list's filter, the menu's
 *  display condition, the case list's Search action's condition, a Search
 *  field's starting value, hidden value or required condition, the
 *  condition of a link after the survey, a registration's open condition,
 *  or the filter of the list a registration's link opens after its save. */
type PlaceRead =
	| "list-filter"
	| "menu"
	| "search-action"
	| "search-default"
	| "search-hidden"
	| "search-required"
	| "link"
	| "registration-open"
	| "next-screen";

/** The Search fields of an app whose Search screen reads the place key. */
function searchInputsReading(reads: PlaceRead): SearchInputDef[] | undefined {
	switch (reads) {
		case "search-default":
			return [
				simpleSearchInputDef(NAME_INPUT, "name", "Name", "text", "case_name", {
					default: placeKey(),
				}),
			];
		case "search-hidden":
			return [
				simpleSearchInputDef(NAME_INPUT, "name", "Name", "text", "case_name"),
				hiddenSearchInputDef(HIDDEN_INPUT, "place", "Place", placeKey()),
			];
		case "search-required":
			return [
				simpleSearchInputDef(NAME_INPUT, "name", "Name", "text", "case_name", {
					required: {
						when: eq(placeKey(), literal("north")),
						message: "Add a name",
					},
				}),
			];
		default:
			return undefined;
	}
}

function refusalDoc(reads: PlaceRead): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	if (reads === "list-filter" || reads === "next-screen")
		config.filter = eq(prop("patient", "district"), placeKey());
	const searchInputs = searchInputsReading(reads);
	if (searchInputs !== undefined) config.searchInputs = searchInputs;
	return withUserSequences({
		...buildDoc({
			appId: scope.appId,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name" },
						{ name: "district", label: "District" },
					],
				},
			],
			modules: [
				{
					uuid: LIST_MODULE,
					name: "Patients",
					caseType: "patient",
					caseListConfig: config,
					...(reads === "search-action" && {
						caseSearchConfig: {
							searchButtonDisplayCondition: eq(placeKey(), literal("north")),
						},
					}),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
				{
					uuid: MENU_MODULE,
					name: "Surveys",
					...(reads === "menu" && {
						displayCondition: eq(placeKey(), literal("north")),
					}),
					forms: [
						{
							uuid: SURVEY_FORM,
							name: "Survey",
							type: "survey",
							fields: [f({ kind: "text", id: "answer" })],
							...(reads === "link" && {
								formLinks: [
									{
										uuid: SURVEY_LINK,
										condition: eq(placeKey(), literal("north")),
										target: { type: "module", moduleUuid: LIST_MODULE },
									},
								],
								otherwise: { kind: "destination", destination: "firstMenu" },
							}),
						},
					],
				},
				...(reads === "registration-open" || reads === "next-screen"
					? [
							{
								uuid: INTAKE_MODULE,
								name: "Intake",
								caseType: "patient",
								caseListConfig: caseListConfig([
									{ field: "case_name", header: "Name" },
								]),
								forms: [
									{
										uuid: INTAKE_FORM,
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
										...(reads === "registration-open" && {
											openCondition: eq(placeKey(), literal("north")),
										}),
										...(reads === "next-screen" && {
											formLinks: [
												{
													uuid: INTAKE_LINK,
													target: {
														type: "module" as const,
														moduleUuid: LIST_MODULE,
													},
												},
											],
										}),
									},
								],
							},
						]
					: []),
			],
		}),
		personas: { [ASHA]: { uuid: ASHA, name: "Asha" } },
	});
}

async function seed(reads: PlaceRead) {
	await h.seedProjectMember(scope.actorUserId, scope.projectId, "viewer");
	await h.seedAppWithBlueprint(refusalDoc(reads), {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
}

function start(personaUuid: string | null, platform?: Platform) {
	return startAppTest(scope, {
		requestId: "start",
		expectedBlueprintSeq: 0,
		input: {
			purpose: "Open a menu as a worker assigned nowhere",
			sessions: [
				{
					id: "worker",
					personaUuid,
					...(platform === undefined ? {} : { platform }),
				},
			],
		},
	});
}

/** The journey `begin` started last, whose namespace a test reads. */
let testId = "";

async function begin(
	reads: PlaceRead,
	personaUuid: string | null,
	platform?: Platform,
) {
	await seed(reads);
	let current = await start(personaUuid, platform);
	testId = current.testId;
	let request = 0;
	return async (action: AppTestAction) => {
		current = await continueAppTest(scope, {
			testId: current.testId,
			requestId: `step-${++request}`,
			expectedStep: current.step,
			action,
		});
		return current.observation as Record<string, unknown>;
	};
}

it("words a case list's refusal for the list and the persona the session runs as", async () => {
	const step = await begin("list-filter", "Asha");
	const refused = await step({ kind: "menu", moduleUuid: LIST_MODULE });
	expect(refused).toMatchObject({ completed: false });
	expect(refused.error).toBe(
		"This case list doesn't open on a phone. This case list reads worker information Asha doesn't have, so a phone stops here. If it reads Asha's place, you can give Asha a place under Users and personas in App setup.",
	);
});

it("words a menu's refusal for the menu and for previewing as oneself", async () => {
	// The app's first menu lists the menu whose condition reads the place, so
	// the first screen stops, as Core stops a screen listing it.
	await seed("menu");
	await expect(start(null)).rejects.toThrow(
		"This menu doesn't open on a phone. This menu reads worker information you don't have, so a phone stops here. If it reads your place, you can preview as a persona who has a place.",
	);
});

it("words a refusal of the Search action's condition for the list, as Preview does", async () => {
	// The Search action's condition gates the list's action, so Core stops
	// the list that offers it (Preview's `CaseListScreen` shows it on the
	// list), never a Search screen the worker has not reached.
	const step = await begin("search-action", "Asha");
	const refused = await step({ kind: "menu", moduleUuid: LIST_MODULE });
	expect(refused).toMatchObject({ completed: false });
	expect(refused.error).toBe(
		"This case list doesn't open on a phone. This case list reads worker information Asha doesn't have, so a phone stops here. If it reads Asha's place, you can give Asha a place under Users and personas in App setup.",
	);
});

it("words a refusal of a Search field's starting value for the Search screen", async () => {
	// The Search screen reads each starting value as it opens, so a menu that
	// opens on its search stops there.
	const step = await begin("search-default", "Asha");
	const refused = await step({ kind: "menu", moduleUuid: LIST_MODULE });
	expect(refused).toMatchObject({ completed: false });
	expect(refused.error).toBe(
		"This search doesn't open on a phone. This search reads worker information Asha doesn't have, so a phone stops here. If it reads Asha's place, you can give Asha a place under Users and personas in App setup.",
	);
});

it("keeps the saved form and words a refusal of a link's condition for the links after it", async () => {
	// The links are read after the save, so the form stays saved and the
	// refusal is the next step's, as Preview shows it on the saved form.
	const step = await begin("link", "Asha");
	await step({ kind: "menu", moduleUuid: MENU_MODULE });
	await step({ kind: "form", formUuid: SURVEY_FORM });
	const submitted = await step({ kind: "submit" });
	expect(submitted).toMatchObject({
		screen: "after-submit",
		savedInTest: true,
		evidence: { caseTransaction: "committed" },
		nextTaskError:
			"This form's next step stops on a phone. This form's links read worker information Asha doesn't have, so a phone stops here. If it reads Asha's place, you can give Asha a place under Users and personas in App setup.",
	});
});

/** Whether Preview's Search screen for the list opens for Asha, as
 *  `useSearchInputRunState` opens it: the state model the browser runs over
 *  the same app the journey runs. */
function previewSearchOpens(reads: PlaceRead): "opened" | "refused" {
	const doc = refusalDoc(reads);
	const persona = doc.personas?.[ASHA];
	if (persona === undefined) throw new Error("The fixture has no Asha.");
	const identity = previewAsPersona(
		{ id: scope.actorUserId, name: "Author" },
		persona,
		doc,
	);
	const inputs = doc.modules[LIST_MODULE]?.caseListConfig?.searchInputs ?? [];
	const read = readPreviewScreen(() =>
		openSearchRunState(
			LIST_MODULE,
			inputs,
			previewSessionValues(
				identity,
				serverPreviewDevice({ platform: "web-apps", appLanguage: "en" }),
			),
			{
				doc,
				moduleUuid: LIST_MODULE,
				lookup: previewLookupData({
					projectRevision: "0",
					definitions: [],
					rowsByTable: new Map(),
				}),
			},
		),
	);
	return read.kind === "read" ? "opened" : "refused";
}

const SEARCH_REFUSAL =
	"This search doesn't open on a phone. This search reads worker information Asha doesn't have, so a phone stops here. If it reads Asha's place, you can give Asha a place under Users and personas in App setup.";

for (const [reads, slot] of [
	["search-hidden", "a hidden value"],
	["search-required", "a required condition"],
] as const) {
	it(`stops the Search screen where Preview's stops when ${slot} reads worker information the worker lacks`, async () => {
		// Core's query manager reads each hidden value and each required
		// condition as it is built, so Preview's Search screen refuses as it
		// opens, and a menu that opens on its search stops there.
		expect(previewSearchOpens(reads)).toBe("refused");
		const step = await begin(reads, "Asha");
		const refused = await step({ kind: "menu", moduleUuid: LIST_MODULE });
		expect(refused).toMatchObject({ completed: false });
		expect(refused.error).toBe(SEARCH_REFUSAL);
	});
}

it("keeps a list that opens first and refuses its Search, as Preview's Search pane does", async () => {
	// On Android the menu opens on its case list, which keeps its cases; the
	// Search pane is the refusal, and pressing Search meets it.
	const step = await begin("search-hidden", "Asha", "android");
	await step({ kind: "continue" });
	const list = await step({ kind: "menu", moduleUuid: LIST_MODULE });
	expect(list).toMatchObject({
		screen: "browse",
		search: { refusal: SEARCH_REFUSAL },
	});
	expect(list.actions).not.toContain("search");
	const searched = await step({ kind: "search", answers: [] });
	expect(searched).toMatchObject({ completed: false, error: SEARCH_REFUSAL });
});

it("words a refusal as a form opens for the form and the persona", async () => {
	// The registration's open condition is a case block Core calculates as
	// the form opens, so the form stops there.
	const step = await begin("registration-open", "Asha");
	await step({ kind: "menu", moduleUuid: INTAKE_MODULE });
	const refused = await step({ kind: "form", formUuid: INTAKE_FORM });
	expect(refused).toMatchObject({ completed: false });
	expect(refused.error).toBe(
		"This form stops here on a phone. This form reads worker information Asha doesn't have, so a phone stops here. If it reads Asha's place, you can give Asha a place under Users and personas in App setup.",
	);
});

it("keeps a saved registration when the screen after it refuses, as Preview does", async () => {
	// The registration saves, then its link opens the case list whose filter
	// reads the place key: Preview shows that list's refusal after the save,
	// and the case the form made stays made.
	const step = await begin("next-screen", "Asha");
	await step({ kind: "menu", moduleUuid: INTAKE_MODULE });
	await step({ kind: "form", formUuid: INTAKE_FORM });
	await step({
		kind: "answer",
		answers: [{ path: "case_name", value: "Zed" }],
	});
	const submitted = await step({ kind: "submit" });
	expect(submitted).toMatchObject({
		screen: "after-submit",
		savedInTest: true,
		evidence: { caseTransaction: "committed" },
		nextTaskError:
			"This case list doesn't open on a phone. This case list reads worker information Asha doesn't have, so a phone stops here. If it reads Asha's place, you can give Asha a place under Users and personas in App setup.",
	});
	const saved = await sql<{
		case_name: string;
	}>`SELECT case_name FROM ${sql.id(appTestNamespace(testId), "cases")} WHERE case_type = 'patient'`.execute(
		h.db(),
	);
	expect(saved.rows).toEqual([{ case_name: "Zed" }]);
});
