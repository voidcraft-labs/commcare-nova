// components/builder/case-list-config/__tests__/tileModel.test.ts
//
// The tile editor's whole authoring contract lives in this model, so
// these pin the STATE TRANSITIONS the surface renders rather than the
// surface. A gesture is a function from a tile plus an intent to either
// a placement or a stated refusal; the canvas only draws the answer.

import { describe, expect, it } from "vitest";
import {
	asUuid,
	type Column,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import {
	describeTileCell,
	describeTilePlace,
	firstFreeTilePlacement,
	nextFreeTilePlacement,
	planColumnTilePlacement,
	planTileKeyboardGesture,
	planTileMove,
	planTilePlacement,
	planTileResize,
	tileKeyboardGesture,
	tileLayoutIssues,
	tileMembership,
	tileMemberUuids,
	tileParticipation,
} from "../tile/tileModel";

function column(
	id: string,
	header: string,
	slots: Partial<Column> = {},
): Column {
	return {
		...plainColumn(asUuid(id), id, header),
		...slots,
	} as Column;
}

const NAME = column("name", "Patient name", {
	listOrder: "a",
	tile: tileCell(0, 0, 6, 1),
});
const VILLAGE = column("village", "Village", {
	listOrder: "b",
	tile: tileCell(6, 0, 6, 1),
});

function membershipOf(columns: readonly Column[]) {
	return tileMembership(columns).placed;
}

describe("tileParticipation", () => {
	it("carries a Results-visible field", () => {
		expect(tileParticipation(column("a", "A"))).toBe("shown");
	});

	it("still carries a hidden field that sets the default order", () => {
		// A tile has no off-screen column: the case list must carry the
		// field to sort by it, and the wire emits its grid alongside a
		// zero-width header.
		expect(
			tileParticipation(
				column("a", "A", {
					visibleInList: false,
					sort: { direction: "asc", priority: 1 },
				}),
			),
		).toBe("order-only");
	});

	it("leaves a Details-only field off the tile", () => {
		expect(tileParticipation(column("a", "A", { visibleInList: false }))).toBe(
			null,
		);
	});
});

describe("tileMembership", () => {
	it("splits members by whether they hold a place, in Results order", () => {
		const later = column("later", "Later", { listOrder: "c" });
		const { placed, unplaced } = tileMembership([later, VILLAGE, NAME]);
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
		expect(tileMemberUuids([NAME, detailOnly])).toEqual([NAME.uuid]);
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
			listOrder: "a",
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
			"Patient name would sit on top of Village. Two fields can’t share a square on a tile — one would be drawn over the other.",
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

	it("checks a hidden order-only field's square like any other", () => {
		// The validator's overlap rule skips hidden cells; the editor is
		// deliberately stricter, because both squares are drawn.
		const orderOnly = column("order", "Registered on", {
			listOrder: "b",
			visibleInList: false,
			sort: { direction: "asc", priority: 1 },
			tile: tileCell(6, 0, 6, 1),
		});
		const verdict = planTilePlacement(
			membershipOf([NAME, orderOnly]),
			NAME.uuid,
			{ x: 4, y: 0, width: 6, height: 1 },
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("Registered on");
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
			listOrder: "a",
			tile: tileCell(0, 0, 1, 1),
		});
		const verdict = planTileResize(membershipOf([narrow]), narrow.uuid, -1, 0);
		expect(verdict.ok === false && verdict.reason).toBe(
			"Age has to be at least one column wide.",
		);
	});

	it("refuses to shrink a field below one row", () => {
		const short = column("short", "Age", {
			listOrder: "a",
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

describe("planColumnTilePlacement", () => {
	it("adjudicates a field the grid cannot draw against the tile's members", () => {
		// A Details-only field's cell is inert, so it is not a member — but
		// a typed number still has to land somewhere no member occupies.
		const inert = column("inert", "Notes", {
			visibleInList: false,
			tile: tileCell(0, 6, 2, 1),
		});
		const refused = planColumnTilePlacement({
			columns: [NAME, VILLAGE, inert],
			column: inert,
			geometry: { x: 0, y: 0, width: 2, height: 1 },
		});
		expect(refused.ok === false && refused.reason).toContain(
			"would sit on top of Patient name",
		);

		const accepted = planColumnTilePlacement({
			columns: [NAME, VILLAGE, inert],
			column: inert,
			geometry: { x: 0, y: 4, width: 2, height: 1 },
		});
		expect(accepted.ok && accepted.cell).toEqual(tileCell(0, 4, 2, 1));
	});
});

describe("tileLayoutIssues", () => {
	function issues(columns: readonly Column[], tileOn: boolean) {
		return tileLayoutIssues({
			columns: [...columns],
			searchInputs: [],
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
			listOrder: "a",
			tile: tileCell(8, 0, 6, 1),
		});
		for (const tileOn of [true, false]) {
			const found = issues([escaping], tileOn);
			expect(found.map((issue) => issue.kind)).toEqual(["out-of-grid"]);
			expect(found[0]?.message).toBe(
				"Photo runs past the edge of the tile — it reaches column 14, and a tile is 12 columns by 12 rows. Move it back, or make it smaller.",
			);
		}
	});

	it("names both overflowing axes when a cell escapes in both", () => {
		const escaping = column("both", "Photo", {
			listOrder: "a",
			tile: tileCell(10, 10, 5, 5),
		});
		expect(issues([escaping], true)[0]?.message).toContain(
			"it reaches column 15 and row 15",
		);
	});

	it("marks BOTH fields of an overlapping pair", () => {
		const clashing = column("clash", "Village", {
			listOrder: "b",
			tile: tileCell(2, 0, 6, 1),
		});
		const found = issues([NAME, clashing], true);
		expect(found.map((issue) => issue.uuid).sort()).toEqual(
			[NAME.uuid, clashing.uuid].sort(),
		);
		expect(new Set(found.map((issue) => issue.message)).size).toBe(1);
	});

	it("reports coverage only while the layout is on", () => {
		const unplaced = column("unplaced", "Age", { listOrder: "b" });
		expect(issues([NAME, unplaced], false)).toEqual([]);
		const found = issues([NAME, unplaced], true);
		expect(found.map((issue) => issue.kind)).toEqual(["not-placed"]);
		expect(found[0]?.message).toBe(
			"Age is shown in Results but has no place on the tile. Give it a place, or hide it from Results.",
		);
	});

	it("explains an unplaced order-only field in its own terms", () => {
		const sorter = column("sorter", "Registered on", {
			listOrder: "b",
			visibleInList: false,
			sort: { direction: "asc", priority: 1 },
		});
		const found = issues([NAME, sorter], true);
		expect(found.map((issue) => issue.kind)).toEqual(["order-not-placed"]);
		expect(found[0]?.message).toContain("A tile can’t hide a field");
	});

	it("leaves a Details-only field alone — its cell renders nowhere", () => {
		const detailOnly = column("detail", "Notes", {
			listOrder: "b",
			visibleInList: false,
		});
		expect(issues([NAME, detailOnly], true)).toEqual([]);
	});
});
