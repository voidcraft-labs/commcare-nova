/**
 * The documents the Preview navigation peer (`preview-navigation-client.tsx`)
 * runs, in an app that runs in Web Apps and on Android. Plain TypeScript, so
 * Vitest admits them before any browser mounts one.
 *
 * - `search-first`: a case-first menu with one Search field and no saved
 *   workflow, so it searches first.
 * - `case-list-entry`: a forms-first menu (a registration form beside a
 *   follow-up) that lists its case list as an entry of its own after its
 *   forms. `withDetails` gives the case list a Details screen.
 * - `case-first-entry`: a case-first menu (one follow-up) that holds its
 *   case list as an entry of its own, which CommCare does not list once
 *   the case is chosen, since that entry chooses the same case.
 * - `child-list-above`: "Households", case first, holding its own case list
 *   entry, and "People" (a household's members, chosen under the household)
 *   showing its follow-up and its case list entry on the households' screen,
 *   whose entry CommCare lists once the household is chosen.
 * - `submenus`: "Households", case first, keeping a submenu "Household
 *   notes" with a screen of its own, and "Household list", only its case
 *   list, keeping a submenu "Household checks". CommCare asks for the
 *   household before it lists either submenu's tile.
 * - `parent-chain`: "Villages", "Households" (a village's households,
 *   chosen under the village) and "People" (a household's members, chosen
 *   under the household), each a menu of its own with one follow-up, so
 *   CommCare asks for the village, then the household, before it lists
 *   People.
 * - `place-condition`: "Patients" beside "Placed visits", a survey menu
 *   whose condition reads the worker's primary place from the session. The
 *   worker is assigned nowhere, so the device holds no such key and CommCare
 *   fails the first menu, which reads the condition.
 * - `place-screens`: every other screen that reads the worker's primary
 *   place, for a worker assigned nowhere, each under a first menu that reads
 *   nothing of it: "Districts", whose submenu "District rounds" has such a
 *   condition, so the Districts screen fails; "Patients", case first, whose
 *   "Placed visit" form has one, which CommCare reads once the case is
 *   chosen; "Find patients", which searches first with a Search field
 *   that starts on the place, which the Search screen reads as it opens; and
 *   "Placed patients", whose list's filter reads it, which the case store
 *   refuses as it compiles the read (the peer's case reads answer so).
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	type FormSpec,
	type ModuleSpec,
} from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { builtinIconRef } from "@/lib/domain/builtinIcons";
import { eq, literal, prop, sessionUser, term } from "@/lib/domain/expression";

export const NAVIGATION_APP_ID = "native-navigation";
/** The two cases the worker's device holds, by name. */
export const NAVIGATION_CASES = ["Asha Rao", "Kofi Mensah"] as const;

export type NavigationFixture =
	| "search-first"
	| "case-list-entry"
	| "case-first-entry"
	| "child-list-above"
	| "submenus"
	| "parent-chain"
	| "place-condition"
	| "place-screens";

export const NAVIGATION_MODULE_UUID = testUuid("navigation-module");
/** `child-list-above`'s households, each with the members its device holds. */
export const NAVIGATION_HOUSEHOLDS = [
	{ name: "Rao household", members: ["Asha Rao", "Ravi Rao"] },
	{ name: "Mensah household", members: ["Kofi Mensah"] },
] as const;
/** The villages each household of `NAVIGATION_HOUSEHOLDS` is under, in
 *  order, for `parent-chain`. */
export const NAVIGATION_VILLAGES = ["North village", "South village"] as const;
const NAVIGATION_HOUSEHOLDS_MODULE_UUID = testUuid("navigation-households");
/** `parent-chain`'s households menu, whose list a household's address names. */
export const PARENT_CHAIN_HOUSEHOLDS_MODULE_UUID = testUuid(
	"navigation-chain-households",
);
const PEOPLE_MODULE_UUID = testUuid("navigation-people");
const NAME_COLUMN = testUuid("navigation-name-column");
const visit: FormSpec = {
	name: "Visit",
	type: "followup",
	fields: [{ kind: "text", id: "note", label: "Note" }],
};
const register: FormSpec = {
	name: "Register",
	type: "registration",
	fields: [
		{
			kind: "text",
			id: "case_name",
			label: "Name",
			caseWrite: { caseType: "patient", property: "case_name" },
		},
	],
};

