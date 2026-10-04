/**
 * Defect 12, custom tile, and the tile alignment the Case List save writes.
 *
 * Nova emits `case_tile_template: custom` for any tile layout
 * (`lib/commcare/hqJson/caseList.ts`) and checks it against neither
 * `CASE_LIST_TILE` nor `CASE_LIST_TILE_CUSTOM`
 * (`lib/commcare/projectSpaceCompatibility.ts`), so a project space with
 * `CASE_LIST_TILE` alone is a target Nova publishes to, and a Case List save
 * there drops the custom tile. Under both flags the save keeps the tile and
 * writes HQ's defaults into each cell Nova leaves without an alignment or a
 * size, which HQ's build carries into the suite's `<style>`
 * (`suite_xml/sections/details.py`; the harness's findings, defect 42).
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
		singleFlags: ["CASE_LIST_TILE"],
	});
}
