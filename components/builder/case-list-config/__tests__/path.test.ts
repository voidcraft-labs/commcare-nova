// components/builder/case-list-config/__tests__/path.test.ts
//
// Path-encoding round-trips. Mirrors the walker shape in
// `lib/domain/predicate/typeChecker.ts` — the editor's path-build
// helpers must reproduce the walker's emitted paths exactly so the
// validity index lookups land on the right cards.

import { describe, expect, it } from "vitest";
import {
	appendKindIndex,
	appendKindSlot,
	appendSlot,
	appendSlotIndex,
	deserializePath,
	serializePath,
} from "../path";

describe("path helpers — append shapes", () => {
	it("appendSlot pushes a slot name", () => {
		expect(appendSlot([], "left")).toEqual(["left"]);
		expect(appendSlot(["and", 0], "property")).toEqual(["and", 0, "property"]);
	});

	it("appendKindSlot pushes operator-kind + slot", () => {
		expect(appendKindSlot([], "not", "clause")).toEqual(["not", "clause"]);
	});

	it("appendKindIndex pushes operator-kind + array index", () => {
		expect(appendKindIndex([], "and", 1)).toEqual(["and", 1]);
	});

	it("appendSlotIndex pushes slot + array index for leaf operators", () => {
		expect(appendSlotIndex([], "values", 2)).toEqual(["values", 2]);
	});

	it("nested compositions reproduce the walker's path shape", () => {
		// Mirrors the walker's `[...path, "and", 0, "or", 1]`
		// pattern from `lib/domain/predicate/typeChecker.ts`.
		const inAnd = appendKindIndex([], "and", 0);
		const inOr = appendKindIndex(inAnd, "or", 1);
		const inComparison = appendSlot(inOr, "left");
		expect(inComparison).toEqual(["and", 0, "or", 1, "left"]);
	});
});

describe("path serialization — round-trip", () => {
	it("serializes and deserializes empty paths", () => {
		expect(serializePath([])).toBe("");
		expect(deserializePath("")).toEqual([]);
	});

	it("preserves segment types across round-trips", () => {
		const path = ["and", 0, "or", 1, "left"];
		const serialized = serializePath(path);
		expect(deserializePath(serialized)).toEqual(path);
	});

	it("serializes numeric and equal-string segments to the same key", () => {
		// `["values", 0]` and `["values", "0"]` collapse to the same
		// serialized form — `String(0) === "0"` and the join
		// produces identical bytes. This collapse is acceptable
		// because the editor only ever constructs paths with
		// numeric indices in array slots; the string form does not
		// arise in production code, and the validity-index lookup
		// would route an error attached to either to the same card.
		const numeric = serializePath(["values", 0]);
		const stringy = serializePath(["values", "0"]);
		expect(numeric).toBe(stringy);
		// Round-trip prefers the numeric reading.
		expect(deserializePath(numeric)).toEqual(["values", 0]);
	});
});
