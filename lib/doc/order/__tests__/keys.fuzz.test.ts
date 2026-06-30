// Fuzz + property tests for the fractional-key primitives.
//
// The load-bearing contracts: `keyBetween` returns a key that sorts STRICTLY
// between its bounds, it NEVER throws (degenerate/equal/inverted/null bounds
// resolve to a place-after key), and a long sequence of insertions keeps the
// list strictly ordered with no renumbering.

import { describe, expect, it } from "vitest";
import { deriveKeyAtIndex, keyBetween } from "../keys";

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

describe("keyBetween — total (never throws)", () => {
	it("never throws and never returns empty across null/empty/equal/inverted bounds", () => {
		const rng = makeRng(0xabcdef);
		const sample = (): string | null => {
			const r = rng();
			if (r < 0.15) return null;
			if (r < 0.25) return "";
			return randomKey(rng);
		};
		for (let i = 0; i < 5000; i++) {
			const a = sample();
			const b = sample();
			let c: string | null = null;
			expect(() => {
				c = keyBetween(a, b);
			}).not.toThrow();
			expect(c).not.toBeNull();
			expect((c as unknown as string).length).toBeGreaterThan(0);
		}
	});

	it("an equal bound resolves to a fresh place-after key (no throw)", () => {
		const c = keyBetween("V", "V");
		expect(c > "V").toBe(true);
	});

	it("an inverted bound (a > b) resolves to a place-after key (no throw)", () => {
		const c = keyBetween("Z", "A");
		expect(c > "Z").toBe(true);
	});

	it("both-null returns a usable base key", () => {
		const c = keyBetween(null, null);
		expect(c.length).toBeGreaterThan(0);
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
