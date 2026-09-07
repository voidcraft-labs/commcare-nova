import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";

import { draggedRowSpan } from "../dropNoOp";
import type { FormRow } from "../rowModel";

const A = testUuid("a-uuid");
const B = testUuid("b-uuid");
const C = testUuid("c-uuid");

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
