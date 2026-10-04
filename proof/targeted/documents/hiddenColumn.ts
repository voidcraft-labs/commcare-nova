/**
 * Defect 16, hidden columns: a case list column hidden from Results that
 * sorts nothing.
 *
 * Nova leaves the column out of the list it emits
 * (`lib/commcare/hqJson/caseList.ts::hqShortSourceColumns`, and the local
 * suite's short detail), while both runtimes' list search matches every
 * field of the list, hidden ones included (`commcare-core
 * util/EntitySortUtil.java::sortEntities`), so a worker's search no longer
 * finds a case by that column's value.
 *
 * Fixed values: Amina lives in Riverside, and searching the list for
 * Riverside finds her.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-hidden-column";
const uuid = (name: string) => targetedUuid(ID, name);

export function hiddenColumn() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Client villages",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village"), data_type: "text" },
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
					plainColumn(uuid("village"), "village", "Village", {
						visibleInList: false,
					}),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
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
				id: "targeted-amina",
				type: "client",
				name: "Amina",
				properties: { village: "Riverside" },
			},
			{
				id: "targeted-baraka",
				type: "client",
				name: "Baraka",
				properties: { village: "Hilltop" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["16, hidden columns"],
		doc,
		expected: {
			intent: [
				{
					id: "search-by-village",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Riverside" },
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
