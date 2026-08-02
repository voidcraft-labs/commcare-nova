// components/builder/case-list-config/__tests__/tileModel.test.ts
//
// The tile editor's whole authoring contract lives in this model, so
// these pin the STATE TRANSITIONS the surface renders rather than the
// surface. A gesture is a function from a tile plus an intent to either
// a placement or a stated refusal; the canvas only draws the answer.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type CaseListConfig,
	type Column,
	emptyCaseListConfig,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import {
	describeTileCell,
	describeTilePlace,
	firstFreeTilePlacement,
	nextFreeTilePlacement,
	placementForJoiningTile,
	planColumnTilePlacement,
	planTileKeyboardGesture,
	planTileMove,
	planTilePlacement,
	planTileResize,
	tileKeyboardGesture,
	tileLayoutIssues,
	tileMembership,
	tileMemberUuids,
	tileShowsColumn,
} from "../tile/tileModel";

function column(
	id: string,
	header: string,
	slots: Partial<Column> = {},
): Column {
	return {
		...plainColumn(testUuid(id), id, header),
		...slots,
	} as Column;
}

const NAME = column("case_name", "Patient name", {
	tile: tileCell(0, 0, 6, 1),
});
const VILLAGE = column("village", "Village", {
	tile: tileCell(6, 0, 6, 1),
});

/**
 * A case list showing exactly these columns, in the order written.
 *
 * Results order is the config's `listColumnOrder` rather than a per-column
 * slot, so a fixture that wants a particular arrangement writes the columns
 * in that arrangement.
 */
function config(columns: readonly Column[]): CaseListConfig {
	return {
		...emptyCaseListConfig(),
		columns: [...columns],
		listColumnOrder: columns.map((entry) => entry.uuid),
		detailColumnOrder: columns.map((entry) => entry.uuid),
	};
}

function membershipOf(columns: readonly Column[]) {
	return tileMembership(config(columns)).placed;
}

describe("tileShowsColumn", () => {
	it("lays out a Results-visible field", () => {
		expect(tileShowsColumn(column("a", "A"))).toBe(true);
	});

	it("leaves out a hidden field that only sets the default order", () => {
		// It reaches the wire as CommCare's reserved zero-width carrier and
		// draws nothing, so it needs no square.
		expect(
			tileShowsColumn(
				column("a", "A", {
					visibleInList: false,
					sort: { direction: "asc", priority: 1 },
				}),
			),
		).toBe(false);
	});

	it("leaves out a Details-only field", () => {
		expect(tileShowsColumn(column("a", "A", { visibleInList: false }))).toBe(
			false,
		);
	});
});

describe("tileMembership", () => {
	it("splits members by whether they hold a place, in Results order", () => {
		const later = column("later", "Later");
		const { placed, unplaced } = tileMembership(config([NAME, VILLAGE, later]));
		expect(placed.map((entry) => entry.label)).toEqual([
			"Patient name",
			"Village",
		]);
		expect(unplaced.map((entry) => entry.label)).toEqual(["Later"]);
	});

	it("omits a Details-only field even when it holds a stored cell", () => {
		const detailOnly = column("detail", "Detail only", {
			visibleInList: false,
			tile: tileCell(0, 5, 2, 1),
		});
		expect(tileMemberUuids(config([NAME, detailOnly]))).toEqual([NAME.uuid]);
	});
});

describe("describeTileCell", () => {
	it("names a single square without pluralising", () => {
		expect(describeTileCell("Age", tileCell(0, 0, 1, 1))).toBe(
			"Age, column 1, row 1",
		);
	});

	it("names a span with inclusive one-based bounds", () => {
		expect(describeTileCell("Patient name", tileCell(0, 0, 6, 1))).toBe(
			"Patient name, columns 1 to 6, row 1",
		);
		expect(describeTileCell("Photo", tileCell(2, 1, 3, 2))).toBe(
			"Photo, columns 3 to 5, rows 2 to 3",
		);
	});

	it("describes a place without the field's name for the inspector", () => {
		expect(describeTilePlace(tileCell(6, 2, 6, 1))).toBe(
			"columns 7 to 12, row 3",
		);
	});
});

