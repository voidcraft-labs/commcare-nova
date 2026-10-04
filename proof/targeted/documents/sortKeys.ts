/**
 * Harness finding 51, sort keys: a list sorted by a hidden column over a
 * property a shown column also reads.
 *
 * HQ attaches a sort element to the first column with its field
 * (`app_manager/util.py::get_sort_and_sort_only_columns`), so HQ's build
 * keeps the sort key on the shown column and none on the hidden one, while
 * Nova's local archive keeps it on the hidden column it sorts
 * (`lib/commcare/suite/case-list/sortKeys.ts`). The rows come in one order
 * on both installs, but each keeps a sort key on another column, and a fuzzy
 * list search matches a field's text against its sort key alone
 * (`commcare-core util/EntitySortUtil.sortEntities`,
 * `cases/entity/Entity.getSortFieldPieces`), so the two installs fuzzily
 * match different columns. Only the fuzz sample shows this otherwise.
 *
 * Fixed values: Amina's phone is 100 and Baraka's 200, so the list, sorted by
 * phone, shows Amina first.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
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
		],
	});
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-baraka",
				type: "client",
				name: "Baraka",
				properties: { phone: "200" },
			},
			{
				id: "targeted-amina",
				type: "client",
				name: "Amina",
				properties: { phone: "100" },
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
			],
		},
		files: { "restore.xml": restore },
	});
}
