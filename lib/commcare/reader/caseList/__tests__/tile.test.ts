/**
 * Contract: a custom tile reads back as its cells, its grouping and its persistence; the cells of
 * a list that is no tile, and of a column hidden from Results in a tile list, are dropped, so a
 * Nova-born document that keeps such a cell reads back without it (`dormant-tile-cells`). The
 * failure it catches: a cell read from a list that shows none, or kept on a column the tile does
 * not draw.
 */

import { describe, expect, it } from "vitest";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { prop, toExpression } from "@/lib/domain/expression";
import {
	type CaseTileLayout,
	NAMED_TILE_SLOTS,
	plainColumn,
	tileCell,
} from "@/lib/domain/modules";
import { patients, uuid } from "./fixtures";
import {
	closedCodes,
	codes,
	comparableList,
	listOf,
	readLists,
} from "./listReading";

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

	it("keeps the selected case's one-line form context through HQ and a second reading", async () => {
		const expression = toExpression(prop("patient", "notes"));
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				list: { contextAboveForm: { kind: "line", expression } },
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(reading.app.modules[0]?.case_details.short).toMatchObject({
			persist_case_context: true,
			persistent_case_context_xml: "notes",
		});
		expect(listOf(reading).contextAboveForm).toEqual({
			kind: "line",
			expression,
		});
	});
	it("distinguishes an orphan, matching and competing definition of a form's one-line context", async () => {
		const columns = [plainColumn(uuid(1), "case_name", "Name")];
		for (const [short, long, conflict] of [
			[undefined, "notes", false],
			["notes", "notes", false],
			["notes", "case_name", true],
		] as const) {
			const read = await readLists(patients(columns), {
				edit(app) {
					const pair = app.modules[0].case_details;
					if (short)
						Object.assign(pair.short, {
							persist_case_context: true,
							persistent_case_context_xml: short,
						});
					Object.assign(pair.long, {
						persist_case_context: true,
						persistent_case_context_xml: long,
					});
				},
			});
			if (conflict) {
				expect(codes(read)).toContain(
					"menus-and-case-lists/two-different-values-for-the-same-form-context",
				);
			} else {
				expect(codes(read)).toEqual([]);
				expect(listOf(read).contextAboveForm).toEqual(
					short
						? { kind: "line", expression: toExpression(prop("patient", short)) }
						: undefined,
				);
			}
		}
	});
	it("reads a pull-down on a persistent tile with its own details", async () => {
		const reading = await readLists(
			patients(
				[
					plainColumn(uuid(1), "case_name", "Name", {
						tile: tileCell(0, 0, 12, 1),
					}),
				],
				{
					list: {
						tile: { persistOnForms: true },
						contextAboveForm: { kind: "own-tile", expandDetails: true },
					},
				},
			),
		);
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading).contextAboveForm).toEqual({
			kind: "own-tile",
			expandDetails: true,
		});
	});
	it("resolves another menu's tile and preserves the enabled line that supplies its fallback", async () => {
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")]),
			{
				edit(app) {
					const owner = structuredClone(app.modules[0]);
					const source = app.modules[0];
					if (!owner || !source)
						throw new Error("Missing context source fixture");
					Object.assign(owner, {
						unique_id: "49d23d0986364a5a8c7efb9d8062641e",
						forms: [],
						name: { en: "Directory" },
						case_type: "patient",
						case_list: { show: true, label: { en: "Directory" } },
					});
					Object.assign(owner.case_details.short, {
						case_tile_template: "custom",
					});
					// HQ's Case List page writes each placed cell's alignment and
					// font size with its coordinates.
					Object.assign(owner.case_details.short.columns[0], {
						grid_x: 0,
						grid_y: 0,
						width: 12,
						height: 1,
						horizontal_align: "left",
						vertical_align: "start",
						font_size: "medium",
					});
					Object.assign(source.case_details.short, {
						persistent_case_tile_from_module: owner.unique_id,
						pull_down_tile: true,
						persist_case_context: true,
						persistent_case_context_xml: "notes",
					});
					app.modules.push(owner);
				},
			},
		);
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading).contextAboveForm).toEqual({
			kind: "menu-tile",
			moduleUuid: reading.ctx.draft.modules[1]?.uuid,
			expandDetails: true,
			expression: toExpression(prop("patient", "notes")),
		});
	});

	it("keeps another menu's tile expanded above the forms as HQ's Case List page keeps it", async () => {
		// HQ's page keeps the pull-down only with this menu's persistence switched on (its save
		// writes the pull-down off otherwise), and its build reads the source menu first, so Nova
		// writes the switch on and reads it back as the source's setting, not this tile persisting.
		const doc = tileFixture("persistent-external");
		const reading = await readLists(doc, { firstPassOnly: false });
		const short = reading.app.modules[0]?.case_details.short;
		expect(short).toMatchObject({
			persist_tile_on_forms: true,
			pull_down_tile: true,
		});
		expect(closedCodes(reading)).toEqual([]);
		const list = listOf(reading);
		expect(list.contextAboveForm).toMatchObject({
			kind: "menu-tile",
			expandDetails: true,
		});
		expect(list.tile?.persistOnForms).toBeUndefined();
	});

	it("reads a records tab's search child type a form of the menu's case type adds", async () => {
		const reading = await readLists(
			tileFixture("conditional-search-children"),
			{
				firstPassOnly: false,
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(
			listOf(reading).detailTabs?.map((tab) => tab.rowSource?.kind),
		).toEqual([undefined, "records"]);
	});

	it("reads a hyphenated grouping with a separate header and body", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(0, 1, 12, 1),
		});
		const doc = patients([name, notes], {
			list: { tile: { grouping: { identifier: "my-parent", headerRows: 1 } } },
		});
		const reading = await readLists(doc, { firstPassOnly: false });
		expect(closedCodes(reading)).toEqual([]);
		expect(
			reading.app.modules[0]?.case_details.short.case_tile_group,
		).toMatchObject({
			index_identifier: "my-parent",
			header_rows: 1,
		});
		expect(listOf(reading).tile?.grouping).toEqual({
			identifier: "my-parent",
			headerRows: 1,
		});
	});

	it("points to the heading when there is no body under a valid connection", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(0, 1, 12, 1),
		});
		const doc = patients([name, notes], {
			list: { tile: { grouping: { identifier: "my-parent", headerRows: 1 } } },
		});
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0].case_details.short;
				short.columns = short.columns.slice(0, 1);
				short.case_tile_group = {
					doc_type: "CaseTileGroupConfig",
					index_identifier: "my-parent",
					header_rows: 2,
				};
			},
		});
		expect(closedCodes(reading)).toEqual([
			"menus-and-case-lists/case-tile-group-header-covers-all-cells",
		]);
		expect(reading.findings).toMatchObject([
			{
				code: "menus-and-case-lists/case-tile-group-header-covers-all-cells",
				place: { kind: "case-list", name: "Patients" },
			},
		]);
	});

	it("refuses an invalid grouping name together with its heading setting", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(0, 1, 12, 1),
		});
		const reading = await readLists(
			patients([name, notes], {
				list: {
					tile: { grouping: { identifier: "my-parent", headerRows: 1 } },
				},
			}),
			{
				edit: (app) => {
					app.modules[0].case_details.short.case_tile_group = {
						doc_type: "CaseTileGroupConfig",
						index_identifier: "-my-parent",
						header_rows: 1,
					};
				},
			},
		);
		expect(closedCodes(reading)).toEqual([
			"menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name",
		]);
	});

	it("keeps a grouped tile body's geometry when the body has a style refusal", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(0, 1, 12, 1),
		});
		const reading = await readLists(
			patients([name, notes], {
				list: {
					tile: { grouping: { identifier: "my-parent", headerRows: 1 } },
				},
			}),
			{
				edit: (app) => {
					app.modules[0].case_details.short.columns[1].font_size = null;
				},
			},
		);
		expect(codes(reading)).toEqual([
			"menus-and-case-lists/custom-tile-font-size-null",
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

	it("refuses cells that cover one square, on Results and on Details, and proposes none of them", async () => {
		// CommCare HQ saves overlapping cells as they are and draws one field over the other;
		// Nova's gate refuses them (`CASE_LIST_TILE_CELLS_OVERLAP`,
		// `CASE_DETAIL_TILE_LAYOUT_INVALID`), so the reading names them instead of proposing them.
		const overlap =
			"menus-and-case-lists/custom-tile-cells-covering-the-same-square";
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(0, 1, 12, 1),
		});
		const apart = await readLists(
			patients([name, notes], {
				list: {
					tile: {},
					detailTile: {
						cells: {
							[name.uuid]: tileCell(0, 0, 6, 1),
							[notes.uuid]: tileCell(6, 0, 6, 1),
						},
					},
				},
			}),
		);
		expect(codes(apart)).toEqual([]);
		for (const detail of ["short", "long"] as const) {
			const reading = await readLists(
				patients([name, notes], {
					list: {
						tile: {},
						detailTile: {
							cells: {
								[name.uuid]: tileCell(0, 0, 6, 1),
								[notes.uuid]: tileCell(6, 0, 6, 1),
							},
						},
					},
				}),
				{
					edit: (app) => {
						const columns = app.modules[0]?.case_details[detail].columns;
						if (columns?.[1] !== undefined)
							Object.assign(columns[1], { grid_x: 3, grid_y: 0, width: 6 });
					},
				},
			);
			expect(codes(reading), detail).toContain(overlap);
			const list = listOf(reading);
			const cells =
				detail === "short"
					? list.columns.map((column) => column.tile)
					: list.columns.map((column) => list.detailTile?.cells[column.uuid]);
			expect(
				cells.filter((cell) => cell !== undefined),
				detail,
			).toEqual([]);
		}
	});

	it("names a cell outside the grid or below the rows HQ's page offers, on Results and on Details, and proposes none of them", async () => {
		// Nova's gate refuses a cell past the grid (`CASE_LIST_TILE_CELL_OUT_OF_GRID`,
		// `CASE_DETAIL_TILE_LAYOUT_INVALID`) and its schema a negative place or an empty span, so
		// the reading names each such cell instead of proposing a document the gate refuses: past
		// the twelfth column, left of the grid or with no span (Android does not draw it), or
		// below the rows HQ's Case List and Case Detail pages offer a screen of two columns, six
		// (their next save moves it: proof 4 over targeted-tile-row-bound).
		const outside = "menus-and-case-lists/custom-tile-cell-outside-the-grid";
		const below =
			"menus-and-case-lists/custom-tile-cell-below-the-rows-hq-s-page-offers";
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 6, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(6, 0, 6, 1),
		});
		const doc = patients([name, notes], {
			list: {
				tile: {},
				detailTile: {
					cells: {
						[name.uuid]: tileCell(0, 0, 6, 1),
						[notes.uuid]: tileCell(6, 0, 6, 1),
					},
				},
			},
		});
		expect(codes(await readLists(doc))).toEqual([]);
		const at12 = await readLists(doc, {
			edit: (app) => {
				for (const detail of ["short", "long"] as const) {
					const columns = app.modules[0]?.case_details[detail].columns;
					if (columns?.[1] !== undefined)
						Object.assign(columns[1], { grid_y: 5, height: 1 });
				}
			},
		});
		expect(codes(at12)).toEqual([]);
		for (const detail of ["short", "long"] as const)
			for (const [cell, entry] of [
				[{ grid_x: 7, width: 6 }, outside],
				[{ grid_x: -1 }, outside],
				[{ width: 0 }, outside],
				[{ grid_y: -1 }, outside],
				[{ grid_y: 6 }, below],
				[{ grid_y: 4, height: 3 }, below],
				[{ grid_y: 12 }, below],
			] as const) {
				const label = `${detail} ${JSON.stringify(cell)}`;
				const reading = await readLists(doc, {
					edit: (app) => {
						const columns = app.modules[0]?.case_details[detail].columns;
						if (columns?.[1] !== undefined) Object.assign(columns[1], cell);
					},
				});
				expect(codes(reading), label).toContain(entry);
				const list = listOf(reading);
				const notesCell =
					detail === "short"
						? list.columns.find((column) => column.uuid === notes.uuid)?.tile
						: list.detailTile?.cells[notes.uuid];
				expect(notesCell, label).toBeUndefined();
			}
	});

	it("holds a tile taller than twelve rows where the screen has a row for each field", async () => {
		// Thirteen fields: HQ's pages offer thirteen rows and keep a cell ending on the
		// thirteenth, and both runtimes size the tile to it.
		const columns = Array.from({ length: 13 }, (_unused, row) =>
			plainColumn(
				uuid(10 + row),
				row % 2 === 0 ? "case_name" : "notes",
				`Line ${row + 1}`,
				{ tile: tileCell(0, row, 12, 1) },
			),
		);
		const doc = patients(columns, {
			list: {
				tile: {},
				detailTile: {
					cells: Object.fromEntries(
						columns.map((column, row) => [
							column.uuid,
							tileCell(0, row, 12, 1),
						]),
					),
				},
			},
		});
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const list = listOf(reading);
		const rows = (cells: readonly ({ y: number } | undefined)[]) =>
			cells.map((cell) => cell?.y).sort((a, b) => (a ?? 0) - (b ?? 0));
		const every = Array.from({ length: 13 }, (_unused, row) => row);
		expect(rows(list.columns.map((column) => column.tile))).toEqual(every);
		expect(rows(Object.values(list.detailTile?.cells ?? {}))).toEqual(every);
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

	it("brings in independent Results and Details tile positions with the same field identities", async () => {
		const name = plainColumn(uuid(1), "case_name", "Name", {
			tile: tileCell(0, 0, 12, 1),
		});
		const notes = plainColumn(uuid(2), "notes", "Notes", {
			tile: tileCell(0, 1, 12, 1),
		});
		const cells = {
			[name.uuid]: tileCell(6, 3, 6, 1),
			[notes.uuid]: tileCell(0, 3, 6, 1),
		};
		const reading = await readLists(
			patients([name, notes], { list: { tile: {}, detailTile: { cells } } }),
		);
		expect(codes(reading)).toEqual([]);
		const list = listOf(reading);
		expect(
			list.columns.map((col) => [col.tile, list.detailTile?.cells[col.uuid]]),
		).toEqual([
			[name.tile, cells[name.uuid]],
			[notes.tile, cells[notes.uuid]],
		]);
	});

	it("reads the ten named tile positions from a shuffled list without inventing custom coordinates", async () => {
		const columns = NAMED_TILE_SLOTS.map((slot, i) =>
			plainColumn(uuid(i + 1), i % 2 ? "notes" : "case_name", slot),
		);
		const slots = Object.fromEntries(
			NAMED_TILE_SLOTS.map((slot, i) => [slot, columns[9 - i].uuid]),
		) as NonNullable<CaseTileLayout["namedSlots"]>;
		const read = await readLists(
			patients(columns, { list: { tile: { namedSlots: slots } } }),
		);
		expect(codes(read)).toEqual([]);
		const result = listOf(read);
		for (const [i, slot] of NAMED_TILE_SLOTS.entries()) {
			const id = result.tile?.namedSlots?.[slot];
			const col = result.columns.find((col) => col.uuid === id);
			expect(col?.header).toBe(NAMED_TILE_SLOTS[9 - i]);
			expect(col?.tile).toBeUndefined();
		}
	});

	it("refuses a named tile with missing positions", async () => {
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
			"menus-and-case-lists/named-case-tile-missing-a-required-slot",
		);
	});
});
