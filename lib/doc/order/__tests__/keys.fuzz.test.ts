// Fuzz + property tests for the fractional-key primitives.
//
// The load-bearing contracts: `keyBetween` returns a key that sorts STRICTLY
// between its bounds and requires an ORDERED interval (`lo < hi`, null ≡ ±∞) —
// it THROWS on a degenerate one (`lo >= hi`, both non-null), the empty open
// interval that has no key. `keysForSlot` is the collision-safe slot layer:
// it widens past a run of equal-keyed siblings to a distinct bound so the
// interval it hands `keysBetween` is never degenerate. A long sequence of
// insertions keeps the list strictly ordered with no renumbering.

import { describe, expect, it } from "vitest";
import {
	deriveKeyAtIndex,
	keyBetween,
	keysBetween,
	keysForSlot,
} from "../keys";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Deterministic LCG so a failure is reproducible. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * A random non-empty key over the digit alphabet, with a NON-ZERO last digit
 * — the same no-trailing-zero invariant `keyBetween`'s own output holds. (A
 * trailing zero makes a key fraction-equal to its zero-stripped prefix, e.g.
 * `0.A0 === 0.A`, so no key sorts strictly between such an adjacent pair —
 * a degeneracy real keys never exhibit.)
 */
function randomKey(rng: () => number, maxLen = 6): string {
	const len = 1 + Math.floor(rng() * maxLen);
	let out = "";
	for (let i = 0; i < len - 1; i++) {
		out += DIGITS[Math.floor(rng() * DIGITS.length)];
	}
	out += DIGITS[1 + Math.floor(rng() * (DIGITS.length - 1))];
	return out;
}

describe("keyBetween — strictly between ordered bounds", () => {
	it("returns a key strictly between a < b across many random pairs", () => {
		const rng = makeRng(0xc0ffee);
		for (let i = 0; i < 5000; i++) {
			const x = randomKey(rng);
			const y = randomKey(rng);
			if (x === y) continue;
			const [a, b] = x < y ? [x, y] : [y, x];
			const c = keyBetween(a, b);
			expect(c.length).toBeGreaterThan(0);
			expect(a < c).toBe(true);
			expect(c < b).toBe(true);
		}
	});

	it("places strictly before a key when the lower bound is null", () => {
		const rng = makeRng(0x1234);
		for (let i = 0; i < 2000; i++) {
			const b = randomKey(rng);
			const c = keyBetween(null, b);
			expect(c.length).toBeGreaterThan(0);
			expect(c < b).toBe(true);
		}
	});

	it("places strictly after a key when the upper bound is null", () => {
		const rng = makeRng(0x5678);
		for (let i = 0; i < 2000; i++) {
			const a = randomKey(rng);
			const c = keyBetween(a, null);
			expect(a < c).toBe(true);
		}
	});
});

describe("keyBetween — ordered-interval precondition", () => {
	it("throws on a degenerate non-null interval (equal or inverted bounds)", () => {
		expect(() => keyBetween("V", "V")).toThrow();
		expect(() => keyBetween("Z", "A")).toThrow();
	});

	it("treats a null / empty bound as ±∞ and never throws", () => {
		const rng = makeRng(0xabcdef);
		for (let i = 0; i < 2000; i++) {
			const key = randomKey(rng);
			// At least one bound is an edge (null or empty ≡ ±∞), so the
			// interval is never degenerate.
			expect(() => keyBetween(null, key)).not.toThrow();
			expect(() => keyBetween(key, null)).not.toThrow();
			expect(() => keyBetween("", key)).not.toThrow();
			expect(() => keyBetween(key, "")).not.toThrow();
		}
		expect(() => keyBetween(null, null)).not.toThrow();
		expect(() => keyBetween("", "")).not.toThrow();
	});

	it("throws EXACTLY when both bounds are real and lo >= hi", () => {
		const rng = makeRng(0x13579);
		for (let i = 0; i < 3000; i++) {
			const a = randomKey(rng);
			const b = randomKey(rng);
			if (a >= b) {
				expect(() => keyBetween(a, b)).toThrow();
			} else {
				expect(keyBetween(a, b) > a).toBe(true);
			}
		}
	});
});

describe("keysBetween", () => {
	it("returns `count` strictly-increasing keys inside the open interval", () => {
		const keys = keysBetween("a", "z", 5);
		expect(keys).toHaveLength(5);
		for (let i = 0; i < keys.length; i++) {
			expect(keys[i] > "a").toBe(true);
			expect(keys[i] < "z").toBe(true);
			if (i > 0) expect(keys[i] > keys[i - 1]).toBe(true);
		}
	});

	it("null bounds append / prepend without throwing", () => {
		for (const k of keysBetween(null, "m", 3)) expect(k < "m").toBe(true);
		for (const k of keysBetween("m", null, 3)) expect(k > "m").toBe(true);
	});

	it("inherits the ordered-interval precondition (throws on degenerate)", () => {
		expect(() => keysBetween("V", "V", 2)).toThrow();
	});

	it("is empty for a non-positive count", () => {
		expect(keysBetween("a", "z", 0)).toEqual([]);
	});
});

