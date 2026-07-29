/**
 * Tests for `caseTileLayout`. The rule's two axes are what these cover:
 * geometry runs on every stored cell so a disabled layout can never hide
 * a refusal, while coverage runs only while the layout is on.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type CaseTileLayout,
	type Column,
	plainColumn,
	type TileCell,
	tileCell,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

const OUT_OF_GRID = "CASE_LIST_TILE_CELL_OUT_OF_GRID" as const;
const OVERLAP = "CASE_LIST_TILE_CELLS_OVERLAP" as const;
const NOT_PLACED = "CASE_LIST_TILE_COLUMN_NOT_PLACED" as const;

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
			case_property_on: "patient",
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
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.map((error) => error.code)
		.filter((code) => code.startsWith("CASE_LIST_TILE_"));
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
		).toContain(OUT_OF_GRID);
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
		).toContain(OUT_OF_GRID);
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
		).toContain(OVERLAP);
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
});
