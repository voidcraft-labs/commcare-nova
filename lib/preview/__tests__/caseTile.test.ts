/**
 * The tile's parity rules, asserted where they live: in the pure
 * projection and the pure style plan, not in a rendered DOM. Every
 * expectation here is a statement about what a CommCare client draws,
 * so a change that makes one of these fail is a change that makes Nova's
 * preview disagree with the device.
 */

import { describe, expect, it } from "vitest";
import {
	asUuid,
	calculatedColumn,
	dateColumn,
	plainColumn,
	tileCell,
	type Uuid,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import {
	projectTileGrid,
	TILE_ENTITIES_PER_ROW,
	TILE_USES_UNIFORM_UNITS,
	tileCellGridArea,
	tileGridTemplateColumns,
	tileGridTemplateRows,
} from "../caseTileLayout";
import {
	planTileCell,
	tileGridStyle,
	tileResultsColumns,
} from "../caseTileRendering";

const NAME = asUuid("11111111-1111-4111-8111-111111111111");
const VILLAGE = asUuid("22222222-2222-4222-8222-222222222222");
const VISIT = asUuid("33333333-3333-4333-8333-333333333333");
const PRIORITY = asUuid("44444444-4444-4444-8444-444444444444");

/** One cell of the projection, by the column it draws. */
function cellFor(
	projection: ReturnType<typeof projectTileGrid>,
	uuid: Uuid,
): NonNullable<ReturnType<typeof projectTileGrid>["cells"][number]> {
	const found = projection.cells.find((cell) => cell.columnUuid === uuid);
	if (found === undefined) throw new Error(`no cell for ${uuid}`);
	return found;
}

describe("tile grid geometry", () => {
	it("sizes the grid from the occupied extent, never the 12-column canvas", () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 4, 1),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(4, 0, 2, 1),
			}),
			dateColumn(VISIT, "last_visit", "Last visit", "%d %b %Y", {
				tile: tileCell(0, 1, 6, 1),
			}),
		]);

		expect(projection.columns).toBe(6);
		expect(projection.rows).toBe(2);
		expect(tileGridTemplateColumns(projection.columns)).toBe(
			"repeat(6, minmax(0, 1fr))",
		);
		// Six equal columns filling the width — not six twelfths of it.
		expect(tileGridStyle(projection).gridTemplateColumns).toBe(
			"repeat(6, minmax(0, 1fr))",
		);
	});

	it("shifts zero-based authored coordinates onto one-based grid lines", () => {
		expect(tileCellGridArea(tileCell(0, 0, 1, 1))).toBe("1 / 1 / 2 / 2");
		expect(tileCellGridArea(tileCell(4, 2, 3, 2))).toBe("3 / 5 / 5 / 8");
	});

	it("skips columns with no cell and keeps the caller's order", () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 3, 1),
			}),
			plainColumn(VILLAGE, "village", "Village"),
			plainColumn(PRIORITY, "care_priority", "Priority", {
				tile: tileCell(0, 1, 3, 1),
			}),
		]);
		expect(projection.cells.map((cell) => cell.columnUuid)).toEqual([
			NAME,
			PRIORITY,
		]);
	});

	it("projects an unplaced tile to a zero extent rather than a collapsed grid", () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient"),
		]);
		expect(projection).toEqual({ columns: 0, rows: 0, cells: [] });
	});
});

describe("pinned runtime assumptions", () => {
	it("draws one tile per row with content-sized rows", () => {
		// Nova authors neither `fit-across` nor `uniform-units`, so the
		// renderer pins what the runtime assumes without them. These two
		// values are the whole reason a tile list is a list of rows and not
		// a wrapped gallery of squares.
		expect(TILE_ENTITIES_PER_ROW).toBe(1);
		expect(TILE_USES_UNIFORM_UNITS).toBe(false);
		expect(tileGridTemplateRows(3)).toBe("repeat(3, min-content)");
		expect(tileGridStyle(projectTileGrid([])).gridTemplateRows).toBe(
			"repeat(0, min-content)",
		);
	});

	it("keeps the uniform-units arm meaningful for an imported app that sets it", () => {
		expect(tileGridTemplateRows(2, true, 4)).toBe("repeat(2, 25cqw)");
	});
});

describe("alignment and size resolution", () => {
	it("resolves an absent alignment to start and maps physical words to logical ones", () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 2, 1),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(2, 0, 2, 1, {
					horizontalAlign: "right",
					verticalAlign: "middle",
				}),
			}),
		]);
		expect(cellFor(projection, NAME).horizontalAlign).toBe("start");
		expect(cellFor(projection, NAME).verticalAlign).toBe("start");
		expect(cellFor(projection, VILLAGE).horizontalAlign).toBe("end");
		expect(cellFor(projection, VILLAGE).verticalAlign).toBe("center");
	});

	it("leaves an absent font size absent so the cell inherits", () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 2, 1),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(2, 0, 2, 1, { fontSize: "small" }),
			}),
		]);
		expect(cellFor(projection, NAME).fontSize).toBeUndefined();
		expect(
			planTileCell(cellFor(projection, NAME)).style.fontSize,
		).toBeUndefined();
		expect(planTileCell(cellFor(projection, VILLAGE)).style.fontSize).toBe(
			"small",
		);
	});
});