describe("keysForSlot — collision-safe slot", () => {
	it("mints between the slot's neighbors when they're distinct", () => {
		const [k] = keysForSlot(["a", "c"], 1, 1);
		expect(k > "a").toBe(true);
		expect(k < "c").toBe(true);
	});

	it("widens past a tied run so a collision yields a NON-degenerate interval", () => {
		// Three siblings share key "V"; inserting at a slot inside the run
		// lands AFTER the whole run and before the next distinct key.
		const [k] = keysForSlot(["V", "V", "V", "z"], 2, 1);
		expect(k > "V").toBe(true);
		expect(k < "z").toBe(true);
	});

	it("a tie reaching the list end appends cleanly (widened hi ≡ null)", () => {
		const [k] = keysForSlot(["V", "V", "V"], 1, 1);
		expect(k > "V").toBe(true);
	});

	it("a MULTI-key insert at a collision stays strictly increasing in the widened interval", () => {
		const keys = keysForSlot(["V", "V", "z"], 1, 3);
		expect(keys).toHaveLength(3);
		for (const k of keys) {
			expect(k > "V").toBe(true);
			expect(k < "z").toBe(true);
		}
		for (let i = 1; i < keys.length; i++) {
			expect(keys[i] > keys[i - 1]).toBe(true);
		}
	});

	it("edge slots prepend / append", () => {
		expect(keysForSlot(["m"], 0, 1)[0] < "m").toBe(true);
		expect(keysForSlot(["m"], 1, 1)[0] > "m").toBe(true);
	});
});

describe("deriveKeyAtIndex / insertion sequences", () => {
	it("keeps the list strictly ascending and every key strictly between its neighbors", () => {
		const rng = makeRng(0x9e3779b9);
		const keys: string[] = [];
		for (let step = 0; step < 2000; step++) {
			const index = Math.floor(rng() * (keys.length + 1));
			const key = deriveKeyAtIndex(keys, index);
			const before = index > 0 ? keys[index - 1] : null;
			const after = index < keys.length ? keys[index] : null;
			if (before !== null) expect(before < key).toBe(true);
			if (after !== null) expect(key < after).toBe(true);
			keys.splice(index, 0, key);
		}
		// The whole list is strictly ascending after every insertion landed.
		for (let i = 1; i < keys.length; i++) {
			expect(keys[i - 1] < keys[i]).toBe(true);
		}
	});

	it("clamps an out-of-range index to the ends", () => {
		const keys = ["V", "n"];
		const past = deriveKeyAtIndex(keys, 99);
		expect(past > "n").toBe(true);
		const before = deriveKeyAtIndex(keys, -5);
		expect(before < "V").toBe(true);
	});
});

describe("foreign trailing-zero keys (numeric-equality semantics)", () => {
	// Nova never mints a key ending in the zero digit, but every `order` slot
	// is a wire-open string — these shapes arrive via MCP / crafted PUTs and
	// must not mint keys OUTSIDE the requested interval.
	it("keyBetween treats a zero-key upper bound as the fraction 0 (degenerate)", () => {
		// A zero upper bound gets its own message — the defect is the bound, not
		// an inverted interval, and a null lo has nothing wrong with it.
		expect(() => keyBetween(null, "0")).toThrow(/numerically ZERO/);
		expect(() => keyBetween(null, "00")).toThrow(/numerically ZERO/);
		expect(() => keyBetween("0", "00")).toThrow(/numerically ZERO/);
	});

	it("keyBetween normalizes a trailing-zero lower bound and stays inside the raw interval", () => {
		const k = keyBetween("A0", "B");
		expect(k > "A0").toBe(true);
		expect(k < "B").toBe(true);
		const k2 = keyBetween("0", "1");
		expect(k2 > "0").toBe(true);
		expect(k2 < "1").toBe(true);
	});

	it("keysForSlot widens past a NUMERIC tie (zero-key floor and zero-extension twins)", () => {
		// Drag-to-first against a foreign "0": nothing sorts strictly below the
		// fraction 0, so the slot widens past the zero run — the mint lands
		// after it and before the first distinct key, never outside.
		const [first] = keysForSlot(["0", "5"], 0, 1);
		expect(first > "0").toBe(true);
		expect(first < "5").toBe(true);
		// "A" and "A0" are the same fraction — the slot between them widens.
		const [mid] = keysForSlot(["A", "A0", "B"], 1, 1);
		expect(mid > "A0").toBe(true);
		expect(mid < "B").toBe(true);
	});
});
