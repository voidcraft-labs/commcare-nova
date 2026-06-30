// lib/doc/order/keys.ts
//
// Total fractional-key primitives. An `order` key is a string over the
// BASE_62 digit alphabet, compared LEXICOGRAPHICALLY, that names an
// entity's absolute position in a sequence — `keyBetween(a, b)` returns a
// key that sorts strictly between two existing keys, so an add/move never
// renumbers its neighbors (the property that lets two editors reorder
// different things and merge by construction).
//
// The alphabet is `0-9A-Za-z` in ascending ASCII order, so lexicographic
// string comparison matches the fractional value `0.<key>` in base 62 —
// `"A5" < "AB"` as strings iff `0.A5 < 0.AB` as fractions. Keys carry no
// integer header (unlike the `fractional-indexing` package): a key is a
// pure fractional part, which keeps the algorithm small and TOTAL.
//
// `keyBetween` NEVER throws. A null/degenerate/equal bound resolves to a
// fresh place-after key rather than an error — the gesture that computes a
// key must always succeed, and the reducer stores whatever it produces
// verbatim.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length; // 62

/** Digit char → value; -1 for a non-digit (never reached for our own keys). */
function val(ch: string): number {
	return DIGITS.indexOf(ch);
}

/**
 * A key strictly greater than `0.tail` with an open upper bound (`< 1`).
 * Appending a single middle (non-zero) digit lands above `0.tail` because
 * of the extra digit, and below `1` because it is still a fractional part.
 * Used for "place after" and as the seed when both bounds are absent.
 */
function placeAfter(tail: string): string {
	return tail + DIGITS[BASE >> 1];
}

/**
 * A key `c` with `0.a < 0.c < 0.b`, where `a` (digits, possibly empty ≡ 0)
 * and `b` (non-empty digits) satisfy `0.a < 0.b`. Walks the shared prefix,
 * then either drops a midpoint digit into a gap of ≥ 2 or, for consecutive
 * digits, takes the lower digit and continues strictly above `a`'s tail —
 * which keeps `c < b` because `c` already diverges below `b` at this
 * position.
 */
function keyBetweenStrict(a: string, b: string): string {
	let prefix = "";
	for (let i = 0; ; i++) {
		const da = i < a.length ? val(a[i]) : 0;
		// `b` is a real, non-empty key and `0.a < 0.b`, so `b` never runs
		// out before `a` diverges below it; the `BASE` guard is defensive.
		const db = i < b.length ? val(b[i]) : BASE;
		if (da === db) {
			prefix += DIGITS[da];
			continue;
		}
		// `da < db` here (the shared prefix was consumed above).
		if (db - da >= 2) {
			return prefix + DIGITS[(da + db) >> 1];
		}
		// Consecutive digits: take the lower one, then any key strictly
		// above `a`'s remaining tail. `c[i] = da < db` already pins `c < b`.
		return prefix + DIGITS[da] + placeAfter(a.slice(i + 1));
	}
}

/**
 * A fractional key that sorts strictly between `a` and `b`.
 *
 * - `a` null ≡ "before everything" (0); `b` null ≡ "after everything" (1).
 * - Both null → a fresh middle key.
 * - A degenerate or inverted bound (`a >= b`, or an empty-string bound)
 *   resolves to a fresh place-after key — `keyBetween` is total and never
 *   throws.
 *
 * The returned key never ends in the zero digit, so a later `keyBetween`
 * against it always has room to bisect.
 */
export function keyBetween(a: string | null, b: string | null): string {
	const lo = a && a.length > 0 ? a : null;
	const hi = b && b.length > 0 ? b : null;
	if (lo !== null && hi !== null && lo >= hi) {
		// Inverted/equal bound — place after the lower bound.
		return placeAfter(lo);
	}
	if (hi === null) {
		// No upper bound: place after `lo` (or seed a base key when null).
		return placeAfter(lo ?? "");
	}
	// `hi` is a real key and `0.(lo ?? "") < 0.hi`.
	return keyBetweenStrict(lo ?? "", hi);
}

/**
 * The key for an item inserted at `index` into a list whose existing keys
 * are `orderedKeys`, given in ASCENDING sorted order. Places the new key
 * between the neighbors on either side of the slot (null past either end).
 * `index` is clamped to `[0, orderedKeys.length]`.
 */
export function deriveKeyAtIndex(orderedKeys: string[], index: number): string {
	const clamped = Math.max(0, Math.min(index, orderedKeys.length));
	const before = clamped > 0 ? orderedKeys[clamped - 1] : null;
	const after = clamped < orderedKeys.length ? orderedKeys[clamped] : null;
	return keyBetween(before, after);
}