describe("the tile-wide border / shading switch", () => {
	it("keeps every cell in flow while no cell asks for a box", () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 2, 1, { horizontalAlign: "center" }),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(2, 0, 2, 1),
			}),
		]);
		expect(projection.cells.map((cell) => cell.mode)).toEqual(["flow", "flow"]);
		const plan = planTileCell(cellFor(projection, NAME));
		expect(plan.style.justifySelf).toBe("center");
		expect(plan.style.alignSelf).toBe("start");
		expect(plan.style.textAlign).toBe("center");
		expect(plan.boxed).toBe(false);
		expect(plan.style.margin).toBeUndefined();
	});

	it("boxes the asking cell and insets its plain neighbours", () => {
		const projection = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 2, 1, {
					horizontalAlign: "center",
					showShading: true,
				}),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(2, 0, 2, 1, { horizontalAlign: "right" }),
			}),
			plainColumn(PRIORITY, "care_priority", "Priority", {
				tile: tileCell(0, 1, 4, 1, { showBorder: true }),
			}),
		]);
		expect(cellFor(projection, NAME).mode).toBe("boxed");
		expect(cellFor(projection, VILLAGE).mode).toBe("inset");
		expect(cellFor(projection, PRIORITY).mode).toBe("boxed");

		// A boxed cell stretches across its square and stops positioning
		// itself, but still reads at the alignment its author wrote.
		const boxed = planTileCell(cellFor(projection, NAME));
		expect(boxed.style.justifySelf).toBe("stretch");
		expect(boxed.style.alignSelf).toBeUndefined();
		expect(boxed.style.textAlign).toBe("center");
		expect(boxed.boxed).toBe(true);
		expect(boxed.shaded).toBe(true);
		expect(boxed.bordered).toBe(false);
		expect(boxed.style.padding).toBe("5px 5px 0");
		expect(boxed.style.margin).toBe("2px 4px 5px");
		expect(boxed.style.borderRadius).toBe("8px");

		// A plain neighbour keeps its own alignment and takes the flat
		// margin that lines it up with the boxes.
		const inset = planTileCell(cellFor(projection, VILLAGE));
		expect(inset.style.justifySelf).toBe("end");
		expect(inset.style.alignSelf).toBe("start");
		expect(inset.style.margin).toBe("7px");
		expect(inset.boxed).toBe(false);

		expect(planTileCell(cellFor(projection, PRIORITY)).bordered).toBe(true);
	});

	it("switches on a border asked for anywhere, not per cell", () => {
		const withoutBorder = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 2, 1),
			}),
		]);
		const withBorder = projectTileGrid([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 2, 1),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				tile: tileCell(2, 0, 2, 1, { showBorder: true }),
			}),
		]);
		// One cell's setting changed how a completely different cell sits.
		expect(cellFor(withoutBorder, NAME).mode).toBe("flow");
		expect(cellFor(withBorder, NAME).mode).toBe("inset");
	});
});

describe("the columns a tile carries", () => {
	it("keeps a hidden column that still orders the list, and hides only its value", () => {
		const carried = tileResultsColumns([
			plainColumn(NAME, "case_name", "Patient", {
				tile: tileCell(0, 0, 4, 1),
			}),
			plainColumn(VILLAGE, "village", "Village", {
				visibleInList: false,
				sort: { direction: "asc", priority: 0 },
				tile: tileCell(4, 0, 2, 1),
			}),
			plainColumn(PRIORITY, "care_priority", "Priority", {
				visibleInList: false,
			}),
		]);

		expect(
			carried.map((entry) => [entry.column.uuid, entry.valueHidden]),
		).toEqual([
			[NAME, false],
			[VILLAGE, true],
		]);
		// The carrier holds its square, so the grid is six columns wide —
		// projecting only the visible column would draw four.
		expect(projectTileGrid(carried.map((entry) => entry.column)).columns).toBe(
			6,
		);
	});

	it("carries a calculated column like any other placed column", () => {
		const carried = tileResultsColumns([
			calculatedColumn(VISIT, "Age", term(literal("42")), {
				tile: tileCell(0, 0, 3, 1),
			}),
		]);
		expect(carried).toHaveLength(1);
		expect(carried[0].valueHidden).toBe(false);
	});
});
