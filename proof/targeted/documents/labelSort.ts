/**
 * Defect 10, label columns: a list sorted by an ID-mapping column, and one
 * sorted by a column over a select property.
 *
 * Nova sends both columns to HQ as `translatable-enum`
 * (`lib/commcare/hqJson/caseList.ts`), whose sort HQ builds from the label
 * the column shows (`detail_screen.py::TranslatableEnum`, its
 * `sort_xpath_function` taking the place of the sort element's field in
 * `FormattedDetailColumn.sort_node`), while Nova's local archive sorts each
 * by the raw property (`lib/commcare/suite/case-list/sortKeys.ts`). Proof 3
 * runs the same sessions on both over a case database whose values sort one
 * way as text and the other as numbers ("10" and "2",
 * `proof/observe/casedata.py::VALUES`), so each list's rows come in another
 * order on each path.
 *
 * Each sorted column is the list's own: a list with no sort is sorted on a
 * device by its first column with a header, by the text it shows
 * (commcare-core's `util/screen/EntityScreenHelper.sortEntities` in Web
 * Apps, `cases/entity/SortableEntityAdapter.determineFieldsForSortingInOrder`
 * on Android),
 * which for a label column is the label HQ's default sort of that column
 * reads too (`suite_xml/sections/details.py::get_default_sort_elements`), so
 * an unsorted label column shows nothing.
 *
 * Fixed values: the household named Kibera holds zone 10, which the mapping
 * shows as South, so a search for South finds it, and level 10, whose option
 * label, Many, its level column shows. (Its zone cell reads " South": HQ's
 * own ID Mapping joins every entry's text with a space,
 * `suite_xml/xml_models.py::XPathEnum.build`, and Nova's archive writes the
 * same; the harness's findings note it.)
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	idMappingColumn,
	idMappingEntry,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-label-sort";
const uuid = (name: string) => targetedUuid(ID, name);
const ASCENDING = { direction: "asc", priority: 0 } as const;

function visit(name: string) {
	return {
		uuid: uuid(`${name}-form`),
		name: "Visit",
		type: "followup" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid(`${name}-notes`),
				id: "notes",
				label: proseText("Notes"),
			}),
		],
	};
}

export function labelSort() {
	const doc = buildDoc({
		appId: ID,
		appName: "Household levels",
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "zone", label: proseText("Zone"), data_type: "text" },
					{
						name: "level",
						label: proseText("Level"),
						data_type: "single_select",
						options: [
							{ value: "2", label: proseText("Few") },
							{ value: "10", label: proseText("Many") },
						],
					},
				],
			},
		],
		modules: [
			{
				uuid: uuid("zones"),
				name: "Households by zone",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("zones-name"), "case_name", "Name"),
					idMappingColumn(
						uuid("zone"),
						"zone",
						"Zone",
						[idMappingEntry("2", "North"), idMappingEntry("10", "South")],
						{ sort: ASCENDING },
					),
				]),
				forms: [visit("zones")],
			},
			{
				uuid: uuid("levels"),
				name: "Households by level",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("levels-name"), "case_name", "Name"),
					plainColumn(uuid("level"), "level", "Level", { sort: ASCENDING }),
				]),
				forms: [visit("levels")],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-kibera",
				type: "household",
				name: "Kibera",
				properties: { zone: "10", level: "10" },
			},
			{
				id: "targeted-mathare",
				type: "household",
				name: "Mathare",
				properties: { zone: "2", level: "2" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["10 (ID-mapping and select columns)"],
		doc,
		expected: {
			intent: [
				{
					id: "zone-label-searched",
					export: "local",
					form: uuid("zones-form"),
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "South" },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-kibera" },
					],
				},
				{
					id: "level-label-shown",
					export: "local",
					form: uuid("levels-form"),
					restore: "restore.xml",
					request: {
						session: { command: "m1-f0" },
						caseList: { searchText: "Kibera" },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-kibera" },
						{ pointer: "/caseList/rows/0/fields/1", value: "Many" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
