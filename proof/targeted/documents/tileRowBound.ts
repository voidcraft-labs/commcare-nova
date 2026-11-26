/**
 * The rows CommCare HQ's own Case List and Case Detail pages keep of a
 * custom tile's cells.
 *
 * HQ's page offers a cell's start row and height from a select bound to
 * the screen's row maximum, `max(columns + 1, 7)`, where the columns are
 * the screen's own non-filter columns, a long detail's tabs among them
 * (`static/app_manager/js/details/bootstrap5/screen.js`, `caseTileRowMax`
 * and the tab injection before it; `column.js`, `tileRowOptions` and
 * `tileHeightOptions`). So a cell's bottom edge (`grid_y + height`) is on
 * offer up to `max(n, 6)` rows, n the screen's columns. A Knockout `value`
 * bound with `options` and no `valueAllowUnset` rewrites a stored value the
 * options do not hold, and the page's next save writes what it rewrote.
 *
 * Observed first at `9f405aac` (proof 4, `trb-obs2`), when the document
 * also held menus past the bound, by a start row and by a height the page
 * does not offer, on a list of three fields and of eight and on a Details
 * tile of three: each save moved the cell to the first row or made it one
 * row tall, and kept every cell within the bound. Nova's gate now holds a
 * tile to the same rows (`lib/domain/modules.ts::tileRowLimit`), so those
 * menus are no document an editor can make; the refusal is held by the
 * validator's, the reader's and the value-class reader's tests and by the
 * matrix variant `hq-case-lists/tile-cell-below-the-rows-offered`.
 *
 * What stays is what the pages keep, each at its own bound: a list of three
 * fields inside and at six rows, a list of eight at eight rows, a list of
 * fourteen fields whose tile is fourteen rows tall (taller than twelve,
 * `custom-tile-cell-below-the-twelfth-row`), a Details tile whose six
 * fields and two tabs are eight columns of the Case Detail page with a cell
 * on the eighth row, and a Details tile of eleven fields and two tabs with a
 * cell ending on the thirteenth. Proof 4's saves of the Case List and Case
 * Detail pages show each kept.
 *
 * Fixed values: Amina's visit shows her name, her village and her last
 * visit in the first menu's three cells.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseListConfig,
	plainColumn,
	proseText,
	type TileCell,
	tileCell,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-tile-row-bound";
const uuid = (name: string) => targetedUuid(ID, name);

const PROPERTIES = [
	"case_name",
	"village",
	"last_visit",
	"phone",
	"district",
	"risk",
	"status",
	"rank",
	"clinic",
	"household",
	"ward",
	"mother",
	"outcome",
	"followup",
];

/** A line of the full width at `row`, `height` rows tall. */
const line = (row: number, height = 1): TileCell =>
	tileCell(0, row, 12, height);

/** A menu over `visit` whose list or Details tile places one field per cell. */
function menu(
	key: string,
	name: string,
	cells: readonly TileCell[],
	where: "list" | "details",
	tabs?: readonly number[],
) {
	const columns = cells.map((cell, index) =>
		plainColumn(
			uuid(`${key}-column-${index}`),
			PROPERTIES[index],
			PROPERTIES[index],
			where === "list" ? { tile: cell } : {},
		),
	);
	const rest: Partial<Omit<CaseListConfig, "columns">> =
		where === "list"
			? { tile: {} }
			: {
					detailTile: {
						cells: Object.fromEntries(
							columns.map((column, index) => [column.uuid, cells[index]]),
						),
					},
					...(tabs && {
						detailTabs: tabs.map((start, index) => ({
							uuid: uuid(`${key}-tab-${index}`),
							title: `Part ${index + 1}`,
							startColumnUuid: columns[start].uuid,
						})),
					}),
				};
	return {
		uuid: uuid(`${key}-module`),
		name,
		caseType: "visit",
		caseListConfig: caseListOf(columns, rest),
		forms: [
			{
				uuid: uuid(`${key}-followup`),
				name: `Record visit (${name})`,
				type: "followup" as const,
				fields: [
					f({
						kind: "text",
						uuid: uuid(`${key}-notes`),
						id: "notes",
						label: proseText("Notes"),
					}),
				],
			},
		],
	};
}

export function tileRowBound() {
	const doc = buildDoc({
		appId: ID,
		appName: "Tile rows",
		caseTypes: [
			{
				name: "visit",
				properties: PROPERTIES.map((name) => ({
					name,
					label: proseText(name),
					data_type: "text" as const,
				})),
			},
		],
		modules: [
			menu("inside", "Inside", [line(0), line(1), line(2)], "list"),
			menu("at", "At the bound", [line(0), line(3, 2), line(5)], "list"),
			menu(
				"eight",
				"Eight at the bound",
				Array.from({ length: 8 }, (_, row) => line(row)),
				"list",
			),
			menu(
				"fourteen",
				"Taller than twelve",
				Array.from({ length: 14 }, (_, row) => line(row)),
				"list",
			),
			menu(
				"details-tabs",
				"Details tabs",
				[line(0), line(1), line(2), line(3), line(4), line(7)],
				"details",
				[0, 3],
			),
			menu(
				"details-tall",
				"Details taller than twelve",
				[...Array.from({ length: 10 }, (_, row) => line(row)), line(11, 2)],
				"details",
				[0, 5],
			),
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["C4, custom tile rows the Case List and Case Detail pages keep"],
		doc,
		expected: {
			intent: [
				{
					id: "amina-tile",
					export: "local",
					form: uuid("inside-followup"),
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Amina" },
					},
					expect: [
						{
							pointer: "/caseList/rows/0/caseId",
							value: "targeted-tile-rows-amina",
						},
						{ pointer: "/caseList/rows/0/fields/0", value: "Amina" },
						{ pointer: "/caseList/rows/0/fields/1", value: "Riverside" },
						{ pointer: "/caseList/rows/0/fields/2", value: "2026-01-10" },
					],
				},
			],
		},
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: "targeted-tile-rows-amina",
						type: "visit",
						name: "Amina",
						properties: { village: "Riverside", last_visit: "2026-01-10" },
					},
				],
			}),
		},
	});
}
