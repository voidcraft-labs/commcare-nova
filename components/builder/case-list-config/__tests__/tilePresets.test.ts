// components/builder/case-list-config/__tests__/tilePresets.test.ts
//
// A preset is a builder gesture that fills placement — nothing about it
// is ever persisted, so what it computes IS the whole contract. These
// pin the arrangements, the point at which each one runs out of room,
// and the born-valid seed the tile switch depends on.

import { describe, expect, it } from "vitest";
import { tileCell } from "@/lib/domain";
import {
	matchingTilePreset,
	seedTileArrangement,
	TILE_MAX_FIELDS,
	TILE_PRESETS,
	tilePresetUnavailableReason,
} from "../tile/tilePresets";

function preset(id: string) {
	const found = TILE_PRESETS.find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`No preset ${id}`);
	return found;
}

describe("stacked lines", () => {
	it("gives every field its own full-width line", () => {
		expect(preset("stacked-lines").arrange(3)).toEqual([
			{ x: 0, y: 0, width: 12, height: 1 },
			{ x: 0, y: 1, width: 12, height: 1 },
			{ x: 0, y: 2, width: 12, height: 1 },
		]);
	});

	it("runs out of room past twelve lines", () => {
		expect(preset("stacked-lines").arrange(12)).not.toBeNull();
		expect(preset("stacked-lines").arrange(13)).toBeNull();
		expect(tilePresetUnavailableReason(preset("stacked-lines"), 13)).toBe(
			"This layout has no room for 13 fields on a 12 by 12 tile.",
		);
	});
});

describe("two columns", () => {
	it("fills left to right, two to a line", () => {
		expect(preset("two-columns").arrange(3)).toEqual([
			{ x: 0, y: 0, width: 6, height: 1 },
			{ x: 6, y: 0, width: 6, height: 1 },
			{ x: 0, y: 1, width: 6, height: 1 },
		]);
	});

	it("needs a second field before it means anything", () => {
		expect(preset("two-columns").arrange(1)).toBeNull();
		expect(tilePresetUnavailableReason(preset("two-columns"), 1)).toBe(
			"This layout needs at least two fields.",
		);
	});
});

describe("title with a side note", () => {
	it("puts the second field beside the first and stacks the rest", () => {
		expect(preset("title-with-side-note").arrange(4)).toEqual([
			{ x: 0, y: 0, width: 8, height: 1 },
			{ x: 8, y: 0, width: 4, height: 1 },
			{ x: 0, y: 1, width: 12, height: 1 },
			{ x: 0, y: 2, width: 12, height: 1 },
		]);
	});

	it("explains itself when there is only one field", () => {
		expect(tilePresetUnavailableReason(preset("title-with-side-note"), 1)).toBe(
			"This layout needs at least two fields.",
		);
	});
});

describe("title over two columns", () => {
	it("spans the first field, then pairs the rest below it", () => {
		expect(preset("title-over-two-columns").arrange(5)).toEqual([
			{ x: 0, y: 0, width: 12, height: 1 },
			{ x: 0, y: 1, width: 6, height: 1 },
			{ x: 6, y: 1, width: 6, height: 1 },
			{ x: 0, y: 2, width: 6, height: 1 },
			{ x: 6, y: 2, width: 6, height: 1 },
		]);
	});

	it("explains itself below three fields", () => {
		expect(
			tilePresetUnavailableReason(preset("title-over-two-columns"), 2),
		).toBe("This layout needs at least three fields.");
	});
});

describe("every preset", () => {
	it("stays inside the grid and never overlaps, at every field count", () => {
		for (const candidate of TILE_PRESETS) {
			for (let count = 1; count <= 30; count++) {
				const arranged = candidate.arrange(count);
				if (arranged === null) continue;
				expect(arranged).toHaveLength(count);
				for (const cell of arranged) {
					expect(cell.x).toBeGreaterThanOrEqual(0);
					expect(cell.y).toBeGreaterThanOrEqual(0);
					expect(cell.x + cell.width).toBeLessThanOrEqual(12);
					expect(cell.y + cell.height).toBeLessThanOrEqual(12);
				}
				for (let a = 0; a < arranged.length; a++) {
					for (let b = a + 1; b < arranged.length; b++) {
						const first = arranged[a];
						const second = arranged[b];
						if (first === undefined || second === undefined) continue;
						const overlaps =
							first.x < second.x + second.width &&
							second.x < first.x + first.width &&
							first.y < second.y + second.height &&
							second.y < first.y + first.height;
						expect(overlaps).toBe(false);
					}
				}
			}
		}
	});

	it("names itself for what a worker sees, never for a CommCare template", () => {
		const labels = TILE_PRESETS.map((candidate) => candidate.label);
		expect(labels).not.toContain("person_simple");
		expect(labels).not.toContain("icon_text_grid");
		expect(labels).toEqual([
			"Stacked lines",
			"Two columns",
			"Title with a side note",
			"Title over two columns",
		]);
	});
});

describe("seedTileArrangement", () => {
	it("keeps one field per line while lines are available", () => {
		expect(seedTileArrangement(4)).toEqual([
			{ x: 0, y: 0, width: 12, height: 1 },
			{ x: 0, y: 1, width: 12, height: 1 },
			{ x: 0, y: 2, width: 12, height: 1 },
			{ x: 0, y: 3, width: 12, height: 1 },
		]);
	});

	it("widens into columns rather than running out of rows", () => {
		const thirteen = seedTileArrangement(13);
		expect(thirteen?.[0]).toEqual({ x: 0, y: 0, width: 6, height: 1 });
		expect(thirteen).toHaveLength(13);
		const thirty = seedTileArrangement(30);
		expect(thirty?.[0]?.width).toBe(4);
	});

	it("lays out a full grid, and only refuses past it", () => {
		expect(seedTileArrangement(TILE_MAX_FIELDS)).toHaveLength(TILE_MAX_FIELDS);
		expect(seedTileArrangement(TILE_MAX_FIELDS + 1)).toBeNull();
		expect(seedTileArrangement(0)).toBeNull();
	});
});

describe("matchingTilePreset", () => {
	it("recognises an untouched preset arrangement", () => {
		expect(
			matchingTilePreset([
				tileCell(0, 0, 12, 1),
				tileCell(0, 1, 12, 1),
				tileCell(0, 2, 12, 1),
			]),
		).toBe("stacked-lines");
	});

	it("ignores presentation, which a preset never sets", () => {
		expect(
			matchingTilePreset([
				tileCell(0, 0, 6, 1, { fontSize: "large" }),
				tileCell(6, 0, 6, 1, { showBorder: true }),
			]),
		).toBe("two-columns");
	});

	it("reports no match once the author has moved something", () => {
		expect(
			matchingTilePreset([tileCell(0, 0, 12, 1), tileCell(0, 4, 12, 1)]),
		).toBeNull();
	});
});
