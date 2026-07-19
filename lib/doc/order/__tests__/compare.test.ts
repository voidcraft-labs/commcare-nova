// Tests for `bySortKey` — the one order-consumption comparator.

import { describe, expect, it } from "vitest";
import { byDetailColumnOrder, byListColumnOrder, bySortKey } from "../compare";

describe("bySortKey", () => {
	it("orders by the fractional `order` key when both are present", () => {
		const items = [
			{ uuid: "c", order: "n" },
			{ uuid: "a", order: "F" },
			{ uuid: "b", order: "V" },
		];
		const sorted = [...items].sort(bySortKey);
		expect(sorted.map((i) => i.uuid)).toEqual(["a", "b", "c"]);
	});

	it("tie-breaks on uuid when order keys collide", () => {
		const items = [
			{ uuid: "z", order: "V" },
			{ uuid: "a", order: "V" },
		];
		const sorted = [...items].sort(bySortKey);
		expect(sorted.map((i) => i.uuid)).toEqual(["a", "z"]);
	});

	it("sorts an entity with an order ahead of one without", () => {
		expect(bySortKey({ uuid: "a", order: "V" }, { uuid: "b" })).toBe(-1);
		expect(bySortKey({ uuid: "a" }, { uuid: "b", order: "V" })).toBe(1);
	});

	it("leaves both-absent entities in array position (stable fallback)", () => {
		// A stable sort preserves input order when the comparator returns 0.
		const items = [{ uuid: "first" }, { uuid: "second" }, { uuid: "third" }];
		expect(bySortKey(items[0], items[1])).toBe(0);
		const sorted = [...items].sort(bySortKey);
		expect(sorted.map((i) => i.uuid)).toEqual(["first", "second", "third"]);
	});

	it("is antisymmetric on the present/absent boundary", () => {
		const a = { uuid: "a", order: "F" };
		const b = { uuid: "b" };
		expect(Math.sign(bySortKey(a, b))).toBe(-Math.sign(bySortKey(b, a)));
	});
});

describe("column surface order comparators", () => {
	it("orders Results and Details independently", () => {
		const columns = [
			{ uuid: "a", order: "a", listOrder: "c", detailOrder: "b" },
			{ uuid: "b", order: "b", listOrder: "a", detailOrder: "c" },
			{ uuid: "c", order: "c", listOrder: "b", detailOrder: "a" },
		];
		expect([...columns].sort(byListColumnOrder).map((c) => c.uuid)).toEqual([
			"b",
			"c",
			"a",
		]);
		expect([...columns].sort(byDetailColumnOrder).map((c) => c.uuid)).toEqual([
			"c",
			"a",
			"b",
		]);
	});

	it("falls back to generic order independently for each missing surface key", () => {
		const columns = [
			{ uuid: "generic-first", order: "a" },
			{ uuid: "surface-second", order: "z", listOrder: "b" },
		];
		expect([...columns].sort(byListColumnOrder).map((c) => c.uuid)).toEqual([
			"generic-first",
			"surface-second",
		]);
		expect([...columns].sort(byDetailColumnOrder).map((c) => c.uuid)).toEqual([
			"generic-first",
			"surface-second",
		]);
	});

	it("is total: equal and absent resolved keys tie-break by uuid", () => {
		const equal = [
			{ uuid: "z", order: "a", listOrder: "x" },
			{ uuid: "a", order: "z", listOrder: "x" },
		];
		expect([...equal].sort(byListColumnOrder).map((c) => c.uuid)).toEqual([
			"a",
			"z",
		]);
		expect(byDetailColumnOrder({ uuid: "z" }, { uuid: "a" })).toBeGreaterThan(
			0,
		);
	});
});
