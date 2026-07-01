// lib/doc/order/append.ts
//
// The shared append / resequence math every "add one" and "reorder the whole
// set" gesture uses. Sequence is DERIVED (`sort-by-(order, uuid)`), so an
// appended item takes a key AFTER the last in DISPLAY order and a wholesale
// reorder assigns a fresh ascending run — divergent copies of this arithmetic
// are themselves an order-key-consistency risk, so it lives in one place.

import { bySortKey } from "./compare";
import { keyBetween, keysBetween } from "./keys";

/** An entity carrying the optional fractional `order` slot + `uuid` tie-break. */
interface Ordered {
	order?: string;
	uuid?: string;
}

/**
 * The existing `order` keys of `items` in DISPLAY order (`sort-by-(order,
 * uuid)`), skipping any keyless entry — the sorted key run an append or a
 * bounds-aware insert reads.
 */
export function sortedOrderKeys<T extends Ordered>(
	items: readonly T[],
): string[] {
	return [...items]
		.sort(bySortKey)
		.map((item) => item.order)
		.filter((o): o is string => o !== undefined);
}

/**
 * The fractional `order` key for an item appended AFTER the last in display
 * order — the append position every single-item add gesture assigns.
 */
export function appendOrderKey<T extends Ordered>(items: readonly T[]): string {
	return keyBetween(sortedOrderKeys(items).at(-1) ?? null, null);
}

/**
 * `count` fresh ascending fractional keys — the full sequence a WHOLESALE
 * reorder (a complete uuid permutation) or a born-from-scratch collection
 * assigns. (`keysBetween` / `keysForSlot` — the between-two-neighbors math —
 * live in `./keys` beside the primitive they enforce the precondition of.)
 */
export function sequenceOrderKeys(count: number): string[] {
	return keysBetween(null, null, count);
}