export function buildNavigationDoc(
	fixture: NavigationFixture,
	withDetails: boolean,
): BlueprintDoc {
	if (fixture === "child-list-above") return buildHouseholdsDoc();
	if (fixture === "submenus") return buildSubmenusDoc();
	if (fixture === "parent-chain") return buildParentChainDoc();
	if (fixture === "place-condition") return buildPlaceConditionDoc();
	if (fixture === "place-screens") return buildPlaceScreensDoc();
	const doc = buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: buildNavigationModules(fixture, withDetails),
	});
	if (fixture === "search-first") {
		doc.appSettings.formMenuLayout = "grid";
		const visit = Object.values(doc.forms).find(
			(form) => form.name === "Visit",
		);
		if (!visit)
			throw new Error("The case-first fixture requires its Visit command.");
		visit.icon = builtinIconRef("record_vitals");
	}
	return doc;
}

/** The "Patients" menu of the one-menu fixtures. */
function buildNavigationModules(
	fixture: NavigationFixture,
	withDetails: boolean,
): ModuleSpec[] {
	return [
		{
			uuid: NAVIGATION_MODULE_UUID,
			name: "Patients",
			caseType: "patient",
			...(fixture !== "search-first" && { caseListMenuItem: {} }),
			caseListConfig: {
				columns: [
					plainColumn(NAME_COLUMN, "case_name", "Name", {
						visibleInList: true,
						visibleInDetail: withDetails,
					}),
				],
				searchInputs:
					fixture === "search-first"
						? [
								simpleSearchInputDef(
									testUuid("navigation-name-input"),
									"patient_name",
									"Patient name",
									"text",
									"case_name",
								),
							]
						: [],
			},
			forms: fixture === "case-list-entry" ? [register, visit] : [visit],
		},
	];
}

function buildHouseholdsDoc(): BlueprintDoc {
	const list = (column: string) => ({
		columns: [
			plainColumn(testUuid(column), "case_name", "Name", {
				visibleInList: true,
				visibleInDetail: false,
			}),
		],
		searchInputs: [],
	});
	const doc = buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "person", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: NAVIGATION_HOUSEHOLDS_MODULE_UUID,
				name: "Households",
				caseType: "household",
				caseListMenuItem: {},
				caseListConfig: list("navigation-household-name"),
				forms: [{ ...visit, name: "Visit household" }],
			},
			{
				uuid: PEOPLE_MODULE_UUID,
				name: "People",
				caseType: "person",
				parentCaseModuleUuid: NAVIGATION_HOUSEHOLDS_MODULE_UUID,
				caseListMenuItem: {},
				caseListConfig: list("navigation-person-name"),
				forms: [{ ...visit, name: "Visit person" }],
			},
		],
	});
	doc.modules[PEOPLE_MODULE_UUID] = {
		...doc.modules[PEOPLE_MODULE_UUID],
		parentModuleUuid: NAVIGATION_HOUSEHOLDS_MODULE_UUID,
		formsInMenuAbove: true,
	};
	return doc;
}

/** Villages, their households and the households' people, each chosen
 *  under the one before it, each a menu of its own. */
function buildParentChainDoc(): BlueprintDoc {
	const list = (column: string) => ({
		columns: [
			plainColumn(testUuid(column), "case_name", "Name", {
				visibleInList: true,
				visibleInDetail: false,
			}),
		],
		searchInputs: [],
	});
	const villages = testUuid("navigation-chain-villages");
	return buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [
			{ name: "village", properties: [] },
			{ name: "household", parent_type: "village", properties: [] },
			{ name: "person", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: villages,
				name: "Villages",
				caseType: "village",
				caseListConfig: list("navigation-chain-village-name"),
				forms: [{ ...visit, name: "Visit village" }],
			},
			{
				uuid: PARENT_CHAIN_HOUSEHOLDS_MODULE_UUID,
				name: "Households",
				caseType: "household",
				parentCaseModuleUuid: villages,
				caseListConfig: list("navigation-chain-household-name"),
				forms: [{ ...visit, name: "Visit household" }],
			},
			{
				uuid: testUuid("navigation-chain-people"),
				name: "People",
				caseType: "person",
				parentCaseModuleUuid: PARENT_CHAIN_HOUSEHOLDS_MODULE_UUID,
				caseListConfig: list("navigation-chain-person-name"),
				forms: [{ ...visit, name: "Visit person" }],
			},
		],
	});
}

/** Two household menus, each keeping a submenu of households with a screen
 *  of its own: "Households" case first, "Household list" only its list. */
