/**
 * Tests for `caseTileLayout`. The rule's two axes are what these cover:
 * geometry runs on every stored cell so a disabled layout can never hide
 * a refusal, while coverage runs only while the layout is on.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	type CaseTileLayout,
	type Column,
	NAMED_TILE_SLOTS,
	namedTileSlotsSchema,
	plainColumn,
	type TileCell,
	tileCell,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

const OUT_OF_GRID = "CASE_LIST_TILE_CELL_OUT_OF_GRID" as const;
const OVERLAP = "CASE_LIST_TILE_CELLS_OVERLAP" as const;
const NOT_PLACED = "CASE_LIST_TILE_COLUMN_NOT_PLACED" as const;
const NAMED_SLOT = "CASE_LIST_NAMED_TILE_SLOT_INVALID" as const;

const caseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "town", label: "Town", data_type: "text" as const },
		],
	},
];

const registrationForm = {
	name: "Reg",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
	],
};

function codesFor(
	columns: readonly Column[],
	tile: CaseTileLayout | undefined,
): string[] {
	const doc = buildDoc({
		appName: "T",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [...columns],
					searchInputs: [],
					...(tile !== undefined && { tile }),
				},
				forms: [registrationForm],
			},
		],
		caseTypes,
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
		(error) => error.code,
	);
}

function named(uuid: string, field: string, cell?: TileCell): Column {
	return plainColumn(testUuid(uuid), field, field, cell && { tile: cell });
}

describe("caseTileLayout", () => {
	it("accepts a layout whose cells tile the grid without touching", () => {
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(0, 0, 6, 1)),
					named("b", "town", tileCell(6, 0, 6, 1)),
				],
				{},
			),
		).toEqual([]);
	});

	it("rejects a cell that runs past the right edge", () => {
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(8, 0, 6, 1)),
					named("b", "town", tileCell(0, 0, 6, 1)),
				],
				{},
			),
		).toEqual([OUT_OF_GRID]);
	});

	it("rejects a cell that runs past the bottom edge", () => {
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(0, 10, 6, 4)),
					named("b", "town", tileCell(6, 0, 6, 1)),
				],
				{},
			),
		).toEqual([OUT_OF_GRID]);
	});

	it("holds a cell to the rows CommCare HQ's Case List page keeps: a row for each field, at least six", () => {
		// Proof 4 over targeted-tile-row-bound: the page keeps a bottom edge up
		// to max(fields, 6) and moves a cell past it on its next save.
		const lines = (count: number, last: TileCell) =>
			Array.from({ length: count }, (_unused, row) =>
				named(
					`line-${row}`,
					row === 0 ? "case_name" : "town",
					row === count - 1 ? last : tileCell(0, row, 12, 1),
				),
			);
		expect(codesFor(lines(2, tileCell(0, 5, 12, 1)), {})).toEqual([]);
		expect(codesFor(lines(2, tileCell(0, 4, 12, 3)), {})).toEqual([
			OUT_OF_GRID,
		]);
		expect(codesFor(lines(8, tileCell(0, 7, 12, 1)), {})).toEqual([]);
		expect(codesFor(lines(8, tileCell(0, 8, 12, 1)), {})).toEqual([
			OUT_OF_GRID,
		]);
		// A tile of more than twelve fields is taller than twelve rows.
		expect(codesFor(lines(14, tileCell(0, 13, 12, 1)), {})).toEqual([]);
		// A column hidden from Results is no field of the tile: no row of its own.
		const hidden = plainColumn(testUuid("hidden"), "town", "Town", {
			visibleInList: false,
		});
		expect(codesFor([...lines(7, tileCell(0, 6, 12, 1)), hidden], {})).toEqual(
			[],
		);
		expect(codesFor([...lines(7, tileCell(0, 7, 12, 1)), hidden], {})).toEqual([
			OUT_OF_GRID,
		]);
	});

	it("checks geometry even while the tile layout is off, so switching it back on is always accepted", () => {
		// The cells persist when tiles are turned off — an author who tries a
		// tile and switches back keeps the drawing — so a bad geometry must be
		// refused at the moment it is drawn, not silently stored and refused
		// later when it is switched on.
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(8, 0, 6, 1)),
					named("b", "town", tileCell(0, 0, 6, 1)),
				],
				undefined,
			),
		).toEqual([OUT_OF_GRID]);
	});

	it("rejects two visible cells covering the same square", () => {
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(0, 0, 8, 1)),
					named("b", "town", tileCell(4, 0, 8, 1)),
				],
				{},
			),
		).toEqual([OVERLAP]);
	});

	it("ignores an overlap between cells nothing draws", () => {
		const hidden = (uuid: string, field: string, cell: TileCell): Column =>
			plainColumn(testUuid(uuid), field, field, {
				tile: cell,
				visibleInList: false,
			});
		expect(
			codesFor(
				[
					named("visible", "case_name", tileCell(0, 0, 12, 1)),
					hidden("h1", "town", tileCell(0, 2, 6, 1)),
					hidden("h2", "town", tileCell(3, 2, 6, 1)),
				],
				{},
			),
		).toEqual([]);
	});

	it("requires every field the tile shows to have a place on it", () => {
		expect(
			codesFor(
				[named("a", "case_name", tileCell(0, 0, 6, 1)), named("b", "town")],
				{},
			),
		).toEqual([NOT_PLACED]);
	});

	it("lets a hidden field order the list without giving it a place on the tile", () => {
		// Sorting by something a worker doesn't see is an ordinary case-list
		// pattern, and it works unchanged on a tile: the column emits as the
		// zero-width sort carrier, which is CommCare's own reserved spelling
		// for a carried-but-hidden field, and both tile templates render it
		// inside a `d-none` wrapper.
		const sortCarrier = plainColumn(testUuid("s"), "town", "Town", {
			visibleInList: false,
			sort: { direction: "asc", priority: 0 },
		});
		expect(
			codesFor(
				[named("a", "case_name", tileCell(0, 0, 12, 1)), sortCarrier],
				{},
			),
		).toEqual([]);
	});

	it("leaves a hidden field alone when it orders nothing", () => {
		const inert = plainColumn(testUuid("h"), "town", "Town", {
			visibleInList: false,
		});
		expect(
			codesFor([named("a", "case_name", tileCell(0, 0, 12, 1)), inert], {}),
		).toEqual([]);
	});

	it("says nothing about coverage while the tile layout is off", () => {
		expect(
			codesFor(
				[named("a", "case_name", tileCell(0, 0, 6, 1)), named("b", "town")],
				undefined,
			),
		).toEqual([]);
	});

	it("refuses a named position whose field left Results, which no tile can fill", () => {
		const fields = NAMED_TILE_SLOTS.map((slot) =>
			named(`named-${slot}`, slot === "topLeftText" ? "case_name" : "town"),
		);
		const tile: CaseTileLayout = {
			namedSlots: namedTileSlotsSchema.parse(
				Object.fromEntries(
					NAMED_TILE_SLOTS.map((slot, i) => [slot, fields[i]?.uuid]),
				),
			),
		};
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: { columns: fields, searchInputs: [], tile },
					forms: [registrationForm],
				},
			],
			caseTypes,
		});
		const codes = () =>
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => error.code);
		expect(codes()).not.toContain(NAMED_SLOT);
		// The field of one position is hidden from Results.
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module?.caseListConfig;
		if (!config) throw new Error("The fixture menu has no case list.");
		config.columns = config.columns.map((column, i) =>
			i === 3 ? { ...column, visibleInList: false } : column,
		);
		expect(codes()).toContain(NAMED_SLOT);
	});
});
