/**
 * Flipbook parity arithmetic for sectioned forms: which page a row belongs
 * to, and where the edit canvas should start so it opens on the page the
 * preview left active.
 */

import type { VirtualItem } from "@tanstack/react-virtual";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FormRow } from "../rowModel";
import {
	firstRowIndexAtOffset,
	initialEditOffset,
	offsetOfRowIndex,
	sectionHeaderIndex,
	sectionOfRowIndex,
	sectionShownAtRow,
} from "../sectionScroll";

const F = testUuid("form-uuid");
const S1 = testUuid("sec1-uuid");
const S2 = testUuid("sec2-uuid");
const A = testUuid("a-uuid");
const B = testUuid("b-uuid");

const rows: FormRow[] = [
	{ kind: "insertion", id: "i0", parentUuid: F, beforeIndex: 0, depth: 0 },
	{
		kind: "section-header",
		id: "s1",
		uuid: S1,
		parentUuid: F,
		siblingIndex: 0,
		index: 0,
		count: 2,
		depth: 0,
	},
	{
		kind: "field",
		id: "qa",
		uuid: A,
		parentUuid: S1,
		siblingIndex: 0,
		depth: 0,
	},
	{ kind: "insertion", id: "i1", parentUuid: F, beforeIndex: 1, depth: 0 },
	{
		kind: "section-header",
		id: "s2",
		uuid: S2,
		parentUuid: F,
		siblingIndex: 1,
		index: 1,
		count: 2,
		depth: 0,
	},
	{
		kind: "field",
		id: "qb",
		uuid: B,
		parentUuid: S2,
		siblingIndex: 0,
		depth: 0,
	},
];

/** Every row 100px tall: row i starts at 100 * i. */
const measured: VirtualItem[] = rows.map((row, index) => ({
	index,
	key: row.id,
	start: index * 100,
	end: index * 100 + 100,
	size: 100,
	lane: 0,
}));
const estimate = () => 100;

describe("sectionOfRowIndex", () => {
	it("names the nearest heading at or above the row", () => {
		expect(sectionOfRowIndex(rows, 0)).toBeUndefined();
		expect(sectionOfRowIndex(rows, 1)).toBe(S1);
		expect(sectionOfRowIndex(rows, 2)).toBe(S1);
		expect(sectionOfRowIndex(rows, 3)).toBe(S1);
		expect(sectionOfRowIndex(rows, 4)).toBe(S2);
		expect(sectionOfRowIndex(rows, 99)).toBe(S2);
	});
});

describe("sectionShownAtRow", () => {
	it("reads the gap above page one as page one, and stays quiet on a sectionless form", () => {
		expect(sectionShownAtRow(rows, 0)).toBe(S1);
		expect(sectionShownAtRow(rows, 3)).toBe(S1);
		expect(sectionShownAtRow(rows, 4)).toBe(S2);
		const sectionless = rows.filter((row) => row.kind !== "section-header");
		expect(sectionShownAtRow(sectionless, 0)).toBeUndefined();
	});
});

describe("firstRowIndexAtOffset / offsetOfRowIndex", () => {
	it("finds the row under the offset and the offset of a row", () => {
		expect(firstRowIndexAtOffset(measured, 0)).toBe(0);
		expect(firstRowIndexAtOffset(measured, 150)).toBe(1);
		expect(firstRowIndexAtOffset(measured, 9_999)).toBe(5);
		expect(firstRowIndexAtOffset([], 50)).toBe(0);
		expect(offsetOfRowIndex(4, measured, estimate)).toBe(400);
		// Unmeasured rows fall back to the estimate.
		expect(offsetOfRowIndex(4, measured.slice(0, 2), () => 10)).toBe(220);
	});
});

describe("initialEditOffset", () => {
	it("keeps the saved offset when no page is active or the saved view already shows it", () => {
		const saved = { offset: 150, measurements: measured };
		expect(
			initialEditOffset({
				rows,
				saved,
				activeSection: undefined,
				estimateSize: estimate,
			}),
		).toBe(150);
		expect(
			initialEditOffset({
				rows,
				saved,
				activeSection: S1,
				estimateSize: estimate,
			}),
		).toBe(150);
	});

	it("starts at the active page's heading when the saved view shows another page", () => {
		const saved = { offset: 150, measurements: measured };
		expect(
			initialEditOffset({
				rows,
				saved,
				activeSection: S2,
				estimateSize: estimate,
			}),
		).toBe(400);
		// No saved scroll at all: the heading, from estimates.
		expect(
			initialEditOffset({
				rows,
				saved: undefined,
				activeSection: S2,
				estimateSize: estimate,
			}),
		).toBe(400);
	});

	it("ignores an active page the form no longer has", () => {
		expect(
			initialEditOffset({
				rows,
				saved: { offset: 150, measurements: measured },
				activeSection: testUuid("gone"),
				estimateSize: estimate,
			}),
		).toBe(150);
		expect(sectionHeaderIndex(rows, testUuid("gone"))).toBe(-1);
	});
});
