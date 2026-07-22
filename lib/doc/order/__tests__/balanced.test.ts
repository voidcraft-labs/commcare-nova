import { describe, expect, it } from "vitest";
import { balancedKeysBetween, keyBetween } from "../keys";

const CANONICAL_KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

describe("balancedKeysBetween", () => {
	it("returns sorted canonical keys inside bounded and open intervals", () => {
		for (const [lo, hi] of [
			[null, null],
			[null, "m"],
			["A", null],
			["A", "z"],
		] as const) {
			const keys = balancedKeysBetween(lo, hi, 127);
			expect(keys).toHaveLength(127);
			for (let index = 0; index < keys.length; index++) {
				expect(keys[index]).toMatch(CANONICAL_KEY);
				if (lo !== null) expect(keys[index] > lo).toBe(true);
				if (hi !== null) expect(keys[index] < hi).toBe(true);
				if (index > 0) expect(keys[index] > keys[index - 1]).toBe(true);
			}
		}
	});

	it("mints a shallow 5,000-key replacement rather than an append chain", () => {
		const keys = balancedKeysBetween(null, null, 5_000);
		expect(keys).toHaveLength(5_000);
		expect(new Set(keys).size).toBe(5_000);
		expect(Math.max(...keys.map((key) => key.length))).toBeLessThan(16);
		for (let index = 1; index < keys.length; index++) {
			expect(keys[index] > keys[index - 1]).toBe(true);
		}
	});

	it("preserves edge and interval contracts", () => {
		expect(balancedKeysBetween("a", "z", 0)).toEqual([]);
		expect(balancedKeysBetween("a", "z", -1)).toEqual([]);
		expect(() => balancedKeysBetween("a", "z", 1.5)).toThrow(RangeError);
		expect(() => balancedKeysBetween("z", "a", 2)).toThrow(/ordered interval/);
		expect(balancedKeysBetween("a", "z", 1)).toEqual([keyBetween("a", "z")]);
	});
});
