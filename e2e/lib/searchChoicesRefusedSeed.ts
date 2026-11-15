/**
 * The search-choices-refused smoke: a menu that opens on its results (skip to
 * results) whose one Search field takes its choices from a Project table
 * with no rows. Core's query manager reads each choice list as Formplayer's
 * query screen is built (`RemoteQuerySessionManager.refreshItemSetChoices`,
 * `QueryScreen.init`), before the automatic search runs, and a table with no
 * rows fails it there (`ItemSetUtils.populateDynamicChoices`). So Preview
 * shows the Search screen's refusal in place of the menu, and the patient
 * the default search would find never shows.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type LookupColumnId,
	type LookupTableId,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

export const SEARCH_CHOICES_REFUSED_SEED = {
	appName: "Smoke — Search choices refused",
	moduleUuid: testUuid("search-choices-refused-module"),
	moduleName: "Patients",
	formUuid: testUuid("search-choices-refused-form"),
	caseType: "patient",
	columnUuid: testUuid("search-choices-refused-name-column"),
	searchInputUuid: testUuid("search-choices-refused-region-input"),
	prompt: { name: "region", label: "Region" },
	table: { name: "Regions", tag: "smoke_regions" },
	patient: { caseName: "Ama Owusu" },
} as const;

/** The empty table the Region field reads its choices from. */
export interface SearchChoicesRefusedTable {
	readonly tableId: LookupTableId;
	readonly valueColumnId: LookupColumnId;
	readonly labelColumnId: LookupColumnId;
}

export function buildSearchChoicesRefusedBlueprint(
	appId: string,
	table: SearchChoicesRefusedTable,
): BlueprintDoc {
	const seed = SEARCH_CHOICES_REFUSED_SEED;
	return buildDoc({
		appId,
		appName: seed.appName,
		caseTypes: [
			{
				name: seed.caseType,
				properties: [
					{ name: "region", label: proseText("Region"), data_type: "text" },
					{ name: "note", label: proseText("Visit note"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: seed.moduleUuid,
				name: seed.moduleName,
				caseType: seed.caseType,
				caseListConfig: {
					columns: [plainColumn(seed.columnUuid, "case_name", "Patient")],
					searchInputs: [
						simpleSearchInputDef(
							seed.searchInputUuid,
							seed.prompt.name,
							seed.prompt.label,
							"select",
							"region",
							{
								options: {
									kind: "lookup",
									tableId: table.tableId,
									valueColumnId: table.valueColumnId,
									labelColumnId: table.labelColumnId,
								},
							},
						),
					],
				},
				caseSearchConfig: { workflow: "skipToResults" },
				forms: [
					{
						uuid: seed.formUuid,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Visit note"),
								caseWrite: { caseType: seed.caseType, property: "note" },
							}),
						],
					},
				],
			},
		],
	});
}
