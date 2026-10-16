/**
 * Defect 12, custom tile, and the tile alignment the Case List save writes.
 *
 * Nova emits `case_tile_template: custom` for any tile layout
 * (`lib/commcare/hqJson/caseList.ts`), and its publish asks a project space
 * for both `CASE_LIST_TILE` and `CASE_LIST_TILE_CUSTOM` before it sends one
 * (`lib/commcare/projectSpaceCompatibility.ts`, the case tiles capability):
 * HQ's Case List page offers and keeps a custom tile only under both, and a
 * save under `CASE_LIST_TILE` alone drops it with every cell's alignment and
 * size. So the document has no `CASE_LIST_TILE` configuration: Nova's
 * publish refuses that project space, and `proof/corpus/entryWriter.ts`
 * writes no configuration a verdict refuses. What the save there drops
 * stays held on the controls `targeted-custom-tile` and
 * `targeted-custom-tile-explicit-cells`, which keep that configuration.
 * Under both flags the save keeps the tile and writes HQ's defaults
 * (`left`, `start`, `medium`) into each cell that holds none, which HQ's
 * build carries into the suite's `<style>` (`suite_xml/sections/details.py`;
 * the harness's findings, defect 42). Every cell states all three
 * (`lib/domain/modules.ts::tileCell`, which fills `left`, `top` and
 * `medium`), so that save changes no cell.
 *
 * Fixed values: Amina's visit shows her name, her village and her last
 * visit in the tile's three cells.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText, tileCell } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-custom-tile";
const uuid = (name: string) => targetedUuid(ID, name);

export function customTile() {
	const followup = uuid("followup");
	const doc = buildDoc({
		appId: ID,
		appName: "Visit tiles",
		caseTypes: [
			{
				name: "visit",
				properties: ["case_name", "village", "last_visit"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text" as const,
				})),
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("name"), "case_name", "Name", {
							tile: tileCell(0, 0, 6, 1),
						}),
						plainColumn(uuid("village"), "village", "Village", {
							tile: tileCell(6, 0, 6, 1),
						}),
						plainColumn(uuid("last-visit"), "last_visit", "Last visit", {
							tile: tileCell(0, 1, 12, 1),
						}),
					],
					{ tile: {} },
				),
				forms: [
					{
						uuid: followup,
						name: "Record visit",
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
					{
						uuid: uuid("registration"),
						name: "New visit",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("visit-name"),
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "visit", property: "case_name" },
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
				id: "targeted-amina-visit",
				type: "visit",
				name: "Amina",
				properties: { village: "Riverside", last_visit: "2026-01-10" },
			},
			{
				id: "targeted-baraka-visit",
				type: "visit",
				name: "Baraka",
				properties: { village: "Hilltop", last_visit: "2025-12-31" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["12, custom tile", "14, tiles (alignment)", "42 (tile alignment)"],
		doc,
		expected: {
			intent: [
				{
					id: "amina-tile",
					export: "local",
					form: followup,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Amina" },
					},
					expect: [
						{
							pointer: "/caseList/rows/0/caseId",
							value: "targeted-amina-visit",
						},
						{ pointer: "/caseList/rows/0/fields/0", value: "Amina" },
						{ pointer: "/caseList/rows/0/fields/1", value: "Riverside" },
						{ pointer: "/caseList/rows/0/fields/2", value: "2026-01-10" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}

const HIDDEN_ORDER_ID = "targeted-tile-hidden-order";
const hiddenOrderUuid = (name: string) => targetedUuid(HIDDEN_ORDER_ID, name);

/**
 * Defect 14, tiles: the corrected tile clause. A tile list ordered by two
 * columns hidden from Results, neither of which is on the tile.
 *
 * A column of a tile's short detail is a field HQ's Case List save gives a
 * cell (`static/app_manager/js/details/bootstrap5/column.js`, `serialize`),
 * so a hidden column stored there would gain one on the first save. Nova
 * writes each hidden order rule as a sort row with no stored column instead,
 * for which HQ appends a zero-width field of its own
 * (`app_manager/util.py::create_temp_sort_column`) that no save can give a
 * cell and HQ's build styles not at all; over `owner_id` the row is the bare
 * name, which HQ's field reads as `@owner_id`
 * (`detail_screen.py::CASE_PROPERTY_MAP`). The local suite appends the same
 * fields (`lib/domain/caseListOrder.ts`, rules 4 and 5). Each appended field
 * holds the raw value, so the list's search matches it.
 *
 * Fixed values: Amina and Baraka tie on `rank` (`high`) and differ in owner,
 * so the second rule, the owner descending, puts Baraka (`owner-b`) before
 * Amina (`owner-a`); Chausiku's rank, `low`, comes after both. A search for
 * `low`, which only the first hidden column holds, finds Chausiku.
 */
export function tileHiddenOrder() {
	const followup = hiddenOrderUuid("followup");
	const doc = buildDoc({
		appId: HIDDEN_ORDER_ID,
		appName: "Visit tile order",
		caseTypes: [
			{
				name: "visit",
				properties: ["case_name", "village", "rank"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text" as const,
				})),
			},
		],
		modules: [
			{
				uuid: hiddenOrderUuid("module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf(
					[
						plainColumn(hiddenOrderUuid("name"), "case_name", "Name", {
							tile: tileCell(0, 0, 6, 1),
						}),
						plainColumn(hiddenOrderUuid("village"), "village", "Village", {
							tile: tileCell(6, 0, 6, 1),
						}),
						plainColumn(hiddenOrderUuid("rank"), "rank", "Rank", {
							visibleInList: false,
							sort: { direction: "asc", priority: 0 },
						}),
						plainColumn(hiddenOrderUuid("owner"), "owner_id", "Owner", {
							visibleInList: false,
							sort: { direction: "desc", priority: 1 },
						}),
					],
					{ tile: {} },
				),
				forms: [
					{
						uuid: followup,
						name: "Record visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: hiddenOrderUuid("notes"),
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
				id: "targeted-amina-visit",
				type: "visit",
				name: "Amina",
				owner: "owner-a",
				properties: { village: "Riverside", rank: "high" },
			},
			{
				id: "targeted-baraka-visit",
				type: "visit",
				name: "Baraka",
				owner: "owner-b",
				properties: { village: "Hilltop", rank: "high" },
			},
			{
				id: "targeted-chausiku-visit",
				type: "visit",
				name: "Chausiku",
				owner: "owner-c",
				properties: { village: "Lakeside", rank: "low" },
			},
		],
	});
	return targetedDocument({
		id: HIDDEN_ORDER_ID,
		rows: ["14, tiles (the corrected tile clause)"],
		doc,
		expected: {
			intent: [
				{
					id: "rows-follow-both-rules",
					export: "local",
					form: followup,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: {},
					},
					expect: [
						{
							pointer: "/caseList/rows/0/caseId",
							value: "targeted-baraka-visit",
						},
						{
							pointer: "/caseList/rows/1/caseId",
							value: "targeted-amina-visit",
						},
						{
							pointer: "/caseList/rows/2/caseId",
							value: "targeted-chausiku-visit",
						},
					],
				},
				{
					id: "search-finds-carrier-value",
					export: "local",
					form: followup,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "low" },
					},
					expect: [
						{
							pointer: "/caseList/rows/0/caseId",
							value: "targeted-chausiku-visit",
						},
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
