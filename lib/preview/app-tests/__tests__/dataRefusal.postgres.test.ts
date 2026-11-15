/** An App Test that meets worker information the worker's device lacks,
 * through the real service: the action's refusal is worded for the surface
 * that stopped and for the worker the session runs as, as Preview words it
 * (`run.ts::appTestDataRefusal`). A worker assigned nowhere holds no place
 * key in the session, so a case list whose filter or Search action's
 * condition reads one stops the list, a menu whose condition reads one stops
 * the menu, a Search field whose starting value reads one stops the Search
 * screen, and a form's link whose condition reads one stops the links after
 * the form. The Search screen and the links are read in a bounded worker
 * thread, so these also hold that a refusal crosses the thread as one. */
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	withUserSequences,
} from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { type BlueprintDoc, simpleSearchInputDef } from "@/lib/domain";
import {
	eq,
	literal,
	prop,
	sessionUser,
	term,
} from "@/lib/domain/expression/builders";
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

function placeKey() {
	return term(sessionUser("commcare_location_id"));
}

/** Where the app reads the place key: the case list's filter, the menu's
 *  display condition, the case list's Search action's condition, a Search
 *  field's starting value, or the condition of a link after the survey. */
type PlaceRead =
	| "list-filter"
	| "menu"
	| "search-action"
	| "search-default"
	| "link";

function refusalDoc(reads: PlaceRead): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	if (reads === "list-filter")
		config.filter = eq(prop("patient", "district"), placeKey());
	if (reads === "search-default")
		config.searchInputs = [
			simpleSearchInputDef(NAME_INPUT, "name", "Name", "text", "case_name", {
				default: placeKey(),
			}),
		];
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

function start(personaUuid: string | null) {
	return startAppTest(scope, {
		requestId: "start",
		expectedBlueprintSeq: 0,
		input: {
			purpose: "Open a menu as a worker assigned nowhere",
			sessions: [{ id: "worker", personaUuid }],
		},
	});
}

async function begin(reads: PlaceRead, personaUuid: string | null) {
	await seed(reads);
	let current = await start(personaUuid);
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
