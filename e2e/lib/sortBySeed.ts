/**
 * A case list with a Sort by, like CommCare HQ's health starter app's: it
 * shows each patient's name and village, sorts by a value it hides (whether
 * the patient feels sick, under the name "Feeling Sick") and then by name.
 * The app runs in Web Apps and on Android, so the journey reads the list's
 * Sort by as each platform offers it. Its visit returns to the menu after a
 * submission, which opens on the list, so a journey can submit one and read
 * the list it lands on.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, columnSort, plainColumn } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildUrl } from "@/lib/routing/location";

export const SORT_BY_SEED = {
	appName: "Smoke — Sort by",
	moduleUuid: testUuid("sort-by-module"),
	moduleName: "Patients",
	caseType: "patient",
	columns: {
		name: testUuid("sort-by-name"),
		village: testUuid("sort-by-village"),
		feelingSick: testUuid("sort-by-feeling-sick"),
	},
	sortName: "Feeling Sick",
	/** In the list's own order: feeling sick first, then by name. */
	patients: [
		{ name: "Ben Osei", village: "Riverside", feelingSick: "yes" },
		{ name: "Ada Okafor", village: "Hilltop", feelingSick: "no" },
		{ name: "Cy Mensah", village: "Bayview", feelingSick: "no" },
	],
} as const;

export function buildSortByBlueprint(appId: string): BlueprintDoc {
	const seed = SORT_BY_SEED;
	return buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{ name: "village", label: proseText("Village"), data_type: "text" },
					{
						name: "feeling_sick",
						label: proseText("Feeling sick"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: seed.moduleUuid,
				name: seed.moduleName,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [
						plainColumn(seed.columns.name, "case_name", "Name", {
							sort: columnSort("asc", 1),
						}),
						plainColumn(seed.columns.village, "village", "Village"),
						plainColumn(seed.columns.feelingSick, "feeling_sick", "", {
							visibleInList: false,
							sort: columnSort("desc", 0, undefined, seed.sortName),
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						postSubmit: "module",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}

export function sortByRoute(appId: string): string {
	return buildUrl(`/build/${appId}`, {
		kind: "module",
		moduleUuid: SORT_BY_SEED.moduleUuid,
	});
}
