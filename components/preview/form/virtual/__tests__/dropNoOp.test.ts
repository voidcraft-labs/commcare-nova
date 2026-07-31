import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";

import { isNoOpFieldDrop } from "../dropNoOp";

const A = testUuid("a-uuid");
const B = testUuid("b-uuid");
const C = testUuid("c-uuid");

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
