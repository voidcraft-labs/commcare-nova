/**
 * The doc-shaped append / sequence helpers over `bySortKey`. (The primitive
 * `keysBetween` / `keysForSlot` between-bounds math is proved in
 * `keys.fuzz.test.ts`, beside the precondition they enforce.)
 */

import { describe, expect, it } from "vitest";
import { appendOrderKey, sequenceOrderKeys, sortedOrderKeys } from "../append";

/** Fractional keys sort lexicographically, so plain string `<` is the order. */
function isStrictlyIncreasing(keys: readonly string[]): boolean {
	return keys.every((k, i) => i === 0 || keys[i - 1] < k);
}

describe("sequenceOrderKeys / appendOrderKey / sortedOrderKeys", () => {
	it("sequenceOrderKeys is a strictly-increasing run from scratch", () => {
		const keys = sequenceOrderKeys(4);
		expect(keys).toHaveLength(4);
		expect(isStrictlyIncreasing(keys)).toBe(true);
	});

	it("appendOrderKey sorts after the LAST key in display order", () => {
		// Array position (b, a) differs from display order (a, b) — append must
		// key after the display-last (b), not the array-last (a).
		const key = appendOrderKey([
			{ order: "b", uuid: "1" },
			{ order: "a", uuid: "2" },
		]);
		expect(key > "b").toBe(true);
	});

	it("sortedOrderKeys returns defined keys in display order, dropping keyless", () => {
		expect(
			sortedOrderKeys([
				{ order: "c", uuid: "1" },
				{ uuid: "2" },
				{ order: "a", uuid: "3" },
			]),
		).toEqual(["a", "c"]);
	});
});
