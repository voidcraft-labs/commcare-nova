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
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FormSpec } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";

export const NAVIGATION_APP_ID = "native-navigation";
/** The two cases the worker's device holds, by name. */
export const NAVIGATION_CASES = ["Asha Rao", "Kofi Mensah"] as const;

export type NavigationFixture =
	| "search-first"
	| "case-list-entry"
	| "case-first-entry"
	| "child-list-above";

export const NAVIGATION_MODULE_UUID = testUuid("navigation-module");
/** `child-list-above`'s households, each with the members its device holds. */
export const NAVIGATION_HOUSEHOLDS = [
	{ name: "Rao household", members: ["Asha Rao", "Ravi Rao"] },
	{ name: "Mensah household", members: ["Kofi Mensah"] },
] as const;
export const NAVIGATION_HOUSEHOLDS_MODULE_UUID = testUuid(
	"navigation-households",
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
	return buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
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
		],
	});
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
