// Tests for `bySortKey` — the one order-consumption comparator.

import { describe, expect, it } from "vitest";
import { bySortKey } from "../compare";

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