describe("planTilePlacement", () => {
	const placed = membershipOf([NAME, VILLAGE]);

	it("accepts a move into free space and keeps the presentation slots", () => {
		const styled = column("styled", "Styled", {
			tile: tileCell(0, 0, 2, 1, { fontSize: "large", showBorder: true }),
		});
		const verdict = planTilePlacement(
			membershipOf([styled, VILLAGE]),
			styled.uuid,
			{ x: 0, y: 3, width: 2, height: 1 },
		);
		expect(verdict).toEqual({
			ok: true,
			cell: tileCell(0, 3, 2, 1, { fontSize: "large", showBorder: true }),
		});
	});

	it("refuses an overlap and names both fields", () => {
		const verdict = planTilePlacement(placed, NAME.uuid, {
			x: 4,
			y: 0,
			width: 6,
			height: 1,
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toBe(
			"Patient name would sit on top of Village. Two fields can't share a square on a tile: one would be drawn over the other.",
		);
	});

	it("refuses a placement past the right edge and says where it lands", () => {
		const verdict = planTilePlacement(placed, NAME.uuid, {
			x: 8,
			y: 4,
			width: 6,
			height: 1,
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toBe(
			"Patient name would reach column 14, past the right edge. A tile is 12 columns wide, so a field has to end by column 12.",
		);
	});

	it("refuses a placement past the bottom edge", () => {
		const verdict = planTilePlacement(placed, NAME.uuid, {
			x: 0,
			y: 11,
			width: 6,
			height: 3,
		});
		expect(verdict.ok === false && verdict.reason).toBe(
			"Patient name would reach row 14, past the bottom edge. A tile is 12 rows tall, so a field has to end by row 12.",
		);
	});

	it("refuses a placement before the first column", () => {
		const verdict = planTilePlacement(placed, NAME.uuid, {
			x: -1,
			y: 0,
			width: 6,
			height: 1,
		});
		expect(verdict.ok === false && verdict.reason).toBe(
			"Patient name would start before column 1. A tile starts at column 1.",
		);
	});

	it("never compares a field against its own current place", () => {
		const verdict = planTilePlacement(placed, NAME.uuid, {
			x: 0,
			y: 0,
			width: 6,
			height: 2,
		});
		expect(verdict.ok).toBe(true);
	});

	it("ignores a hidden field's stored cell — nothing is drawn there", () => {
		const hidden = column("order", "Registered on", {
			visibleInList: false,
			sort: { direction: "asc", priority: 1 },
			tile: tileCell(6, 0, 6, 1),
		});
		const verdict = planTilePlacement(membershipOf([NAME, hidden]), NAME.uuid, {
			x: 4,
			y: 0,
			width: 6,
			height: 1,
		});
		expect(verdict.ok).toBe(true);
	});
});

describe("planTileMove and planTileResize", () => {
	const placed = membershipOf([NAME, VILLAGE]);

	it("shifts a field by whole squares", () => {
		const verdict = planTileMove(placed, NAME.uuid, 0, 2);
		expect(verdict.ok && verdict.cell).toEqual(tileCell(0, 2, 6, 1));
	});

	it("grows and shrinks at the right and bottom edges", () => {
		const verdict = planTileResize(placed, VILLAGE.uuid, 0, 1);
		expect(verdict.ok && verdict.cell).toEqual(tileCell(6, 0, 6, 2));
	});

	it("refuses to shrink a field below one column", () => {
		const narrow = column("narrow", "Age", {
			tile: tileCell(0, 0, 1, 1),
		});
		const verdict = planTileResize(membershipOf([narrow]), narrow.uuid, -1, 0);
		expect(verdict.ok === false && verdict.reason).toBe(
			"Age has to be at least one column wide.",
		);
	});

	it("refuses to shrink a field below one row", () => {
		const short = column("short", "Age", {
			tile: tileCell(0, 0, 2, 1),
		});
		const verdict = planTileResize(membershipOf([short]), short.uuid, 0, -1);
		expect(verdict.ok === false && verdict.reason).toBe(
			"Age has to be at least one row tall.",
		);
	});
});

describe("tileKeyboardGesture", () => {
	it("moves one square on a bare arrow key", () => {
		expect(tileKeyboardGesture("ArrowLeft", false)).toEqual({
			kind: "move",
			deltaColumns: -1,
			deltaRows: 0,
		});
		expect(tileKeyboardGesture("ArrowDown", false)).toEqual({
			kind: "move",
			deltaColumns: 0,
			deltaRows: 1,
		});
	});

	it("moves the edge the arrow points at when Shift is held", () => {
		expect(tileKeyboardGesture("ArrowRight", true)).toEqual({
			kind: "resize",
			deltaWidth: 1,
			deltaHeight: 0,
		});
		expect(tileKeyboardGesture("ArrowUp", true)).toEqual({
			kind: "resize",
			deltaWidth: 0,
			deltaHeight: -1,
		});
	});

	it("claims no other key, so Tab, Escape, and activation still work", () => {
		for (const key of ["Tab", "Escape", "Enter", " ", "a", "Home", "End"]) {
			expect(tileKeyboardGesture(key, false)).toBeNull();
			expect(tileKeyboardGesture(key, true)).toBeNull();
		}
	});

	it("adjudicates a keyboard gesture through the same refusals a drag uses", () => {
		const placed = membershipOf([NAME, VILLAGE]);
		const gesture = tileKeyboardGesture("ArrowRight", false);
		expect(gesture).not.toBeNull();
		const verdict =
			gesture === null
				? null
				: planTileKeyboardGesture(placed, NAME.uuid, gesture);
		expect(verdict?.ok).toBe(false);
		expect(verdict?.ok === false && verdict.reason).toContain(
			"would sit on top of Village",
		);
	});
});

describe("free space", () => {
	it("finds the first free rectangle scanning across then down", () => {
		expect(firstFreeTilePlacement([tileCell(0, 0, 6, 1)], 6, 1)).toEqual(
			tileCell(6, 0, 6, 1),
		);
	});

	it("reports no room when nothing of that size fits", () => {
		expect(firstFreeTilePlacement([tileCell(0, 0, 12, 12)], 1, 1)).toBeNull();
	});

	it("prefers a full line and narrows until something fits", () => {
		expect(nextFreeTilePlacement([])).toEqual(tileCell(0, 0, 12, 1));
		const full = Array.from({ length: 11 }, (_unused, row) =>
			tileCell(0, row, 12, 1),
		);
		expect(nextFreeTilePlacement([...full, tileCell(0, 11, 8, 1)])).toEqual(
			tileCell(8, 11, 4, 1),
		);
	});
});

describe("placementForJoiningTile", () => {
	it("keeps a saved place that still fits and is still free", () => {
		const hidden = column("hidden", "Age", {
			visibleInList: false,
			tile: tileCell(0, 4, 3, 1),
		});
		expect(
			placementForJoiningTile(config([NAME, VILLAGE, hidden]), hidden),
		).toEqual(tileCell(0, 4, 3, 1));
	});

	it("moves a saved place another field took while it was hidden", () => {
		// The dead end this exists to prevent: hiding a field frees its
		// square, something else lands there, and handing the cell straight
		// back would refuse the author's own reveal at the gate.
		const taken = column("taken", "Age", {
			visibleInList: false,
			tile: tileCell(0, 0, 6, 1),
		});
		const place = placementForJoiningTile(
			config([NAME, VILLAGE, taken]),
			taken,
		);
		expect(place).not.toBeNull();
		if (place === null) return;
		expect(
			planColumnTilePlacement({
				config: config([NAME, VILLAGE, taken]),
				column: taken,
				geometry: place,
			}).ok,
		).toBe(true);
	});

	it("keeps the size the author chose when it moves", () => {
		const taken = column("taken", "Age", {
			visibleInList: false,
			tile: tileCell(0, 0, 3, 2),
		});
		const place = placementForJoiningTile(
			config([NAME, VILLAGE, taken]),
			taken,
		);
		expect(place?.width).toBe(3);
		expect(place?.height).toBe(2);
	});

	it("gives a field with no saved place the first free line", () => {
		const fresh = column("fresh", "Age");
		expect(
			placementForJoiningTile(config([NAME, VILLAGE, fresh]), fresh),
		).toEqual(tileCell(0, 1, 12, 1));
	});

	it("reports no room on a full tile instead of a doomed placement", () => {
		const full = column("full", "Patient name", {
			tile: tileCell(0, 0, 12, 12),
		});
		const joining = column("joining", "Age");
		expect(
			placementForJoiningTile(config([full, joining]), joining),
		).toBeNull();
	});
});

describe("planColumnTilePlacement", () => {
	it("adjudicates a field the grid cannot draw against the tile's members", () => {
		// A Details-only field's cell is inert, so it is not a member, but
		// a typed number still has to land somewhere no member occupies.
		const inert = column("inert", "Notes", {
			visibleInList: false,
			tile: tileCell(0, 6, 2, 1),
		});
		const refused = planColumnTilePlacement({
			config: config([NAME, VILLAGE, inert]),
			column: inert,
			geometry: { x: 0, y: 0, width: 2, height: 1 },
		});
		expect(refused.ok === false && refused.reason).toContain(
			"would sit on top of Patient name",
		);

		const accepted = planColumnTilePlacement({
			config: config([NAME, VILLAGE, inert]),
			column: inert,
			geometry: { x: 0, y: 4, width: 2, height: 1 },
		});
		expect(accepted.ok && accepted.cell).toEqual(tileCell(0, 4, 2, 1));
	});
});

describe("tileLayoutIssues", () => {
	function issues(columns: readonly Column[], tileOn: boolean) {
		return tileLayoutIssues({
			...config(columns),
			...(tileOn ? { tile: {} } : {}),
		});
	}

	it("reports nothing for a complete, well-placed tile", () => {
		expect(issues([NAME, VILLAGE], true)).toEqual([]);
	});

	it("reports geometry whether or not the layout is on", () => {
		// Checking a stored cell continuously is what guarantees that
		// switching the tile back on is always accepted.
		const escaping = column("wide", "Photo", {
			tile: tileCell(8, 0, 6, 1),
		});
		for (const tileOn of [true, false]) {
			const found = issues([escaping], tileOn);
			expect(found.map((issue) => issue.kind)).toEqual(["out-of-grid"]);
			expect(found[0]?.message).toBe(
				"Photo runs past the edge of the tile: it reaches column 14, and a tile is 12 columns by 12 rows. Move it back, or make it smaller.",
			);
		}
	});

	it("names both overflowing axes when a cell escapes in both", () => {
		const escaping = column("both", "Photo", {
			tile: tileCell(10, 10, 5, 5),
		});
		expect(issues([escaping], true)[0]?.message).toContain(
			"it reaches column 15 and row 15",
		);
	});

	it("marks BOTH fields of an overlapping pair", () => {
		const clashing = column("clash", "Village", {
			tile: tileCell(2, 0, 6, 1),
		});
		const found = issues([NAME, clashing], true);
		expect(found.map((issue) => issue.uuid).sort()).toEqual(
			[NAME.uuid, clashing.uuid].sort(),
		);
		expect(new Set(found.map((issue) => issue.message)).size).toBe(1);
	});

	it("reports coverage only while the layout is on", () => {
		const unplaced = column("unplaced", "Age");
		expect(issues([NAME, unplaced], false)).toEqual([]);
		const found = issues([NAME, unplaced], true);
		expect(found.map((issue) => issue.kind)).toEqual(["not-placed"]);
		expect(found[0]?.message).toBe(
			"Age is shown in Results but has no place on the tile. Give it a place, or hide it from Results.",
		);
	});

	it("asks for no place from a hidden field that only sets the order", () => {
		// It reaches the wire as the zero-width carrier and draws nothing.
		const sorter = column("sorter", "Registered on", {
			visibleInList: false,
			sort: { direction: "asc", priority: 1 },
		});
		expect(issues([NAME, sorter], true)).toEqual([]);
	});

	it("leaves a Details-only field alone — its cell renders nowhere", () => {
		const detailOnly = column("detail", "Notes", {
			visibleInList: false,
		});
		expect(issues([NAME, detailOnly], true)).toEqual([]);
	});
});