function buildSubmenusDoc(): BlueprintDoc {
	const list = (column: string) => ({
		columns: [
			plainColumn(testUuid(column), "case_name", "Name", {
				visibleInList: true,
				visibleInDetail: false,
			}),
		],
		searchInputs: [],
	});
	const households = testUuid("navigation-submenus-households");
	const householdList = testUuid("navigation-submenus-household-list");
	const notes = testUuid("navigation-submenus-notes");
	const checks = testUuid("navigation-submenus-checks");
	const doc = buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [{ name: "household", properties: [] }],
		modules: [
			{
				uuid: households,
				name: "Households",
				caseType: "household",
				caseListConfig: list("navigation-submenus-households-name"),
				forms: [{ ...visit, name: "Visit household" }],
			},
			{
				uuid: notes,
				name: "Household notes",
				caseType: "household",
				caseListConfig: list("navigation-submenus-notes-name"),
				forms: [{ ...visit, name: "Add note" }],
			},
			{
				uuid: householdList,
				name: "Household list",
				caseType: "household",
				caseListMenuItem: {},
				caseListConfig: list("navigation-submenus-list-name"),
				forms: [],
			},
			{
				uuid: checks,
				name: "Household checks",
				caseType: "household",
				caseListConfig: list("navigation-submenus-checks-name"),
				forms: [{ ...visit, name: "Check household" }],
			},
		],
	});
	doc.modules[notes] = { ...doc.modules[notes], parentModuleUuid: households };
	doc.modules[checks] = {
		...doc.modules[checks],
		parentModuleUuid: householdList,
	};
	return doc;
}

function buildPlaceConditionDoc(): BlueprintDoc {
	const [patients] = buildNavigationModules("case-first-entry", false);
	return buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			patients,
			{
				uuid: testUuid("navigation-placed"),
				name: "Placed visits",
				displayCondition: eq(
					sessionUser("commcare_location_id"),
					literal("north"),
				),
				forms: [
					{
						uuid: testUuid("navigation-placed-survey"),
						name: "Placed visit",
						type: "survey",
						fields: [{ kind: "text", id: "note", label: "Note" }],
					},
				],
			},
		],
	});
}

const PLACE_DISTRICTS_UUID = testUuid("navigation-districts");
/** `place-screens`' menu whose list filter reads the worker's place. */
export const PLACED_PATIENTS_MODULE_UUID = testUuid(
	"navigation-placed-patients",
);

/** The worker's primary place is `north`: CommCare refuses the read for a
 *  worker assigned nowhere, whose session holds no such key. */
const atNorth = () => eq(sessionUser("commcare_location_id"), literal("north"));

function buildPlaceScreensDoc(): BlueprintDoc {
	const survey = (key: string, name: string): FormSpec => ({
		uuid: testUuid(`${key}-form`),
		name,
		type: "survey",
		fields: [{ kind: "text", id: "note", label: "Note" }],
	});
	const patientList = (column: string) => ({
		columns: [
			plainColumn(testUuid(column), "case_name", "Name", {
				visibleInList: true,
				visibleInDetail: false,
			}),
		],
		searchInputs: [],
	});
	const doc = buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: PLACE_DISTRICTS_UUID,
				name: "Districts",
				forms: [survey("navigation-district-survey", "District survey")],
			},
			{
				uuid: testUuid("navigation-district-rounds"),
				name: "District rounds",
				displayCondition: atNorth(),
				forms: [survey("navigation-district-round", "District round")],
			},
			{
				uuid: testUuid("navigation-place-patients"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: patientList("navigation-place-patient-name"),
				forms: [
					visit,
					{ ...visit, name: "Placed visit", displayCondition: atNorth() },
				],
			},
			{
				uuid: PLACED_PATIENTS_MODULE_UUID,
				name: "Placed patients",
				caseType: "patient",
				caseListConfig: {
					...patientList("navigation-placed-patient-name"),
					filter: eq(
						prop("patient", "case_name"),
						term(sessionUser("commcare_location_id")),
					),
				},
				forms: [{ ...visit, name: "Visit placed patient" }],
			},
			{
				uuid: testUuid("navigation-find-patients"),
				name: "Find patients",
				caseType: "patient",
				caseListConfig: {
					...patientList("navigation-find-patient-name"),
					searchInputs: [
						simpleSearchInputDef(
							testUuid("navigation-find-patient-place"),
							"place",
							"Place",
							"text",
							"case_name",
							{ default: term(sessionUser("commcare_location_id")) },
						),
					],
				},
				forms: [{ ...visit, name: "Visit found patient" }],
			},
		],
	});
	doc.modules[testUuid("navigation-district-rounds")] = {
		...doc.modules[testUuid("navigation-district-rounds")],
		parentModuleUuid: PLACE_DISTRICTS_UUID,
	};
	return doc;
}
