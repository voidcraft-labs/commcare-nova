/**
 * Defect 10, label columns and the order of a list: a list sorted by an
 * ID-mapping column, one sorted by a column over a select property, and one
 * with no order rule over every column kind that keeps a sort key.
 *
 * Nova once sent both sorted columns to HQ as `translatable-enum`, whose
 * sort HQ builds from the label the column shows
 * (`detail_screen.py::TranslatableEnum`), while Nova's local archive sorted
 * each by the raw property, so each list's rows came in another order on
 * each path. Both paths now read one order plan
 * (`lib/domain/caseListOrder.ts::caseListOrderPlan`): an ID mapping is HQ's
 * `enum`, ordered by its mapping position on both, and a select column by
 * its label on both. Proof 3 runs the same sessions on both over a case
 * database whose values sort one way as text and the other as numbers ("10"
 * and "2", `proof/observe/casedata.py::VALUES`), so a difference in either
 * list's order shows there; the document is a witness that none does.
 *
 * The third menu's list has no order rule. Its first column is hidden from
 * Results; then come a date, an ID mapping, an image map, a select label, a
 * shown and a hidden interval, a link and a calculated column. HQ's default
 * order is the list's first field (`suite_xml/sections/details.py::
 * get_default_sort_elements`), which would be the hidden column, so Nova
 * writes the rule a person sees: the first shown column, the date, ascending
 * (the plan's rule 7). Every other column keeps the sort key HQ's build
 * gives it with no rule (rule 3), which a header pick in Android's Sort menu
 * and a fuzzy search read. The households' values put each key, and the
 * hidden column, in another order, so a list ordered by any other field
 * shows another order than the date's.
 *
 * Fixed values: the household named Kibera holds zone 10, which the mapping
 * shows as South, so a search for South finds it, and level 10, whose option
 * label, Many, its level column shows. (Its zone cell reads " South": HQ's
 * own ID Mapping joins every entry's text with a space,
 * `suite_xml/xml_models.py::XPathEnum.build`, and Nova's archive writes the
 * same; the harness's findings note it.) The unsorted list shows Mathare,
 * visited 2026-01-01, then Pumwani, 2026-01-02, then Kibera, 2026-01-03.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import {
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	intervalColumn,
	linkColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import { uploadedMedia } from "../../corpus/documents";
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
					{ name: "rank", label: proseText("Rank"), data_type: "text" },
					{
						name: "visit_date",
						label: proseText("Visit date"),
						data_type: "date",
					},
					{
						name: "last_seen",
						label: proseText("Last seen"),
						data_type: "date",
					},
					{ name: "site", label: proseText("Site"), data_type: "text" },
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
			{
				uuid: uuid("unsorted"),
				name: "Households unsorted",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("unsorted-rank"), "rank", "Rank", {
						visibleInList: false,
					}),
					dateColumn(
						uuid("unsorted-visited"),
						"visit_date",
						"Visited",
						"%Y-%m-%d",
					),
					idMappingColumn(uuid("unsorted-zone-name"), "zone", "Zone name", [
						idMappingEntry("2", "North"),
						idMappingEntry("10", "South"),
					]),
					imageMapColumn(uuid("unsorted-zone-image"), "zone", "Zone image", [
						imageMapEntry("2", mediaIds.option),
						imageMapEntry("10", mediaIds.icon),
					]),
					plainColumn(uuid("unsorted-level"), "level", "Level label"),
					intervalColumn(
						uuid("unsorted-seen"),
						"last_seen",
						"Seen",
						30,
						"days",
						"always",
						"Overdue",
					),
					intervalColumn(
						uuid("unsorted-seen-hidden"),
						"last_seen",
						"Seen hidden",
						30,
						"days",
						"flag",
						"Late",
						{ visibleInList: false },
					),
					linkColumn(uuid("unsorted-site"), "site", "Site", "Open site"),
					calculatedColumn(
						uuid("unsorted-zone-copy"),
						"Zone copy",
						term(prop("household", "zone")),
					),
				]),
				forms: [visit("unsorted")],
			},
		],
	});
	const media = uploadedMedia(mediaManifest());
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-kibera",
				type: "household",
				name: "Kibera",
				properties: {
					zone: "10",
					level: "10",
					rank: "a",
					visit_date: "2026-01-03",
					site: "https://example.org/kibera",
				},
			},
			{
				id: "targeted-mathare",
				type: "household",
				name: "Mathare",
				properties: {
					zone: "2",
					level: "10",
					rank: "c",
					visit_date: "2026-01-01",
					last_seen: "2026-01-01",
					site: "https://example.org/mathare",
				},
			},
			{
				id: "targeted-pumwani",
				type: "household",
				name: "Pumwani",
				properties: {
					zone: "3",
					level: "2",
					rank: "b",
					visit_date: "2026-01-02",
					last_seen: "2025-06-01",
					site: "https://example.org/pumwani",
				},
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
				{
					id: "unsorted-rows-by-first-shown-column",
					export: "local",
					form: uuid("unsorted-form"),
					restore: "restore.xml",
					request: {
						session: { command: "m2-f0" },
						caseList: {},
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-mathare" },
						{ pointer: "/caseList/rows/1/caseId", value: "targeted-pumwani" },
						{ pointer: "/caseList/rows/2/caseId", value: "targeted-kibera" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
		...(media !== undefined && { media }),
	});
}
