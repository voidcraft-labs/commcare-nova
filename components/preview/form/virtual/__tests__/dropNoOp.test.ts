import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import { isNoOpFieldDrop } from "../dropNoOp";

const A = asUuid("a-uuid");
const B = asUuid("b-uuid");
const C = asUuid("c-uuid");

describe("isNoOpFieldDrop", () => {
	// Display order [A, B, C] (matches the array in the un-reordered case).
	const display = [A, B, C];

	it("no-ops a drop before the sibling that already immediately follows", () => {
		// A dropped before B (its current successor) — already there.
		expect(isNoOpFieldDrop(display, A, B, "top")).toBe(true);
	});

	it("no-ops a drop after the sibling that already immediately precedes", () => {
		// B dropped after A (its current predecessor) — already there.
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
		expect(isNoOpFieldDrop(display, asUuid("gone"), B, "top")).toBe(false);
		expect(isNoOpFieldDrop(display, A, asUuid("gone"), "top")).toBe(false);
	});

	/**
	 * The round-4 regression guard: adjacency is DISPLAY order, so after a
	 * same-parent reorder (the membership array untouched, only `order`
	 * changed) the predicate must answer against the display sequence, NOT the
	 * stale array. Each case pairs the display-order answer with the raw-array
	 * answer to show they DIVERGE for the same gesture — feeding the array (the
	 * old bug) would flip the result.
	 */
	const arrayOrder = [A, B, C]; // stale `fieldOrder` membership after reorder
	const displayOrder = [C, B, A]; // sort-by-(order, uuid) after the reorder

	it("no-ops a gesture adjacent in display order but not in the array", () => {
		// Drag A to just-after B. Display [C, B, A]: A already follows B → no-op.
		// Reading the raw array [A, B, C] would say "move" — wrong.
		expect(isNoOpFieldDrop(displayOrder, A, B, "bottom")).toBe(true);
		expect(isNoOpFieldDrop(arrayOrder, A, B, "bottom")).toBe(false);
	});

	it("does NOT suppress a legitimate move that only looks array-adjacent", () => {
		// Drag C to just-after B. Display [C, B, A]: C leads, so this is a real
		// move. The raw array [A, B, C] has C already after B and would SUPPRESS
		// the move — the exact defect the display-order read fixes.
		expect(isNoOpFieldDrop(displayOrder, C, B, "bottom")).toBe(false);
		expect(isNoOpFieldDrop(arrayOrder, C, B, "bottom")).toBe(true);
	});
});
