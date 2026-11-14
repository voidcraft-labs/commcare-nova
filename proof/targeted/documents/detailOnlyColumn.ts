/**
 * A case list column the case's detail shows and the list does not carry
 * (`Column.notOnList`).
 *
 * CommCare HQ's case detail routinely shows more than its list: a long
 * detail column the short detail does not hold. Nova writes a column that is
 * not on the list into the long detail alone, on both export paths: no field
 * of the short detail, so no device matches it when a worker filters the
 * list, where a column hidden from Results is an `invisible` field the
 * filter matches (`lib/domain/caseListOrder.ts`, rule 1). HQ's build and
 * Core read the detail with a column its list lacks, and the lane's proofs
 * hold Nova's two exports to each other.
 *
 * Fixed values: Amina lives in Riverside, which only her details show.
 * Searching the list for Riverside finds no case, and searching it for her
 * name finds her; the list shows one field, her name.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-detail-only-column";
const uuid = (name: string) => targetedUuid(ID, name);

export function detailOnlyColumn() {
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
						notOnList: true,
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
		rows: ["a column the case detail shows and the list does not carry"],
		doc,
		expected: {
			intent: [
				{
					id: "search-by-detail-only-value",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Riverside" },
					},
					expect: [
						{ pointer: "/caseList/rows", value: [] },
						{ pointer: "/caseList/headers", value: ["Name"] },
					],
				},
				{
					id: "search-by-name",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Amina" },
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
