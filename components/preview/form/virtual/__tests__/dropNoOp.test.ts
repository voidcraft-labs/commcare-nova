import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";

import { draggedRowSpan, isNoOpFieldDrop } from "../dropNoOp";
import type { FormRow } from "../rowModel";

const A = testUuid("a-uuid");
const B = testUuid("b-uuid");
const C = testUuid("c-uuid");

describe("isNoOpFieldDrop", () => {
	// Display order [A, B, C] (matches the array in the un-reordered case).
	const display = [A, B, C];

	it("no-ops a drop before the sibling that already immediately follows", () => {
		// A dropped before B (its current successor): already there.
		expect(isNoOpFieldDrop(display, A, B, "top")).toBe(true);
	});

	it("no-ops a drop after the sibling that already immediately precedes", () => {
		// B dropped after A (its current predecessor): already there.
		expect(isNoOpFieldDrop(display, B, A, "bottom")).toBe(true);
	});

	it("treats a null edge as bottom (drop-after)", () => {
		expect(isNoOpFieldDrop(display, B, A, null)).toBe(true);
	});

	it("does NOT no-op a genuine non-adjacent move", () => {
		// A dropped before C is a real move across B.
		expect(isNoOpFieldDrop(display, A, C, "top")).toBe(false);
	});

	it("returns false when either field is absent from the sequence", () => {
		expect(isNoOpFieldDrop(display, testUuid("gone"), B, "top")).toBe(false);
		expect(isNoOpFieldDrop(display, A, testUuid("gone"), "top")).toBe(false);
	});

	/**
	 * Adjacency is determined by the supplied membership sequence. Each case
	 * proves the same gesture changes meaning when the sequence changes.
	 */
	const firstOrder = [A, B, C];
	const reordered = [C, B, A];

	it("no-ops a gesture adjacent in the current sequence", () => {
		expect(isNoOpFieldDrop(reordered, A, B, "bottom")).toBe(true);
		expect(isNoOpFieldDrop(firstOrder, A, B, "bottom")).toBe(false);
	});

	it("does not suppress a move that is non-adjacent in the current sequence", () => {
		expect(isNoOpFieldDrop(reordered, C, B, "bottom")).toBe(false);
		expect(isNoOpFieldDrop(firstOrder, C, B, "bottom")).toBe(true);
	});
});

describe("draggedRowSpan", () => {
	const F = testUuid("form-uuid");
	const S1 = testUuid("sec1-uuid");
	const S2 = testUuid("sec2-uuid");
	const G = testUuid("grp-uuid");
	const ins = (parentUuid: typeof F, beforeIndex: number): FormRow => ({
		kind: "insertion",
		id: `ins:${parentUuid}:${beforeIndex}`,
		parentUuid,
		beforeIndex,
		depth: 0,
	});
	const rows: FormRow[] = [
		ins(F, 0),
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
		ins(S1, 0),
		{
			kind: "field",
			id: "qa",
			uuid: A,
			parentUuid: S1,
			siblingIndex: 0,
			depth: 0,
		},
		ins(S1, 1),
		{
			kind: "group-open",
			id: "go",
			uuid: G,
			parentUuid: S1,
			siblingIndex: 1,
			depth: 0,
			collapsed: false,
		},
		ins(G, 0),
		{
			kind: "field",
			id: "qb",
			uuid: B,
			parentUuid: G,
			siblingIndex: 0,
			depth: 1,
		},
		ins(G, 1),
		{ kind: "group-close", id: "gc", uuid: G, depth: 0 },
		ins(S1, 2),
		ins(F, 1),
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
		ins(S2, 0),
		{
			kind: "field",
			id: "qc",
			uuid: C,
			parentUuid: S2,
			siblingIndex: 0,
			depth: 0,
		},
		ins(S2, 1),
		ins(F, 2),
	];

	it("is the one row for a leaf", () => {
		expect(draggedRowSpan(rows, A)).toEqual([3, 3]);
	});

	it("runs from the open to the close bracket for a group", () => {
		expect(draggedRowSpan(rows, G)).toEqual([5, 9]);
	});

	it("runs from the heading to the page's trailing gap for a section", () => {
		// Page one ends just before the root gap that precedes page two.
		expect(draggedRowSpan(rows, S1)).toEqual([1, 10]);
		// The last page ends just before the form's final root gap.
		expect(draggedRowSpan(rows, S2)).toEqual([12, 15]);
	});

	it("is null for a uuid with no row", () => {
		expect(draggedRowSpan(rows, testUuid("nope"))).toBeNull();
	});
});
