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

export type NavigationFixture = "search-first" | "case-list-entry";

export const NAVIGATION_MODULE_UUID = testUuid("navigation-module");
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
	return buildDoc({
		appId: NAVIGATION_APP_ID,
		appName: "Navigation",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: NAVIGATION_MODULE_UUID,
				name: "Patients",
				caseType: "patient",
				...(fixture === "case-list-entry" && { caseListMenuItem: {} }),
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
				forms: fixture === "search-first" ? [visit] : [register, visit],
			},
		],
	});
}
