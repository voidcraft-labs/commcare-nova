import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	type CaseTileLayout,
	type Column,
	plainColumn,
	TILE_GRID_ROWS,
	type TileCell,
	tileCell,
} from "@/lib/domain";
import { runValidation } from "../../../runner";

const HEADER_ROWS_OUT_OF_RANGE =
	"CASE_LIST_TILE_GROUP_HEADER_ROWS_OUT_OF_RANGE" as const;
const STRADDLES = "CASE_LIST_TILE_GROUP_CELL_STRADDLES_HEADER" as const;
const HEADER_EMPTY = "CASE_LIST_TILE_GROUP_HEADER_EMPTY" as const;

const caseTypes = [
	{
		name: "visit",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "town", label: "Town", data_type: "text" as const },
			{ name: "seen_on", label: "Seen on", data_type: "text" as const },
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
			caseWrite: { caseType: "visit", property: "case_name" },
		}),
	],
};

function codesFor(columns: readonly Column[], tile: CaseTileLayout): string[] {
	const doc = buildDoc({
		appName: "T",
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: { columns: [...columns], searchInputs: [], tile },
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

/** Two header rows over one body row — the shape grouping is for. */
const CLEAN_CUT: Column[] = [
	named("a", "case_name", tileCell(0, 0, 12, 1)),
	named("b", "town", tileCell(0, 1, 12, 1)),
	named("c", "seen_on", tileCell(0, 2, 12, 1)),
];

const grouping = (headerRows: number): CaseTileLayout => ({
	grouping: { identifier: "parent", headerRows },
});

describe("caseTileGrouping", () => {
	it("accepts a header that cuts cleanly above the body rows", () => {
		expect(codesFor(CLEAN_CUT, grouping(2))).toEqual([]);
	});

	it("says nothing at all about a tile that is not grouped", () => {
		expect(codesFor(CLEAN_CUT, {})).toEqual([]);
	});

	it("refuses a header that leaves no body", () => {
		// The tile occupies three rows, so a three-row header is every row.
		expect(codesFor(CLEAN_CUT, grouping(3))).toEqual([
			HEADER_ROWS_OUT_OF_RANGE,
		]);
	});

	it("reports the no-body header alone, not three ways at once", () => {
		// With no body the straddle and empty-header checks would each
		// restate the same problem, so the rule stops after the first.
		const codes = codesFor(CLEAN_CUT, grouping(9));
		expect(codes).toEqual([HEADER_ROWS_OUT_OF_RANGE]);
	});

	it("refuses a cell that crosses the header boundary", () => {
		// A single field spanning rows 0-2 with a two-row header: Web Apps
		// classifies the whole cell as header on its start row and draws it
		// from the group's first case, so every other case's value vanishes.
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(0, 0, 6, 3)),
					named("b", "town", tileCell(6, 0, 6, 1)),
					named("c", "seen_on", tileCell(6, 2, 6, 1)),
				],
				grouping(2),
			),
		).toEqual([STRADDLES]);
	});

	it("accepts a tall cell that stays entirely inside the header", () => {
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(0, 0, 6, 2)),
					named("b", "town", tileCell(6, 0, 6, 2)),
					named("c", "seen_on", tileCell(0, 2, 12, 1)),
				],
				grouping(2),
			),
		).toEqual([]);
	});

	it("accepts a tall cell that stays entirely inside the body", () => {
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(0, 0, 12, 1)),
					named("b", "town", tileCell(0, 1, 6, 3)),
					named("c", "seen_on", tileCell(6, 1, 6, 3)),
				],
				grouping(1),
			),
		).toEqual([]);
	});

	it("refuses a header band no field sits in", () => {
		// Every cell starts at row 1 or below, so the header renders an
		// empty band above every group.
		expect(
			codesFor(
				[
					named("a", "case_name", tileCell(0, 1, 12, 1)),
					named("b", "town", tileCell(0, 2, 12, 1)),
					named("c", "seen_on", tileCell(0, 3, 12, 1)),
				],
				grouping(1),
			),
		).toEqual([HEADER_EMPTY]);
	});

	it("ignores a hidden order-driving column that kept its placement", () => {
		// The zero-width sort carrier emits no `<style>`, so it is not on
		// the tile: it cannot straddle the boundary, and it must not be the
		// thing that keeps the header from being empty either. `tileCellFor`
		// is the one place that decision lives.
		const carrier: Column = {
			...named("b", "town", tileCell(0, 0, 12, 2)),
			visibleInList: false,
			sort: { direction: "asc", priority: 0 },
		};
		expect(
			codesFor(
				[named("a", "case_name", tileCell(0, 1, 12, 1)), carrier],
				grouping(1),
			),
		).toEqual([HEADER_EMPTY]);
	});

	it("admits exactly the independently enumerated horizontal cuts", () => {
		const layouts: readonly (readonly Column[])[] = [
			CLEAN_CUT,
			[
				named("a", "case_name", tileCell(0, 0, 6, 3)),
				named("b", "town", tileCell(6, 0, 6, 1)),
				named("c", "seen_on", tileCell(6, 2, 6, 1)),
			],
			[
				named("a", "case_name", tileCell(0, 1, 12, 1)),
				named("b", "town", tileCell(0, 2, 12, 1)),
				named("c", "seen_on", tileCell(0, 3, 12, 1)),
			],
			[
				named("a", "case_name", tileCell(0, 0, 12, 1)),
				named("b", "town", tileCell(0, 1, 6, 3)),
				named("c", "seen_on", tileCell(6, 1, 6, 3)),
			],
			[named("a", "case_name", tileCell(0, 0, 12, 1))],
		];
		const cuts = [[1, 2], [], [2, 3], [1], []];
		for (const [index, columns] of layouts.entries()) {
			const offered = new Set(cuts[index]);
			for (let headerRows = 1; headerRows <= TILE_GRID_ROWS - 1; headerRows++) {
				const clean = codesFor(columns, grouping(headerRows)).length === 0;
				expect({ headerRows, clean }).toEqual({
					headerRows,
					clean: offered.has(headerRows),
				});
			}
		}
	});
});
