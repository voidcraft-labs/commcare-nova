/**
 * Contract: a custom tile reads back as its cells, its grouping and its persistence; the cells of
 * a list that is no tile, and of a column hidden from Results in a tile list, are dropped, so a
 * Nova-born document that keeps such a cell reads back without it (`dormant-tile-cells`). The
 * failure it catches: a cell read from a list that shows none, or kept on a column the tile does
 * not draw.
 */
import { describe, expect, it } from "vitest";
import { plainColumn, tileCell } from "@/lib/domain/modules";
import { patients, uuid } from "./fixtures";
import { codes, comparableList, listOf, readLists } from "./listReading";

describe("tiles", () => {
	it("reads cells, grouping and persistence", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: {
				...tileCell(0, 0, 6, 1),
				horizontalAlign: "center",
				verticalAlign: "middle",
				fontSize: "large",
				showBorder: true,
			},
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(6, 0, 6, 1),
		});
		const doc = patients([name, notes], {
			list: { tile: { persistOnForms: true } },
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { tile?: unknown }[];
			tile: unknown;
		};
		expect(read.tile).toEqual({ persistOnForms: true });
		expect(read.list.map((column) => column.tile)).toEqual([
			name.tile,
			notes.tile,
		]);
	});

	it("drops the cells of a list that is no tile", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 6, 1),
		});
		const reading = await readLists(patients([name]), {
			edit: (app) => {
				const column = app.modules[0]?.case_details.short.columns[0];
				if (column !== undefined)
					Object.assign(column, { grid_x: 0, grid_y: 0, width: 6, height: 1 });
			},
		});
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { tile?: unknown }[];
			tile: unknown;
		};
		expect(read.tile).toBeUndefined();
		expect(read.list[0]?.tile).toBeUndefined();
	});

	it("drops the cell of a column hidden from Results in a tile list", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			visibleInList: false,
			tile: tileCell(0, 1, 12, 1),
		});
		const reading = await readLists(
			patients([name, notes], { list: { tile: {} } }),
		);
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string; tile?: unknown }[];
		};
		expect(
			read.list.find((column) => column.field === "notes")?.tile,
		).toBeUndefined();
	});

	it("refuses an icon text grid", async () => {
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")]),
			{
				edit: (app) => {
					const short = app.modules[0]?.case_details.short;
					if (short !== undefined) short.case_tile_template = "icon_text_grid";
				},
			},
		);
		expect(codes(reading)).toContain(
			"menus-and-case-lists/detail-case-tile-template-icon-text-grid",
		);
	});
});
