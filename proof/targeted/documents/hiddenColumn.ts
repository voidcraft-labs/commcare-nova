/**
 * Defect 16, hidden columns: a case list column hidden from Results.
 *
 * Both runtimes' list search matches every field of the list, hidden ones
 * included (`commcare-core util/EntitySortUtil.java::sortEntities`). Nova
 * once left a hidden column that sorts nothing out of the list it emits, so
 * a worker's search no longer found a case by that column's value. In a list
 * with no case tile every column is now a field of the short detail on both
 * export paths, a hidden one as HQ's `invisible` column
 * (`lib/domain/caseListOrder.ts`, rule 1), so the search finds it; the
 * document is a witness that it does.
 *
 * Fixed values: Amina lives in Riverside, and searching the list for
 * Riverside finds her.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { calculatedColumn, plainColumn, proseText } from "@/lib/domain";
import { eq, prop, tableColumn, tableLookup } from "@/lib/domain/predicate";
import { parseLookupRevision } from "@/lib/lookup/schema";
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

const CALCULATED_ID = "targeted-hidden-calculated-column";
const calculatedUuid = (name: string) => targetedUuid(CALCULATED_ID, name);
const REGIONS = "regions_hidden";

/**
 * Defect 16, hidden columns: a calculated column hidden from both screens
 * that reads a lookup table.
 *
 * The column's expression runs for every row in its hidden field, so the
 * lookup table it names must be declared on the entry, or the list fails to
 * open on a device (Core raises `XPathMissingInstanceException`). HQ's build
 * declares it for an `invisible` expression column, and Nova's local suite
 * declares it too (`lib/domain/modules.ts::caseListColumnRuns`, read by the
 * compiler's instance walk). The list's search matches the hidden field's
 * text, the looked-up label.
 *
 * Fixed values: Amina lives in the north, which the table labels Northland,
 * and Baraka in the south, Southland. The list opens in name order, Amina
 * first, and a search for Southland finds Baraka, whom the unsearched list
 * does not put first.
 */
export function hiddenCalculatedColumn() {
	const form = calculatedUuid("form");
	const table = wireTable(REGIONS, [
		{ name: "value", type: "text" },
		{ name: "label", type: "text" },
	]);
	const [value, label] = table.columns;
	if (value === undefined || label === undefined) {
		throw new Error(`The ${REGIONS} table has no value and label columns.`);
	}
	const rows = [
		wireRow(table, "north", { value: "north", label: "Northland" }),
		wireRow(table, "south", { value: "south", label: "Southland" }),
	];
	const doc = buildDoc({
		appId: CALCULATED_ID,
		appName: "Client regions",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "region", label: proseText("Region"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: calculatedUuid("module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(calculatedUuid("name"), "case_name", "Name"),
					calculatedColumn(
						calculatedUuid("region"),
						"Region",
						tableLookup(
							table.id,
							label.id,
							eq(tableColumn(table.id, value.id), prop("client", "region")),
						),
						{ visibleInList: false, visibleInDetail: false },
					),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: calculatedUuid("notes"),
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
		tables: [
			{
				tag: REGIONS,
				fields: ["value", "label"],
				rows: [
					["north", "Northland"],
					["south", "Southland"],
				],
			},
		],
		cases: [
			{
				id: "targeted-amina",
				type: "client",
				name: "Amina",
				properties: { region: "north" },
			},
			{
				id: "targeted-baraka",
				type: "client",
				name: "Baraka",
				properties: { region: "south" },
			},
		],
	});
	return targetedDocument({
		id: CALCULATED_ID,
		rows: ["16, hidden columns: a hidden calculated column"],
		doc,
		lookup: {
			projectId: "project-targeted-hidden-calculated",
			projectRevision: parseLookupRevision("1"),
			definitions: [table],
			rowsByTable: new Map([[table.id, rows]]),
		},
		expected: {
			intent: [
				{
					id: "list-opens",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: {},
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-amina" },
						{ pointer: "/caseList/rows/1/caseId", value: "targeted-baraka" },
					],
				},
				{
					id: "search-by-hidden-label",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Southland" },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-baraka" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
