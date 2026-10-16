/**
 * Harness finding 51, sort keys: a list sorted by a hidden column over a
 * property a shown column also reads.
 *
 * HQ attaches a sort element to the first column with its field
 * (`app_manager/util.py::get_sort_and_sort_only_columns`), so HQ's build
 * keeps the sort key on the shown column and none on the hidden one. Nova's
 * local archive once kept it on the hidden column it sorts, and a fuzzy list
 * search matches a field's text against its sort key alone
 * (`commcare-core util/EntitySortUtil.sortEntities`,
 * `cases/entity/Entity.getSortFieldPieces`), so the two installs fuzzily
 * matched different columns. Both paths now read one order plan
 * (`lib/domain/caseListOrder.ts::caseListOrderPlan`), which joins the rule
 * to the first column with its field as HQ does; the document is a witness
 * that the keys sit on one field on both.
 *
 * Fixed values: Amina's phone is 100 and Baraka's 200, so the list, sorted by
 * phone, shows Amina first.
 *
 * The second menu is the one shape where a moved key changes what a search
 * finds: its list shows an image map over `code` beside a hidden plain
 * column over `code`. An order rule on the hidden column would go to the
 * image map on HQ's build, whose key is the mapping position, while the
 * hidden column orders by the stored value, so Nova refuses it
 * (`CASE_LIST_SORT_PROPERTY_AMBIGUOUS`) and the rule is on the image map, as
 * the cutover's `sort-property-ownership` step moves it. Amina's code is
 * `alpha`, the mapping's first entry, Baraka's `bravo`, its second, and
 * Chausiku has none, a blank key, so the second list, in mapping order with
 * blanks first, shows Chausiku, Amina, then Baraka.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import {
	imageMapColumn,
	imageMapEntry,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-shared-property-sort";
const uuid = (name: string) => targetedUuid(ID, name);
const ASCENDING = { direction: "asc", priority: 0 } as const;

export function sharedPropertySort() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Client phones",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
					{ name: "code", label: proseText("Code"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					plainColumn(uuid("phone"), "phone", "Phone"),
					plainColumn(uuid("phone-sort"), "phone", "Phone order", {
						visibleInList: false,
						sort: ASCENDING,
					}),
				]),
				forms: [
					{
						uuid: form,
						name: "Call",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
			{
				uuid: uuid("codes-module"),
				name: "Clients by code",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("codes-name"), "case_name", "Name"),
					imageMapColumn(
						uuid("codes-image"),
						"code",
						"Code",
						[
							imageMapEntry("alpha", mediaIds.label),
							imageMapEntry("bravo", mediaIds.label),
						],
						{ sort: ASCENDING },
					),
					plainColumn(uuid("codes-sort"), "code", "Code order", {
						visibleInList: false,
					}),
				]),
				forms: [
					{
						uuid: uuid("codes-form"),
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("codes-notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
		],
	});
	const media = uploadedMedia(mediaManifest());
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-baraka",
				type: "client",
				name: "Baraka",
				properties: { phone: "200", code: "bravo" },
			},
			{
				id: "targeted-amina",
				type: "client",
				name: "Amina",
				properties: { phone: "100", code: "alpha" },
			},
			{
				id: "targeted-chausiku",
				type: "client",
				name: "Chausiku",
				properties: { phone: "300" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["51, sort keys"],
		doc,
		expected: {
			intent: [
				{
					id: "sorted-by-phone",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: {},
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-amina" },
					],
				},
				{
					id: "sorted-by-code",
					export: "local",
					form: uuid("codes-form"),
					restore: "restore.xml",
					request: {
						session: { command: "m1-f0" },
						caseList: {},
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-chausiku" },
						{ pointer: "/caseList/rows/1/caseId", value: "targeted-amina" },
						{ pointer: "/caseList/rows/2/caseId", value: "targeted-baraka" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
		...(media !== undefined && { media }),
	});
}
