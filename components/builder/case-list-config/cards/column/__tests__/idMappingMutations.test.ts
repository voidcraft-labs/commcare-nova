// State-model coverage for the id-mapping column's variadic-list
// mutations. Pure functions over `IdMappingEntry[]`; tested directly
// against arrays without mounting the card.

import { describe, expect, it } from "vitest";
import { type IdMappingEntry, idMappingEntry } from "@/lib/domain";
import {
	appendMappingEntry,
	moveMappingEntry,
	patchMappingEntry,
	removeMappingEntry,
} from "../idMappingMutations";

const ALPHA: IdMappingEntry = idMappingEntry("a", "Alpha");
const BETA: IdMappingEntry = idMappingEntry("b", "Beta");
const GAMMA: IdMappingEntry = idMappingEntry("c", "Gamma");

describe("appendMappingEntry", () => {
	it("appends a fresh empty entry at the end of an empty list", () => {
		expect(appendMappingEntry([])).toEqual([{ value: "", label: "" }]);
	});

	it("appends a fresh empty entry past existing entries", () => {
		const next = appendMappingEntry([ALPHA, BETA]);
		expect(next).toHaveLength(3);
		expect(next[0]).toBe(ALPHA);
		expect(next[1]).toBe(BETA);
		expect(next[2]).toEqual({ value: "", label: "" });
	});

	it("does not mutate the input list", () => {
		const before: readonly IdMappingEntry[] = [ALPHA];
		appendMappingEntry(before);
		expect(before).toEqual([ALPHA]);
	});
});

describe("removeMappingEntry", () => {
	it("drops the entry at the given index", () => {
		expect(removeMappingEntry([ALPHA, BETA, GAMMA], 1)).toEqual([ALPHA, GAMMA]);
	});

	it("returns an unchanged-shape copy for an out-of-range index", () => {
		// `filter` with a never-matching predicate yields the original
		// content; the caller's contract is to validate index before
		// invocation but the function is defensive.
		expect(removeMappingEntry([ALPHA], 9)).toEqual([ALPHA]);
	});

	it("does not mutate the input list", () => {
		const before: readonly IdMappingEntry[] = [ALPHA, BETA];
		removeMappingEntry(before, 0);
		expect(before).toEqual([ALPHA, BETA]);
	});
});

describe("moveMappingEntry", () => {
	it("swaps an entry forward by one position", () => {
		expect(moveMappingEntry([ALPHA, BETA], 0, 1)).toEqual([BETA, ALPHA]);
	});

	it("swaps an entry backward by one position", () => {
		expect(moveMappingEntry([ALPHA, BETA], 1, 0)).toEqual([BETA, ALPHA]);
	});

	it("moves across multiple positions", () => {
		expect(moveMappingEntry([ALPHA, BETA, GAMMA], 0, 2)).toEqual([
			BETA,
			GAMMA,
			ALPHA,
		]);
	});

	it("returns the input unchanged when the move-target is out of range", () => {
		const input: readonly IdMappingEntry[] = [ALPHA, BETA];
		expect(moveMappingEntry(input, 0, 5)).toBe(input);
		expect(moveMappingEntry(input, 0, -1)).toBe(input);
	});

	it("returns the input unchanged on a self-move", () => {
		const input: readonly IdMappingEntry[] = [ALPHA, BETA];
		expect(moveMappingEntry(input, 1, 1)).toBe(input);
	});

	it("returns the input unchanged when the source is out of range", () => {
		const input: readonly IdMappingEntry[] = [ALPHA, BETA];
		expect(moveMappingEntry(input, 5, 0)).toBe(input);
	});
});

describe("patchMappingEntry", () => {
	it("patches the value of the entry at the given index", () => {
		const next = patchMappingEntry([ALPHA, BETA], 0, { value: "alpha-prime" });
		expect(next).toEqual([{ value: "alpha-prime", label: "Alpha" }, BETA]);
	});

	it("patches the label of the entry at the given index", () => {
		const next = patchMappingEntry([ALPHA, BETA], 1, { label: "Beta-prime" });
		expect(next).toEqual([ALPHA, { value: "b", label: "Beta-prime" }]);
	});

	it("merges both fields of a partial patch", () => {
		const next = patchMappingEntry([ALPHA], 0, {
			value: "x",
			label: "X",
		});
		expect(next).toEqual([{ value: "x", label: "X" }]);
	});

	it("leaves entries at other indices verbatim by reference", () => {
		const next = patchMappingEntry([ALPHA, BETA, GAMMA], 1, { value: "b2" });
		// Entries that weren't patched preserve reference identity so
		// the WeakMap-keyed validity / drag identity stays stable for
		// the unaffected rows.
		expect(next[0]).toBe(ALPHA);
		expect(next[2]).toBe(GAMMA);
	});
});
